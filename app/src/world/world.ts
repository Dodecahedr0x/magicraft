// World session glue: chunk store → mesher workers → renderer, the chunk auto-creator, sky /
// day-night (sky.ts), torch lights (torches.ts), mobs (mobs.ts), the
// debug fly camera (toggled with F in debug mode; the player controller drives the camera
// and the focus otherwise), and the in-game chunk panel (auto-create toggle, cost, toasts).
import { LAMPORTS_PER_SOL, type PublicKey } from "@solana/web3.js";
import {
  breakBlockIx,
  CHUNK_TOTAL_RENT,
  chunkKey,
  createAndGrowIxs,
  FP,
  growChunkIx,
  placeBlockIx,
  populateChunkIx,
  pstatePda,
  type PlayerStateAccount,
  type SendResult,
  type WorldAccount,
} from "../chain";
import type { App } from "../state";
import { h, sendResultMessage, sol } from "../ui/dom";
import { openTopUp } from "../ui/hud";
import { atlasCanvas } from "./atlas";
import { AutoCreator, DEFAULT_CAP_LAMPORTS, type AutoEvent } from "./autocreate";
import { isFluid } from "./blocks";
import { FlyCam } from "./flycam";
import { MeshPool } from "./meshpool";
import { MobLayer } from "./mobs";
import { TORCH_QUALITIES, TORCH_RADIUS, WorldRenderer, type TorchQuality } from "./renderer";
import { Sky } from "./sky";
import { ChunkStore } from "./store";
import { flickerPhase, TorchIndex } from "./torches";

export const LOAD_RADIUS = 4;
export const CREATE_RADIUS = 2;
export const EYE = 1.62;
const AUTO_KEY = "magicraft.autoCreate";
const CAP_KEY = "magicraft.autoCreate.capSol";
const TORCH_KEY = "magicraft.torchLights";
/** Stored torch quality, else 8 (4 on touch / coarse-pointer devices). */
function torchQuality(stored: string | null): TorchQuality {
  const v = Number(stored);
  if (stored !== null && (TORCH_QUALITIES as readonly number[]).includes(v)) return v as TorchQuality;
  let coarse = false;
  try {
    coarse = matchMedia("(pointer: coarse)").matches;
  } catch {
    /* no matchMedia */
  }
  return coarse ? 4 : 8;
}
const consentKey = (world: PublicKey) => `magicraft.autoCreate.consent.${world.toBase58()}`;

export type WorldHandle = {
  store: ChunkStore;
  renderer: WorldRenderer;
  auto: AutoCreator;
  /** Day / night (its `source` is switched to the live World + chain clock by the game). */
  sky: Sky;
  mobs: MobLayer;
  torches: TorchIndex;
  /** The free-fly debug camera exists (debug mode: dev build or `?debug`). */
  readonly debugCam: boolean;
  /** The debug camera is active (it then drives the camera and the focus). */
  readonly flying: boolean;
  /** Switches the debug camera on / off (no-op outside debug mode); returns the state. */
  setFly(on: boolean): boolean;
  /** Moves the load / auto-create focus to world position (x, y, z) (block units). The
   *  player controller calls it every frame; the debug camera while flying. */
  setFocus(x: number, y: number, z: number): void;
  /** Runs `cb(dt seconds)` before each render; returns an unsubscribe. */
  onFrame(cb: (dt: number) => void): () => void;
  /** Called with every PlayerState update (own chunk for auto-create; first camera spot). */
  onPlayerState(s: PlayerStateAccount): void;
  toast(msg: string, kind?: "info" | "warn"): void;
  /** The chunk panel + toasts (append into the game screen). */
  ui: HTMLElement;
  stop(): void;
};

const store_ = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

/** Debug mode: dev builds, or `?debug` in the URL. */
export const isDebug = () => !import.meta.env.PROD || new URLSearchParams(location.search).has("debug");

export function startWorld(app: App, canvas: HTMLCanvasElement, world: PublicKey, account: WorldAccount, onFirstMesh: () => void): WorldHandle {
  const viewBlocks = LOAD_RADIUS * 16 + 8;
  const renderer = new WorldRenderer(canvas, { viewBlocks });
  renderer.setTorchQuality(torchQuality(store_.get(TORCH_KEY)));
  const pool = new MeshPool();
  const debugCam = isDebug();
  const cam = debugCam ? new FlyCam(renderer.camera, canvas) : null;
  let flying = false;
  if (cam) cam.enabled = false;
  const frameCbs = new Set<(dt: number) => void>();
  let firstMesh = false;

  const store: ChunkStore = new ChunkStore({
    conn: app.conns.er,
    programId: app.cfg.programId,
    world,
    radius: LOAD_RADIUS,
    onDirty: (keys) => {
      torches.invalidate(keys);
      for (const key of keys)
        pool.request(key, () => store.meshInput(key), (mesh) => {
          const e = store.entry(key);
          if (!mesh || !e?.blocks) return renderer.removeChunk(key);
          renderer.setChunk(key, e.cx, e.cz, mesh);
          if (!firstMesh) {
            firstMesh = true;
            onFirstMesh();
          }
        });
    },
    onChange: () => queueTick(),
  });

  const torches = new TorchIndex(store);
  const sky = new Sky(renderer, { world: () => account, now: () => null });
  const feet: [number, number, number] = [0, 0, 0];
  const mobs = new MobLayer(renderer, {
    store,
    tickMs: account.params.mobTickMs,
    player: () => {
      const p = renderer.camera.position;
      feet[0] = p.x;
      feet[1] = p.y - EYE;
      feet[2] = p.z;
      return feet;
    },
  });
  const torchBuf = Array.from({ length: 16 }, () => [0, 0, 0, 0]);

  // ------------------------------------------------------------ auto-create

  const send = async (src: Parameters<NonNullable<App["state"]["sender"]>["send"]>[0], opts: Parameters<NonNullable<App["state"]["sender"]>["send"]>[1]): Promise<SendResult> => {
    const s = app.state.sender;
    if (!s) return { status: "failed", error: { kind: "renewSession", message: "No play session." } };
    return s.send(src, opts);
  };
  const capSol = Number(store_.get(CAP_KEY));
  const auto = new AutoCreator({
    store,
    view: store,
    send,
    radius: CREATE_RADIUS,
    concurrency: 2,
    capLamports: capSol > 0 ? Math.round(capSol * LAMPORTS_PER_SOL) : DEFAULT_CAP_LAMPORTS,
    consented: store_.get(consentKey(world)) === "yes",
    ixs: {
      createAndGrow: (cx, cz, view, own) => {
        const auth = app.auth();
        return createAndGrowIxs(app.program, auth, world, cx, cz, view, own ? pstatePda(app.cfg.programId, world, auth.player) : null);
      },
      grow: async (cx, cz, payer) => [await growChunkIx(app.program, payer, world, cx, cz)],
      populate: async (cx, cz) => [await populateChunkIx(app.program, world, cx, cz)],
    },
    onEvent: (e) => onAuto(e),
  });
  auto.paused = store_.get(AUTO_KEY) === "off";
  let tickQueued = false;
  function queueTick() {
    if (tickQueued) return;
    tickQueued = true;
    queueMicrotask(() => {
      tickQueued = false;
      auto.tick();
      renderPanel();
    });
  }

  // ------------------------------------------------------------ panel + toasts

  const toggle = h("input", { type: "checkbox", id: "auto-create", checked: !auto.paused });
  const capInput = h("input", {
    id: "auto-cap",
    class: "input small",
    type: "number",
    min: "0.001",
    step: "0.005",
    inputmode: "decimal",
    value: String(+(auto.capLamports / LAMPORTS_PER_SOL).toFixed(6)),
  });
  const torchSel = h(
    "select",
    { id: "torch-lights", class: "input small" },
    ...TORCH_QUALITIES.map((q) => h("option", { value: String(q), selected: q === renderer.torchQuality }, q ? `${q}` : "Off")),
  );
  const status = h("p", { class: "chunk-status", role: "status" });
  const totals = h("p", { class: "chunk-totals" });
  const askBox = h("div", { class: "chunk-halt", hidden: true });
  const toasts = h("div", { class: "toasts", "aria-live": "polite" });
  const panel = h(
    "div",
    { class: "chunk-panel" },
    h("label", { class: "check", for: "auto-create" }, toggle, h("span", {}, "Auto-generate nearby chunks")),
    h("p", { class: "hint" }, `≈ ${sol(CHUNK_TOTAL_RENT, 6)} SOL rent each, paid by your player. Radius ${CREATE_RADIUS}.`),
    h("label", { class: "cap", for: "auto-cap" }, h("span", {}, "Spend cap this session"), capInput, h("span", { class: "muted" }, "SOL")),
    h("label", { class: "cap", for: "torch-lights" }, h("span", {}, "Torch lights"), torchSel),
    status,
    totals,
    askBox,
  );
  const help = h(
    "p",
    { class: "fly-help" },
    "Click to capture the mouse (Esc releases) · WASD move · Space jump / swim · Shift sprint · Left mine / attack · Right place / eat · 1–9 or wheel hotbar · E inventory" +
      (cam ? " · F debug fly camera" : ""),
  );
  const ui = h("div", { class: "world-ui" }, panel, help, toasts);

  toggle.addEventListener("change", () => {
    store_.set(AUTO_KEY, toggle.checked ? "on" : "off");
    auto.setPaused(!toggle.checked);
  });
  torchSel.addEventListener("change", () => {
    const q = Number(torchSel.value) as TorchQuality;
    store_.set(TORCH_KEY, String(q));
    renderer.setTorchQuality(q);
  });
  capInput.addEventListener("change", () => {
    const v = Number(capInput.value);
    if (!(v > 0)) {
      capInput.value = String(+(auto.capLamports / LAMPORTS_PER_SOL).toFixed(6));
      return;
    }
    store_.set(CAP_KEY, String(v));
    auto.setCap(Math.round(v * LAMPORTS_PER_SOL));
  });

  function toast(msg: string, kind: "info" | "warn" = "info") {
    const t = h("div", { class: `toast ${kind}` }, msg);
    toasts.append(t);
    while (toasts.children.length > 4) toasts.firstElementChild!.remove();
    setTimeout(() => t.classList.add("out"), 4200);
    setTimeout(() => t.remove(), 4600);
  }

  // Creations are toasted in batches: one toast per burst ("N chunks created · X SOL").
  let batch = { n: 0, lamports: 0 };
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  const flushBatch = () => {
    batchTimer = null;
    if (!batch.n) return;
    const { n, lamports } = batch;
    batch = { n: 0, lamports: 0 };
    toast(`${n} chunk${n === 1 ? "" : "s"} created · ${sol(lamports, 6)} SOL · session total ${sol(auto.spentLamports, 6)} SOL`);
  };

  const label = (key: string) => `(${key.replace(",", ", ")})`;
  let asked: string | null = null;
  function renderPanel() {
    const inflight = [...auto.inflight.entries()].map(([k, s]) => `${s === "populate" ? "populating" : s === "grow" ? "growing" : "creating"} ${label(k)}`);
    const pending = auto.pending();
    const plural = (n: number) => `${n} chunk${n === 1 ? "" : "s"}`;
    status.textContent = auto.halted
      ? "Paused: needs your attention."
      : auto.paused
        ? pending
          ? `Paused · ${plural(pending)} nearby not generated.`
          : "Paused."
        : inflight.length
          ? `Generating: ${inflight.join(", ")}…`
          : auto.waiting
            ? "Waiting for your go-ahead."
            : pending
              ? `${plural(pending)} nearby can't be generated from here yet.`
              : "All nearby chunks generated.";
    totals.textContent = auto.created ? `${plural(auto.created)} created this session · ${sol(auto.spentLamports, 6)} SOL` : "";
    // The prompt: a halt (top-up / session) wins over a spending question.
    const want = auto.halted ? `halt:${auto.halted}` : !auto.paused && auto.waiting ? `ask:${auto.waiting}` : null;
    if (want === asked) return;
    asked = want;
    askBox.hidden = !want;
    if (!want) return askBox.replaceChildren();
    const btn = (label: string, onclick: () => void, ghost = false) => h("button", { class: `btn small${ghost ? " ghost" : ""}`, type: "button", onclick }, label);
    if (want === "ask:consent") {
      askBox.replaceChildren(
        h("p", {}, `Missing chunks around you can be generated now. Each costs ≈ ${sol(CHUNK_TOTAL_RENT, 6)} SOL of rent from your player, up to your cap of ${sol(auto.capLamports, 6)} SOL this session.`),
        h(
          "div",
          { class: "actions" },
          btn("Generate chunks", () => {
            store_.set(consentKey(world), "yes");
            auto.consent();
          }),
          btn("Not now", () => {
            toggle.checked = false;
            store_.set(AUTO_KEY, "off");
            auto.setPaused(true);
          }, true),
        ),
      );
    } else if (want === "ask:cap") {
      askBox.replaceChildren(
        h("p", {}, `Reached your spend cap: ${sol(auto.spentLamports, 6)} SOL on ${plural(auto.created)} this session. Continue?`),
        h("div", { class: "actions" }, btn(`Continue (+${sol(DEFAULT_CAP_LAMPORTS, 6)} SOL)`, () => {
          auto.raiseCap();
          capInput.value = String(+(auto.capLamports / LAMPORTS_PER_SOL).toFixed(6));
        })),
      );
    } else {
      const msg =
        auto.halted === "topup"
          ? "Your player is out of SOL for chunk rent. Top it up, then resume."
          : (haltMsg ?? "Your play session needs renewing.");
      askBox.replaceChildren(
        h("p", { class: "form-error" }, msg),
        h("div", { class: "actions" }, auto.halted === "topup" ? btn("Top up", () => openTopUp(app)) : null, btn("Resume", () => auto.resume(), true)),
      );
    }
  }

  let haltMsg: string | null = null;
  function onAuto(e: AutoEvent) {
    if (e.type === "created") {
      batch.n++;
      batch.lamports += e.lamports;
      if (batchTimer !== null) clearTimeout(batchTimer);
      batchTimer = setTimeout(flushBatch, 1500);
    } else if (e.type === "failed" && e.failure.kind !== "topup" && e.failure.kind !== "renewSession") {
      console.warn(`chunk ${e.key} ${e.step} failed`, e.failure);
      if (e.failure.kind !== "notReady") toast(`Chunk ${label(e.key)}: ${e.step} failed (${e.failure.name ?? e.failure.kind}); retrying later.`, "warn");
    } else if (e.type === "halted") {
      flushBatch();
      haltMsg = e.reason === "session" ? sendResultMessage({ status: "failed", error: e.failure }) : null;
      toast(e.reason === "topup" ? "Out of SOL for chunk rent: auto-generation paused." : "Play session expired: auto-generation paused.", "warn");
    }
    renderPanel();
  }

  // ------------------------------------------------------------ camera + focus

  let focus = "";
  function setFocus(x: number, _y: number, z: number) {
    const [cx, cz] = [Math.floor(x / 16), Math.floor(z / 16)];
    const k = chunkKey(cx, cz);
    if (k === focus) return;
    focus = k;
    void store.setCenter(cx, cz).then(() => queueTick());
    pool.prune((key) => !!store.entry(key));
    auto.setFocus(cx, cz);
    renderPanel();
  }

  let placed = false;
  const eyeAt = (x: number, y: number, z: number) => {
    if (cam) cam.setPosition(x, y + EYE, z);
    else {
      renderer.camera.position.set(x, y + EYE, z);
      renderer.camera.rotation.set(-0.35, 0, 0, "YXZ");
    }
  };
  const placeAt = (s: PlayerStateAccount) => {
    const [x, y, z] = s.move.pos.map((v) => v / FP);
    eyeAt(x, y, z);
    placed = true;
  };
  if (app.state.playerState) placeAt(app.state.playerState);
  else {
    const [x, y, z] = account.spawn;
    eyeAt(x + 0.5, y, z + 0.5);
  }
  {
    const p = renderer.camera.position;
    setFocus(p.x, p.y - EYE, p.z);
  }

  const onFrame = (dt: number) => {
    if (cam && flying) {
      cam.update(dt);
      const p = renderer.camera.position;
      setFocus(p.x, p.y - EYE, p.z);
    }
    for (const cb of frameCbs) cb(dt);
    // After the camera moved: sky (sun / moon follow the camera), torches, mobs.
    const c = renderer.camera.position;
    const b = store.getBlock(Math.floor(c.x), Math.floor(c.y), Math.floor(c.z));
    sky.underwater = b !== null && isFluid(b);
    sky.update(dt);
    const t = performance.now() / 1000;
    const lit = torches.pick([c.x, c.y, c.z], renderer.torchQuality, viewBlocks + TORCH_RADIUS);
    for (let i = 0; i < lit.length; i++) {
      const p = lit[i];
      const ph = flickerPhase(p);
      const o = torchBuf[i];
      o[0] = p[0] + 0.5;
      o[1] = p[1] + 0.75;
      o[2] = p[2] + 0.5;
      o[3] = 0.9 + 0.1 * Math.sin(t * 9 + ph) * Math.sin(t * 5.3 + ph * 1.7);
    }
    renderer.setTorches(torchBuf, lit.length);
    mobs.update(dt);
  };
  const setFly = (on: boolean) => {
    if (!cam) return false;
    flying = on;
    cam.enabled = on;
    if (on) {
      // Start from the current view.
      const r = renderer.camera.rotation;
      cam.yaw = r.y;
      cam.pitch = r.x;
      cam.setPosition(renderer.camera.position.x, renderer.camera.position.y, renderer.camera.position.z);
    }
    return flying;
  };
  renderer.start(onFrame);
  auto.start();
  renderPanel();

  // ------------------------------------------------------------ debug handle

  const sendEdit = async (build: () => Promise<import("@solana/web3.js").TransactionInstruction>) => {
    const s = app.state.sender;
    if (!s) throw new Error("no session");
    const r = await s.send(async () => [await build()]);
    return r.status === "confirmed" ? r : (sendResultMessage(r) ?? r.status);
  };
  const debug = {
    store,
    renderer,
    auto,
    pool,
    sky,
    mobs,
    torches,
    /** Localnet builds only: `debug_spawn_mob` (kind 1 pig, 2 cow, 3 sheep, 4 zombie; 0
     *  clears the chunk) at block (x, y, z) — feet at the block's bottom center. */
    spawnMob: (kind: number, x: number, y: number, z: number) =>
      sendEdit(() => {
        const [cx, cz] = [Math.floor(x / 16), Math.floor(z / 16)];
        const pos: [number, number, number] = [Math.round((x + 0.5) * FP), Math.round(y * FP), Math.round((z + 0.5) * FP)];
        return app.program.methods.debugSpawnMob(kind, pos).accountsPartial({ world, chunk: store.get(cx, cz)!.pda }).instruction();
      }),
    stats: () => ({ ...renderer.stats(), mobs: mobs.count, boxes: mobs.batch.size, torchesLit: renderer.light.uTorchCount.value, torches: torches.count, timeOfDay: sky.shown === null ? null : Math.round(sky.shown), day: sky.state.day, meshMsAvg: avg(pool.times), meshMsMax: Math.max(0, ...pool.times), meshes: pool.times.length, backlog: pool.backlog, loaded: store.size, heapMB: heapMB() }),
    atlas: () => {
      const c = atlasCanvas(4);
      Object.assign(c.style, { position: "fixed", right: "8px", top: "8px", zIndex: "99", border: "2px solid #000", imageRendering: "pixelated" });
      c.onclick = () => c.remove();
      document.body.append(c);
      return c;
    },
    /** World block under the player's feet (the PlayerState), for quick edits. */
    feet: () => {
      const s = app.state.playerState;
      return s ? (s.move.pos.map((v) => Math.floor(v / FP)) as [number, number, number]) : null;
    },
    breakBlock: (x: number, y: number, z: number) => sendEdit(() => breakBlockIx(app.program, app.auth(), world, [x, y, z], store)),
    placeBlock: (x: number, y: number, z: number, slot: number) => sendEdit(() => placeBlockIx(app.program, app.auth(), world, [x, y, z], slot, store)),
    cam,
    setFocus,
    setFly,
    goto: (x: number, y: number, z: number, yaw = cam?.yaw ?? 0, pitch = cam?.pitch ?? 0) => {
      if (!cam) return renderer.camera.position.set(x, y, z);
      cam.yaw = yaw;
      cam.pitch = pitch;
      cam.setPosition(x, y, z);
    },
  };
  const g = globalThis as { __magicraft?: Record<string, unknown> };
  if (!import.meta.env.PROD && g.__magicraft) g.__magicraft.world = debug;

  return {
    store,
    renderer,
    auto,
    sky,
    mobs,
    torches,
    ui,
    debugCam,
    get flying() {
      return flying;
    },
    setFly,
    setFocus,
    onFrame(cb) {
      frameCbs.add(cb);
      return () => frameCbs.delete(cb);
    },
    toast,
    onPlayerState(s) {
      auto.setOwn(Math.floor(s.move.pos[0] / (16 * FP)), Math.floor(s.move.pos[2] / (16 * FP)));
      if (!placed) {
        placeAt(s);
        setFocus(s.move.pos[0] / FP, s.move.pos[1] / FP, s.move.pos[2] / FP);
      }
    },
    stop() {
      if (batchTimer !== null) clearTimeout(batchTimer);
      frameCbs.clear();
      auto.dispose();
      store.dispose();
      pool.dispose();
      cam?.dispose();
      mobs.dispose();
      sky.dispose();
      renderer.dispose();
      if (g.__magicraft) delete g.__magicraft.world;
    },
  };
}

const avg = (a: number[]) => (a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2) : 0);
const heapMB = () => {
  const m = (performance as { memory?: { usedJSHeapSize: number } }).memory;
  return m ? Math.round(m.usedJSHeapSize / 1048576) : null;
};
