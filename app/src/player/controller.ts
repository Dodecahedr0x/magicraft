// Player controller: pointer-lock FPS camera + keyboard → client physics (physics.ts) →
// camera at eye height, world focus (chunk loading / auto-create) and the move sync
// (sync.ts), which records every frame and sends ~8 Hz `move_player` updates.
//
// Controls: click the canvas to capture the mouse (Esc releases; without pointer lock,
// drag to look), WASD / arrows move, Space jump / swim up, Shift sprint (Ctrl is a browser
// shortcut), C does nothing yet (no sneaking). Debug mode (dev build or `?debug`): F
// toggles the free-fly camera (the player then stands still) and `__magicraft.player`
// drives input programmatically (`input({ forward: true }, 2000)`, `look(yaw, pitch)`,
// `stats()`), for automation where pointer lock is unavailable.
import { SYSVAR_CLOCK_PUBKEY, type PublicKey } from "@solana/web3.js";
import type { PerspectiveCamera } from "three";
import { decodeWorld, moveIx, pstatePda, scheduleDayCrankIx, type V3, type WorldAccount } from "../chain";
import type { TxFailure } from "../chain/sender";
import type { App } from "../state";
import { blockFlags } from "../wasm";
import type { WorldHandle } from "../world/world";
import { EYE, FP, MAX_CATCHUP_S, NO_INPUT, PlayerPhysics, sampleOf, type Input, type PhysParams, type World } from "./physics";
import { ChainClock, encodeParams, MoveSync, type ChainReading } from "./sync";

const SENS = 0.0025;
const PITCH_MAX = 1.55;

const KEYS: Record<string, keyof Input> = {
  KeyW: "forward",
  ArrowUp: "forward",
  KeyS: "back",
  ArrowDown: "back",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
  Space: "jump",
  ShiftLeft: "sprint",
  ShiftRight: "sprint",
};

export type ControllerOptions = {
  canvas: HTMLCanvasElement;
  camera: PerspectiveCamera;
  world: World;
  params: PhysParams;
  /** Debug fly-camera toggle (F); returns the new state. */
  toggleFly?: () => boolean;
  isFlying?: () => boolean;
};

export class PlayerController {
  phys: PlayerPhysics | null = null;
  yaw = 0;
  pitch = -0.2;
  /** Input disabled (dead, not joined). */
  frozen = false;
  /** Movement input disabled while a UI panel (inventory) is open. */
  blocked = false;
  readonly keys = new Set<keyof Input>();
  private override: { input: Partial<Input>; until: number } | null = null;
  private drag: { x: number; y: number } | null = null;
  private off: (() => void)[] = [];
  locked = false;
  private skipMove = false;

  constructor(readonly o: ControllerOptions) {
    const on = <K extends keyof DocumentEventMap>(t: EventTarget, type: K, f: (e: DocumentEventMap[K]) => void) => {
      t.addEventListener(type, f as EventListener);
      this.off.push(() => t.removeEventListener(type, f as EventListener));
    };
    const typing = (e: Event) => e.target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable);
    const canvas = o.canvas;
    on(window, "keydown", (e) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "KeyF" && o.toggleFly && !e.repeat) {
        o.toggleFly();
        this.keys.clear();
        return;
      }
      const k = KEYS[e.code];
      if (!k) return;
      this.keys.add(k);
      if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
    });
    on(window, "keyup", (e) => {
      const k = KEYS[e.code];
      if (k) this.keys.delete(k);
    });
    on(window, "blur", () => this.keys.clear());
    on(document, "pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      // Browsers can report a huge movementX/Y in the first event after locking.
      this.skipMove = this.locked;
    });
    on(document, "visibilitychange", () => this.keys.clear());
    on(canvas, "pointerdown", (e) => {
      // No capture while a panel (inventory) has the mouse.
      if (e.button !== 0 || o.isFlying?.() || this.blocked) return;
      if (!this.locked) {
        // Pointer lock may be refused (automation, iframes): drag to look instead.
        const p = canvas.requestPointerLock?.() as Promise<void> | undefined;
        p?.catch?.(() => {});
        this.drag = { x: e.clientX, y: e.clientY };
      }
    });
    on(window, "pointerup", () => (this.drag = null));
    on(window, "mousemove", (e) => {
      if (o.isFlying?.()) return;
      let dx = 0;
      let dy = 0;
      if (this.locked) {
        [dx, dy] = [e.movementX, e.movementY];
        if (this.skipMove || Math.abs(dx) > 400 || Math.abs(dy) > 400) {
          this.skipMove = false;
          return;
        }
      }
      else if (this.drag) {
        [dx, dy] = [e.clientX - this.drag.x, e.clientY - this.drag.y];
        this.drag = { x: e.clientX, y: e.clientY };
      } else return;
      this.look(this.yaw - dx * SENS, this.pitch - dy * SENS);
    });
  }

  look(yaw: number, pitch: number) {
    this.yaw = yaw;
    this.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, pitch));
  }

  /** Programmatic input for `ms` milliseconds (debug / automation). */
  drive(input: Partial<Input>, ms: number) {
    this.override = { input, until: performance.now() + ms };
  }

  input(): Input {
    if (this.frozen || this.blocked || this.o.isFlying?.()) return { ...NO_INPUT };
    const inp: Input = { ...NO_INPUT };
    for (const k of this.keys) inp[k] = true;
    if (this.override) {
      if (performance.now() < this.override.until) Object.assign(inp, this.override.input);
      else this.override = null;
    }
    return inp;
  }

  /** Puts the player at `pos` (FP feet) at rest (join, snap-back, respawn). */
  snap(pos: readonly number[]) {
    if (this.phys) this.phys.teleport(pos);
    else this.phys = new PlayerPhysics(pos, this.o.params, this.o.world);
  }

  /** Advances physics by `dt` seconds and updates the camera (unless flying). Returns the
   *  physics state for the frame, or null before the player is placed. */
  update(dt: number) {
    const p = this.phys;
    if (!p) return null;
    p.yaw = this.yaw;
    p.input = this.input();
    p.update(dt);
    if (!this.o.isFlying?.()) {
      const [x, y, z] = p.renderPos();
      this.o.camera.position.set(x / FP, y / FP + EYE, z / FP);
      this.o.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
    }
    return p;
  }

  dispose() {
    for (const f of this.off) f();
    this.off = [];
    if (document.pointerLockElement === this.o.canvas) document.exitPointerLock();
  }
}

// ---------------------------------------------------------------- game wiring

export type PlayerSession = {
  controller: PlayerController;
  sync: MoveSync;
  /** Chain-time estimate (cooldowns, presence freshness). */
  clock: ChainClock;
  /** PlayerState account data (initial fetch + notifications). */
  onPlayerState(data: Uint8Array): void;
  stop(): void;
};

export type PlayerSessionOptions = {
  onDead?: () => void;
  onIssue?: (f: TxFailure) => void;
};

/** Starts the controller + move sync for the joined world (core wasm must be loaded). */
export function startPlayer(app: App, view: WorldHandle, worldPk: PublicKey, account: WorldAccount, canvas: HTMLCanvasElement, opts: PlayerSessionOptions = {}): PlayerSession {
  const er = app.conns.er;
  const store = view.store;
  let world = account;
  const params = encodeParams(account.params);
  const flags = blockFlags();
  const controller = new PlayerController({
    canvas,
    camera: view.renderer.camera,
    world: { get: (x, y, z) => store.getBlock(x, y, z), flags },
    params: account.params,
    toggleFly: view.debugCam ? () => view.setFly(!view.flying) : undefined,
    isFlying: () => view.flying,
  });
  const clock = new ChainClock();
  const pstate = pstatePda(app.cfg.programId, worldPk, app.state.player!);
  const sync = new MoveSync({
    params,
    sender: () => (app.state.sessionStale ? null : app.state.sender),
    moveIx: (m) => moveIx(app.program, app.auth(), worldPk, { ...m, view: store }),
    dayCrankIx: () => scheduleDayCrankIx(app.program, worldPk),
    blocks: (cx, cz) => store.moveBlocks(cx, cz),
    fetchState: async () => (await er.getAccountInfo(pstate, "confirmed"))?.data ?? null,
    clock,
    snap: (pos: V3) => controller.snap(pos),
    onClockSuspect: () => clock.reset(),
    onDead: () => {
      controller.frozen = true;
      opts.onDead?.();
    },
    onIssue: opts.onIssue,
    log: (msg, data) => console.info(`[move] ${msg}`, data ?? ""),
  });

  // Chain clock: World anchor (subscription) + the ER's Clock sysvar (slot + validator
  // wall time; polled). Fallback: getSlot + getBlockTime. Never local Date.now().
  let stopped = false;
  const reading = async (): Promise<ChainReading> => {
    const t0 = performance.now();
    const info = await er.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "processed").catch(() => null);
    if (info && info.data.length >= 40) {
      const v = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
      return { slot: Number(v.getBigUint64(0, true)), unixS: Number(v.getBigInt64(32, true)), t0, t1: performance.now() };
    }
    const slot = await er.getSlot("processed");
    const t1 = performance.now();
    const unixS = await er.getBlockTime(slot).catch(() => null);
    return { slot, unixS, t0, t1 };
  };
  const calibrate = async () => {
    try {
      clock.observe(await reading(), world);
    } catch {
      /* next round */
    }
  };
  void calibrate();
  const calTimer = setInterval(() => void calibrate(), 1000);
  const worldSub = er.onAccountChange(
    worldPk,
    (i) => {
      try {
        world = decodeWorld(i.data);
        sync.onWorld(world);
      } catch {
        /* ignore */
      }
    },
    { commitment: "confirmed" },
  );
  sync.onWorld(world);
  const tickTimer = setInterval(() => void sync.tick(), sync.intervalMs);

  // A stall longer than physics catches up (or the tab coming back into view): the local
  // body would lag chain time, so restart from the confirmed state instead.
  let resume = false;
  const onVisible = () => {
    if (document.visibilityState === "visible") resume = true;
  };
  document.addEventListener("visibilitychange", onVisible);
  const offFrame = view.onFrame((dt) => {
    if (stopped) return;
    if ((resume || dt > MAX_CATCHUP_S) && sync.prevState) {
      controller.snap(sync.prevState.pos);
      sync.resetFrames();
      dt = 0;
    }
    resume = false;
    const p = controller.update(dt);
    if (!p) return;
    const b = p.body;
    if (!view.flying) view.setFocus(b.pos[0] / FP, b.pos[1] / FP, b.pos[2] / FP);
    const t = clock.stamp(p.acc * 1000);
    if (t === null) return;
    // Stamp = chain time of the physics state (the accumulator holds unsimulated time).
    sync.record({ t, ...sampleOf(b), inWater: b.inWater });
  });

  const g = globalThis as { __magicraft?: Record<string, unknown> };
  if (!import.meta.env.PROD && g.__magicraft)
    g.__magicraft.player = {
      controller,
      sync,
      clock,
      /** Holds `input` (e.g. `{ forward: true, sprint: true }`) for `ms` ms. */
      input: (input: Partial<Input>, ms = 1000) => controller.drive(input, ms),
      look: (yaw: number, pitch = controller.pitch) => controller.look(yaw, pitch),
      state: () => {
        const b = controller.phys?.body;
        return b && { pos: b.pos.map((v) => +(v / FP).toFixed(3)), vel: b.vel.map((v) => +(v / FP).toFixed(2)), onGround: b.onGround, inWater: b.inWater, prev: sync.prevState };
      },
      stats: () => sync.summary(),
    };

  return {
    controller,
    sync,
    clock,
    onPlayerState: (data) => sync.onPlayerState(data),
    stop() {
      stopped = true;
      sync.stop();
      clearInterval(calTimer);
      clearInterval(tickTimer);
      offFrame();
      document.removeEventListener("visibilitychange", onVisible);
      controller.dispose();
      void er.removeAccountChangeListener(worldSub).catch(() => {});
      if (g.__magicraft) delete g.__magicraft.player;
    },
  };
}
