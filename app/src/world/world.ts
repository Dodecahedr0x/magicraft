// World session glue: chunk store → mesher workers → renderer, the chunk auto-creator, the
// debug fly camera, and the in-game chunk panel (auto-create toggle, cost, toasts).
import type { PublicKey } from "@solana/web3.js";
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
import { AutoCreator, type AutoEvent } from "./autocreate";
import { FlyCam } from "./flycam";
import { MeshPool } from "./meshpool";
import { WorldRenderer } from "./renderer";
import { ChunkStore } from "./store";

export const LOAD_RADIUS = 4;
export const CREATE_RADIUS = 3;
export const EYE = 1.62;
const AUTO_KEY = "magicraft.autoCreate";

export type WorldHandle = {
  store: ChunkStore;
  renderer: WorldRenderer;
  auto: AutoCreator;
  /** Called with every PlayerState update (sets the player's own chunk). */
  onPlayerState(s: PlayerStateAccount): void;
  /** The chunk panel + toasts (append into the game screen). */
  ui: HTMLElement;
  stop(): void;
};

const readPref = () => {
  try {
    return localStorage.getItem(AUTO_KEY) !== "off";
  } catch {
    return true;
  }
};
const writePref = (on: boolean) => {
  try {
    localStorage.setItem(AUTO_KEY, on ? "on" : "off");
  } catch {
    /* private mode */
  }
};

export function startWorld(app: App, canvas: HTMLCanvasElement, world: PublicKey, account: WorldAccount, onFirstMesh: () => void): WorldHandle {
  const renderer = new WorldRenderer(canvas, { viewBlocks: LOAD_RADIUS * 16 + 8 });
  const pool = new MeshPool();
  const cam = new FlyCam(renderer.camera, canvas);
  let firstMesh = false;

  const store: ChunkStore = new ChunkStore({
    conn: app.conns.er,
    programId: app.cfg.programId,
    world,
    radius: LOAD_RADIUS,
    onDirty: (keys) => {
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

  // ------------------------------------------------------------ auto-create

  const send = async (src: Parameters<NonNullable<App["state"]["sender"]>["send"]>[0], opts: Parameters<NonNullable<App["state"]["sender"]>["send"]>[1]): Promise<SendResult> => {
    const s = app.state.sender;
    if (!s) return { status: "failed", error: { kind: "renewSession", message: "No play session." } };
    return s.send(src, opts);
  };
  const auto = new AutoCreator({
    store,
    view: store,
    send,
    radius: CREATE_RADIUS,
    concurrency: 2,
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
  auto.paused = !readPref();
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
  const status = h("p", { class: "chunk-status", role: "status" });
  const totals = h("p", { class: "chunk-totals" });
  const haltBox = h("div", { class: "chunk-halt", hidden: true });
  const toasts = h("div", { class: "toasts", "aria-live": "polite" });
  const panel = h(
    "div",
    { class: "chunk-panel" },
    h("label", { class: "check", for: "auto-create" }, toggle, h("span", {}, "Auto-generate nearby chunks")),
    h("p", { class: "hint" }, `≈ ${sol(CHUNK_TOTAL_RENT, 6)} SOL rent each, paid by your player. Radius ${CREATE_RADIUS}.`),
    status,
    totals,
    haltBox,
  );
  const help = h("p", { class: "fly-help" }, "Drag to look · WASD move · Space / Shift up / down · Ctrl faster");
  const ui = h("div", { class: "world-ui" }, panel, help, toasts);

  toggle.addEventListener("change", () => {
    writePref(toggle.checked);
    auto.setPaused(!toggle.checked);
    renderPanel();
  });

  function toast(msg: string, kind: "info" | "warn" = "info") {
    const t = h("div", { class: `toast ${kind}` }, msg);
    toasts.append(t);
    while (toasts.children.length > 4) toasts.firstElementChild!.remove();
    setTimeout(() => t.classList.add("out"), 4200);
    setTimeout(() => t.remove(), 4600);
  }

  const label = (key: string) => `(${key.replace(",", ", ")})`;
  function renderPanel() {
    const inflight = [...auto.inflight.entries()].map(([k, s]) => `${s === "populate" ? "populating" : s === "grow" ? "growing" : "creating"} ${label(k)}`);
    const pending = auto.pending();
    status.textContent = auto.halted
      ? "Paused: needs your attention."
      : auto.paused
        ? pending
          ? `Paused · ${pending} chunk${pending === 1 ? "" : "s"} nearby not generated.`
          : "Paused."
        : inflight.length
          ? `Generating: ${inflight.join(", ")}…`
          : pending
            ? `${pending} chunk${pending === 1 ? "" : "s"} nearby can't be generated from here yet.`
            : "All nearby chunks generated.";
    totals.textContent = auto.created ? `${auto.created} chunk${auto.created === 1 ? "" : "s"} created this session · ${sol(auto.spentLamports, 6)} SOL` : "";
    haltBox.hidden = !auto.halted;
  }

  function onAuto(e: AutoEvent) {
    if (e.type === "created") {
      toast(`Chunk ${label(e.key)} created · ${sol(e.lamports, 6)} SOL rent · session total ${sol(auto.spentLamports, 6)} SOL`);
    } else if (e.type === "failed" && e.failure.kind !== "topup" && e.failure.kind !== "renewSession") {
      console.warn(`chunk ${e.key} ${e.step} failed`, e.failure);
      if (e.failure.kind !== "notReady") toast(`Chunk ${label(e.key)}: ${e.step} failed (${e.failure.name ?? e.failure.kind}); retrying later.`, "warn");
    } else if (e.type === "halted") {
      const msg =
        e.reason === "topup"
          ? "Your player is out of SOL for chunk rent. Top it up, then resume."
          : (sendResultMessage({ status: "failed", error: e.failure }) ?? "Your play session needs renewing.");
      haltBox.replaceChildren(
        h("p", { class: "form-error" }, msg),
        h(
          "div",
          { class: "actions" },
          e.reason === "topup" ? h("button", { class: "btn small", type: "button", onclick: () => openTopUp(app) }, "Top up") : null,
          h("button", { class: "btn ghost small", type: "button", onclick: () => auto.resume() }, "Resume"),
        ),
      );
      toast(msg, "warn");
    }
    renderPanel();
  }

  // ------------------------------------------------------------ camera + focus

  let placed = false;
  const placeAt = (s: PlayerStateAccount) => {
    const [x, y, z] = s.move.pos.map((v) => v / FP);
    cam.setPosition(x, y + EYE, z);
    placed = true;
  };
  if (app.state.playerState) placeAt(app.state.playerState);
  else {
    const [x, y, z] = account.spawn;
    cam.setPosition(x + 0.5, y + EYE, z + 0.5);
  }

  let focus = "";
  const onFrame = (dt: number) => {
    cam.update(dt);
    const p = renderer.camera.position;
    const [cx, cz] = [Math.floor(p.x / 16), Math.floor(p.z / 16)];
    const k = chunkKey(cx, cz);
    if (k !== focus) {
      focus = k;
      void store.setCenter(cx, cz).then(() => queueTick());
      pool.prune((key) => !!store.entry(key));
      auto.setFocus(cx, cz);
      renderPanel();
    }
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
    stats: () => ({ ...renderer.stats(), meshMsAvg: avg(pool.times), meshMsMax: Math.max(0, ...pool.times), meshes: pool.times.length, backlog: pool.backlog, loaded: store.size, heapMB: heapMB() }),
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
    goto: (x: number, y: number, z: number, yaw = cam.yaw, pitch = cam.pitch) => {
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
    ui,
    onPlayerState(s) {
      auto.setOwn(Math.floor(s.move.pos[0] / (16 * FP)), Math.floor(s.move.pos[2] / (16 * FP)));
      if (!placed) placeAt(s);
    },
    stop() {
      auto.dispose();
      store.dispose();
      pool.dispose();
      cam.dispose();
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
