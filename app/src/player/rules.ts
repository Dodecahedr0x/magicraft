// Pure interaction rules (Task 26): voxel raycast (DDA), mob ray hit-testing, and client
// mirrors of the program's action checks (`programs/magicraft/src/instructions/actions.rs`:
// reach from the eye, melee reach to a mob column, place rules). Positions in FP (1/256
// block) are the **onchain** ones (`MoveSync.prevState`), like the program's.
import type { V3 } from "../chain/layout";

/** Eye height above the feet, FP (1.62 blocks; `actions::EYE_FP`). */
export const EYE_FP = 415;
/** Slack added to every reach limit, FP (0.5 block; `actions::REACH_SLACK_FP`). */
export const REACH_SLACK_FP = 128;
/** Melee reach to a mob, FP (3 blocks; `actions::ATTACK_REACH_FP`). */
export const ATTACK_REACH_FP = 3 * 256;
/** Height of a mob's point column, FP (`actions::MOB_HEIGHT_FP`). */
export const MOB_HEIGHT_FP = 2 * 256;
/** Half-width of the box a placed block must not overlap, FP (`actions::PLACE_HALF_W`). */
export const PLACE_HALF_W = 78;
/** Height of that box above the feet, FP (`actions::PLACE_BODY_H`). */
export const PLACE_BODY_H = 461;

/** `actions::within`: `|d| ≤ r` (Euclidean), each component bounded by `r` first. */
export function within(d: readonly number[], r: number): boolean {
  const rr = Math.max(0, r);
  const [a, b, c] = d.map(Math.abs);
  if (a > rr || b > rr || c > rr) return false;
  return a * a + b * b + c * c <= rr * rr;
}

/** `actions::block_in_reach`: block `b` within `reach` + slack of the eye of a player with
 *  feet at `pos` (FP), measured to the block center. */
export function blockInReach(pos: readonly number[], b: readonly number[], reach: number): boolean {
  const c = (v: number) => v * 256 + 128;
  return within([c(b[0]) - pos[0], c(b[1]) - (pos[1] + EYE_FP), c(b[2]) - pos[2]], reach + REACH_SLACK_FP);
}

/** `actions::mob_in_reach`: a mob with feet at `mob` (FP point column, 2 blocks tall)
 *  within melee reach of the eye of a player with feet at `pos`. */
export function mobInReach(pos: readonly number[], mob: readonly number[]): boolean {
  const eye = pos[1] + EYE_FP;
  const nearest = Math.min(Math.max(eye, mob[1]), mob[1] + MOB_HEIGHT_FP);
  return within([mob[0] - pos[0], nearest - eye, mob[2] - pos[2]], ATTACK_REACH_FP + REACH_SLACK_FP);
}

/** `actions::box_overlaps_block`: the place box of a player with feet at `pos` (FP;
 *  half-open `[x ± 78) × [y, y + 461) × [z ± 78)`) overlaps block `b`. */
export function boxOverlapsBlock(pos: readonly number[], b: readonly number[]): boolean {
  const span = (lo: number, hi: number, bc: number) => lo < bc * 256 + 256 && hi > bc * 256;
  return (
    span(pos[0] - PLACE_HALF_W, pos[0] + PLACE_HALF_W, b[0]) &&
    span(pos[1], pos[1] + PLACE_BODY_H, b[1]) &&
    span(pos[2] - PLACE_HALF_W, pos[2] + PLACE_HALF_W, b[2])
  );
}

// ---------------------------------------------------------------- raycast

export type BlockHit = {
  /** The hit block (integer world coords). */
  block: V3;
  /** Outward normal of the face the ray entered through (`[0,0,0]` if it started inside). */
  face: V3;
  /** Distance along the ray to the entry point, blocks. */
  dist: number;
  /** Block id. */
  id: number;
};

/**
 * Voxel DDA (Amanatides & Woo) from `origin` along `dir` (any length > 0; normalized
 * here) up to `maxDist` blocks. Returns the first voxel whose id satisfies `hits`, with
 * the entry face. `get` returns the block id, or null for unknown voxels (unloaded / not
 * generated): the ray stops there without a hit (it can't see through).
 */
export function raycast(
  origin: readonly number[],
  dir: readonly number[],
  maxDist: number,
  get: (x: number, y: number, z: number) => number | null,
  hits: (id: number) => boolean,
): BlockHit | null {
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (!(len > 0)) return null;
  const d = [dir[0] / len, dir[1] / len, dir[2] / len];
  const v = [Math.floor(origin[0]), Math.floor(origin[1]), Math.floor(origin[2])];
  const step = d.map((x) => (x > 0 ? 1 : x < 0 ? -1 : 0));
  const tDelta = d.map((x) => (x !== 0 ? Math.abs(1 / x) : Infinity));
  const tMax = d.map((x, i) => {
    if (x === 0) return Infinity;
    const edge = x > 0 ? v[i] + 1 - origin[i] : origin[i] - v[i];
    return edge * tDelta[i];
  });
  let face: V3 = [0, 0, 0];
  let t = 0;
  for (let n = 0; n < 512 && t <= maxDist; n++) {
    const id = get(v[0], v[1], v[2]);
    if (id === null) return null;
    if (hits(id)) return { block: [v[0], v[1], v[2]], face, dist: t, id };
    // Advance along the axis whose boundary is nearest.
    const a = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2;
    t = tMax[a];
    tMax[a] += tDelta[a];
    v[a] += step[a];
    face = [0, 0, 0];
    face[a] = -step[a];
  }
  return null;
}

/** Ray vs axis-aligned box (slab test): entry distance ≥ 0, or null if missed. A ray
 *  starting inside the box hits at 0. */
export function rayBox(origin: readonly number[], dir: readonly number[], min: readonly number[], max: readonly number[]): number | null {
  let t0 = 0;
  let t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (dir[i] === 0) {
      if (origin[i] < min[i] || origin[i] > max[i]) return null;
      continue;
    }
    let a = (min[i] - origin[i]) / dir[i];
    let b = (max[i] - origin[i]) / dir[i];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t0;
}

/** Hit-box of a mob kind (`MOB` ids): half-width and height in blocks (feet at the
 *  bottom center). Rendering (Task 27) uses the same sizes. */
export function mobBox(kind: number): { halfW: number; height: number } {
  switch (kind) {
    case 1: // pig
      return { halfW: 0.45, height: 0.9 };
    case 2: // cow
      return { halfW: 0.45, height: 1.4 };
    case 3: // sheep
      return { halfW: 0.45, height: 1.3 };
    default: // zombie (and unknown)
      return { halfW: 0.3, height: 1.95 };
  }
}

/** Hit-box of a player (the client body: 0.3 half-width, 1.8 tall). */
export const PLAYER_BOX = { halfW: 0.3, height: 1.8 } as const;

/** The nearest player whose box the ray hits within `maxDist` blocks (`pos`: feet, blocks). */
export function pickPlayer<P extends { pos: readonly number[] }>(origin: readonly number[], dir: readonly number[], maxDist: number, players: Iterable<P>): { player: P; dist: number } | null {
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (!(len > 0)) return null;
  const d = dir.map((x) => x / len);
  const { halfW, height } = PLAYER_BOX;
  let best: { player: P; dist: number } | null = null;
  for (const p of players) {
    const [x, y, z] = p.pos;
    const t = rayBox(origin, d, [x - halfW, y, z - halfW], [x + halfW, y + height, z + halfW]);
    if (t !== null && t <= maxDist && (!best || t < best.dist)) best = { player: p, dist: t };
  }
  return best;
}

export type MobRef = { cx: number; cz: number; idx: number; kind: number; hp: number; pos: V3 };

/** The nearest mob whose box the ray hits within `maxDist` blocks (`pos` in FP). */
export function pickMob<M extends MobRef>(origin: readonly number[], dir: readonly number[], maxDist: number, mobs: Iterable<M>): { mob: M; dist: number } | null {
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (!(len > 0)) return null;
  const d = dir.map((x) => x / len);
  let best: { mob: M; dist: number } | null = null;
  for (const m of mobs) {
    const { halfW, height } = mobBox(m.kind);
    const [x, y, z] = m.pos.map((v) => v / 256);
    const t = rayBox(origin, d, [x - halfW, y, z - halfW], [x + halfW, y + height, z + halfW]);
    if (t !== null && t <= maxDist && (!best || t < best.dist)) best = { mob: m, dist: t };
  }
  return best;
}

// ---------------------------------------------------------------- placement

/** Block property flags (`blocks::BLOCK_FLAGS`: 1 solid, 2 transparent, 4 fluid). */
export const SOLID = 1;
export const FLUID = 4;
const FACES: V3[] = [
  [0, -1, 0],
  [0, 1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export type PlaceInput = {
  /** Target block (hit block + face normal). */
  target: V3;
  /** Block placed by the held item, or −1 (not a block item / empty slot). */
  block: number;
  /** Held slot is empty. */
  empty: boolean;
  /** Onchain feet position of the placer (FP). */
  pos: V3;
  /** Other boxes that must not be overlapped by a solid block: the local (predicted)
   *  position of the placer and fresh presence entries (FP feet). */
  others: readonly V3[];
  reach: number;
  /** Block id, or null if unknown / not in a ready chunk (the program then doesn't get the
   *  chunk, so a face there is no support). */
  get: (x: number, y: number, z: number) => number | null;
  flags: Uint8Array;
};

/** Client mirror of `place_block`'s checks, in the program's order; the error name the
 *  program would return, or null if the placement should pass. */
export function placeError(p: PlaceInput): string | null {
  const [x, y, z] = p.target;
  if (y < 0 || y >= 64) return "InvalidTarget";
  if (!blockInReach(p.pos, p.target, p.reach)) return "OutOfReach";
  if (p.empty) return "EmptySlot";
  if (p.block < 0) return "NotPlaceable";
  const old = p.get(x, y, z);
  if (old === null) return "ChunkNotReady";
  if (old !== 0 && !(p.flags[old] & FLUID)) return "InvalidTarget";
  const support = FACES.some(([dx, dy, dz]) => {
    const ny = y + dy;
    if (ny < 0 || ny >= 64) return false;
    const b = p.get(x + dx, ny, z + dz);
    return b !== null && (p.flags[b] & SOLID) !== 0;
  });
  if (!support) return "NotFaceAdjacent";
  if (p.flags[p.block] & SOLID) {
    if (boxOverlapsBlock(p.pos, p.target)) return "SelfOverlap";
    if (p.others.some((o) => boxOverlapsBlock(o, p.target))) return "SelfOverlap";
  }
  return null;
}

// ---------------------------------------------------------------- stations

/** The nearest block `want` (crafting table 15 / furnace 16) within block reach of the
 *  onchain feet `pos` (FP), or null. Scans the cube the reach sphere fits in. */
export function nearestStation(pos: readonly number[], reach: number, want: number, get: (x: number, y: number, z: number) => number | null): V3 | null {
  const r = Math.ceil((reach + REACH_SLACK_FP) / 256) + 1;
  const ex = Math.floor(pos[0] / 256);
  const ey = Math.floor((pos[1] + EYE_FP) / 256);
  const ez = Math.floor(pos[2] / 256);
  let best: V3 | null = null;
  let bestD = Infinity;
  for (let y = Math.max(0, ey - r); y <= Math.min(63, ey + r); y++)
    for (let z = ez - r; z <= ez + r; z++)
      for (let x = ex - r; x <= ex + r; x++) {
        if (get(x, y, z) !== want || !blockInReach(pos, [x, y, z], reach)) continue;
        const d = (x * 256 + 128 - pos[0]) ** 2 + (y * 256 + 128 - pos[1] - EYE_FP) ** 2 + (z * 256 + 128 - pos[2]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = [x, y, z];
        }
      }
  return best;
}
