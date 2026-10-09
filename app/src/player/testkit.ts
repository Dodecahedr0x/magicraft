// Test helpers (physics / sync tests only): a synthetic chunked world mirroring the core's
// physics test world, and a 60 fps client loop whose 8 Hz samples are checked with the
// core's `check_move` (wasm).
import { DEFAULT_WORLD_PARAMS } from "../chain/layout";
import { blockFlags, checkMove, coreMoveWindow, spawnState, type CheckResult, type Quad } from "../wasm";
import { FP, PlayerPhysics, sampleOf, type Input, type PhysParams, type World } from "./physics";
import { chooseFrame, encodeParams, type Frame } from "./sync";

export const AIR = 0;
export const GRASS = 1;
export const STONE = 3;
export const LEAVES = 10;
export const WATER = 23;
export const WATER7 = 30;

/** Core test world (block coords), plus extras:
 *  - default: `y < 10` Stone, else Air (feet stand at y = 10);
 *  - pool: x -40..=-31, z 0..=9: Water at y 7..=9, Stone below;
 *  - tower: x -20..=-11, z 0..=9: Stone up to y 19 (top at 20);
 *  - wall: x = 20, z -50..=50, y 10..=12;
 *  - step: x 30..=32, z 0..=9, y = 10 (top at 11);
 *  - platform: x 40..=42, z 0..=9, y 10..=12 (top at 13);
 *  - overhang: x = 25, z 0..=9, y = 12;
 *  - stairs: x 50..=69, z 0..=9, top at `11 + (x - 50) / 2`;
 *  - pit: x 70..=79, z 0..=9, top at 2;
 *  - puddles: x 0..=9, z 20..=29, flowing water (level 7) at y = 10 on odd x;
 *  - shallow pond: x -40..=-31, z 20..=29: Water at y = 9 only (1 deep);
 *  - leaves canopy: x 10..=14, z 20..=24, y = 12 (head height + 0.2). */
export function coreBlock(x: number, y: number, z: number): number {
  if (y < 0) return 8;
  if (y >= 64) return AIR;
  const zin = z >= 0 && z <= 9;
  const stairTop = (x: number) => 11 + Math.floor((x - 50) / 2);
  if (x >= -40 && x <= -31 && zin) return y < 7 ? STONE : y <= 9 ? WATER : AIR;
  if (x >= -20 && x <= -11 && zin && y < 20) return STONE;
  if (x === 25 && zin && y === 12) return STONE;
  if (x >= 50 && x <= 69 && zin) return y < stairTop(x) ? STONE : AIR;
  if (x >= 70 && x <= 79 && zin) return y < 2 ? STONE : AIR;
  if (x === 20 && z >= -50 && z <= 50 && y >= 10 && y <= 12) return STONE;
  if (x >= 30 && x <= 32 && zin && y === 10) return STONE;
  if (x >= 40 && x <= 42 && zin && y >= 10 && y <= 12) return STONE;
  if (x >= 0 && x <= 9 && z >= 20 && z <= 29 && y === 10 && x % 2 === 1) return WATER7;
  if (x >= -40 && x <= -31 && z >= 20 && z <= 29 && y === 9) return WATER;
  if (x >= 10 && x <= 14 && z >= 20 && z <= 24 && y === 12) return LEAVES;
  return y < 10 ? STONE : AIR;
}

/** Chunked copy of a block function within `|cx|, |cz| ≤ r` (unknown beyond → null). */
export class ChunkWorld {
  private chunks = new Map<string, Uint8Array>();
  constructor(
    readonly block: (x: number, y: number, z: number) => number = coreBlock,
    readonly r = 6,
  ) {}
  chunk(cx: number, cz: number): Uint8Array | null {
    if (Math.abs(cx) > this.r || Math.abs(cz) > this.r) return null;
    const k = `${cx},${cz}`;
    let c = this.chunks.get(k);
    if (!c) {
      c = new Uint8Array(16384);
      for (let y = 0; y < 64; y++)
        for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) c[(y * 16 + z) * 16 + x] = this.block(cx * 16 + x, y, cz * 16 + z);
      this.chunks.set(k, c);
    }
    return c;
  }
  set(x: number, y: number, z: number, b: number) {
    const c = this.chunk(Math.floor(x / 16), Math.floor(z / 16));
    if (c) c[(y * 16 + (z - Math.floor(z / 16) * 16)) * 16 + (x - Math.floor(x / 16) * 16)] = b;
  }
  get = (x: number, y: number, z: number): number | null => {
    if (y >= 64) return 0;
    if (y < 0) return null;
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const c = this.chunk(cx, cz);
    return c ? c[(y * 16 + (z - cz * 16)) * 16 + (x - cx * 16)] : null;
  };
  physWorld(): World {
    return { get: this.get, flags: blockFlags() };
  }
  quad(cx0: number, cz0: number): Quad {
    return { cx0, cz0, slots: [this.chunk(cx0, cz0), this.chunk(cx0 + 1, cz0), this.chunk(cx0, cz0 + 1), this.chunk(cx0 + 1, cz0 + 1)] };
  }
}

export const PARAMS: PhysParams = DEFAULT_WORLD_PARAMS;
export const PARAM_BYTES = () => encodeParams(DEFAULT_WORLD_PARAMS);

/** Block coords (+ fraction in blocks) → FP. */
export const fp = (b: number) => Math.round(b * FP);

export type Script = (frame: number, phys: PlayerPhysics) => Partial<Input> & { yaw?: number };

export type RunResult = {
  /** Every checked update (frame, sample, result). */
  checks: { frame: number; pos: number[]; onGround: boolean; res: CheckResult }[];
  rejected: { frame: number; pos: number[]; error: string }[];
  fallDamage: number;
  /** Updates where `chooseFrame` sent another frame than the newest (`fallback`). */
  fallbacks: number;
  phys: PlayerPhysics;
};

/** Runs a 60 fps client for `frames` frames from `start` (FP feet), checking an update
 *  every `every` frames against the last accepted state with `check_move` (client time =
 *  frame time; chain time 40 ms later). With `fallback`, the frame is picked like the sync
 *  layer does (`chooseFrame`); only if none passes is it counted as rejected. A rejected
 *  update snaps the client back to the last accepted state. */
export function runClient(
  world: ChunkWorld,
  start: number[],
  frames: number,
  script: Script,
  every = 8,
  opts: { onGround?: boolean; fallback?: boolean } = {},
): RunResult {
  const params = PARAM_BYTES();
  const phys = new PlayerPhysics(start, PARAMS, world.physWorld());
  let prev = spawnState(start, 0, opts.onGround ?? true);
  let prevPos = start;
  const out: RunResult = { checks: [], rejected: [], fallDamage: 0, fallbacks: 0, phys };
  let hist: Frame[] = [];
  let floor = 0;
  const check = (f: Frame, onGround: boolean): CheckResult => {
    const win = coreMoveWindow(prevPos, f.pos);
    return win ? checkMove(params, prev, f.pos, f.vel, onGround, f.t, f.t + 40, world.quad(win[0], win[1])) : { ok: false, error: "MoveTooFast" };
  };
  for (let f = 1; f <= frames; f++) {
    const inp = script(f, phys);
    if (inp.yaw !== undefined) phys.yaw = inp.yaw;
    phys.input = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, ...inp };
    phys.update(1 / 60);
    const s = sampleOf(phys.body);
    const frame: Frame = { t: Math.floor((f * 1000) / 60), ...s, inWater: phys.body.inWater };
    hist.push(frame);
    if (f % every) continue;
    let res: CheckResult;
    let sent = frame;
    if (opts.fallback) {
      const c = chooseFrame(hist, floor, check);
      if (c.pick) {
        res = c.pick.res;
        sent = { ...c.pick.frame, onGround: c.pick.onGround };
        if (c.pick.frame !== frame) out.fallbacks++;
      } else res = { ok: false, error: (c.rejected ?? "Collision") as never };
    } else res = check(frame, frame.onGround);
    out.checks.push({ frame: f, pos: s.pos, onGround: s.onGround, res });
    if (res.ok) {
      prev = res.state;
      prevPos = sent.pos;
      floor = sent.t;
      out.fallDamage += res.fallDamage;
      hist = hist.filter((h) => h.t > sent.t);
    } else {
      out.rejected.push({ frame: f, pos: s.pos, error: res.error });
      phys.teleport(prevPos);
      hist = [];
    }
  }
  return out;
}
