// Route planner for the actions spec (14-actions): over magicraft-core
// reference blocks of a plus-shaped set of chunks, finds an animal to hunt, a
// block under water to break, and a work spot with logs, stone, soft blocks
// (pillar material) and two columns to pillar up / fall from. Pure (no chain).
import { isSolid, surface } from "./play";

export type V3 = [number, number, number];
export type Col = [number, number];

export const B = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 5,
  GRAVEL: 7,
  BEDROCK: 8,
  LOG: 9,
} as const;
const SOFT = new Set<number>([B.GRASS, B.DIRT, B.SAND, B.GRAVEL]);
const isWater = (b: number) => b >= 23 && b <= 30;

/** Reach used for planning (blocks): the program allows params.reach (5) +
 *  0.5 slack, measured eye → block center. */
export const PLAN_REACH = 4.7;
/** Melee reach for planning (program: 3 + 0.5 slack). */
export const PLAN_ATTACK_REACH = 2.9;
export const EYE = 1.62;
/** Nonlethal pillar height on the work column (fall damage 3..12). */
export const SMALL_PILLAR = 8;

export type Animal = { kind: number; pos: V3 }; // world block of the feet

export class Terrain {
  constructor(readonly chunks: Map<string, Buffer>) {}

  block(x: number, y: number, z: number): number {
    if (y < 0) return B.BEDROCK;
    if (y > 63) return B.AIR;
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const c = this.chunks.get(`${cx},${cz}`);
    if (!c) return 255;
    return c[y * 256 + (z - cz * 16) * 16 + (x - cx * 16)];
  }

  set(p: V3, b: number) {
    const cx = Math.floor(p[0] / 16);
    const cz = Math.floor(p[2] / 16);
    const c = this.chunks.get(`${cx},${cz}`);
    if (c) c[p[1] * 256 + (p[2] - cz * 16) * 16 + (p[0] - cx * 16)] = b;
  }

  /** Feet y on top of the column (everything above is air), or null. */
  h(x: number, z: number): number | null {
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const c = this.chunks.get(`${cx},${cz}`);
    return c ? surface(c, x - cx * 16, z - cz * 16) : null;
  }
}

const key = (x: number, z: number) => `${x},${z}`;
const N4: Col[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** BFS walk tree from `start` (steps up ≤ 1, down ≤ 3, like play.planWalk). */
export function walkTree(t: Terrain, start: Col) {
  const prev = new Map<string, string | null>([[key(...start), null]]);
  const order: Col[] = [];
  const q: Col[] = [start];
  while (q.length) {
    const [x, z] = q.shift()!;
    const hy = t.h(x, z);
    if (hy === null) continue;
    order.push([x, z]);
    for (const [dx, dz] of N4) {
      const [nx, nz] = [x + dx, z + dz];
      if (prev.has(key(nx, nz))) continue;
      const nh = t.h(nx, nz);
      if (nh === null || nh - hy > 1 || hy - nh > 3) continue;
      prev.set(key(nx, nz), key(x, z));
      q.push([nx, nz]);
    }
  }
  /** Waypoints `[x, feetY, z]` from start (excluded) to `to`, or null. */
  const path = (to: Col): V3[] | null => {
    if (!prev.has(key(...to))) return null;
    const out: V3[] = [];
    let k: string | null = key(...to);
    while (k && k !== key(...start)) {
      const [px, pz] = k.split(",").map(Number);
      out.unshift([px, t.h(px, pz)!, pz]);
      k = prev.get(k)!;
    }
    return out;
  };
  const parent = (c: Col): Col | null => {
    const p = prev.get(key(...c));
    return p ? (p.split(",").map(Number) as Col) : null;
  };
  return { order, path, parent, has: (c: Col) => prev.has(key(...c)) };
}

/** Eye of a player standing on column c at feet y. */
const eyeOf = (c: Col, y: number): V3 => [c[0] + 0.5, y + EYE, c[1] + 0.5];
const dist = (a: V3, b: V3) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const center = (b: V3): V3 => [b[0] + 0.5, b[1] + 0.5, b[2] + 0.5];

/** Blocks within `r` of the eye (bounding box scan). */
function blocksNear(
  t: Terrain,
  eye: V3,
  r: number,
  pred: (b: number, p: V3) => boolean
) {
  const out: V3[] = [];
  const R = Math.ceil(r) + 1;
  for (let y = Math.floor(eye[1]) - R; y <= Math.floor(eye[1]) + R; y++)
    for (let z = Math.floor(eye[2]) - R; z <= Math.floor(eye[2]) + R; z++)
      for (let x = Math.floor(eye[0]) - R; x <= Math.floor(eye[0]) + R; x++) {
        if (y < 0 || y > 63) continue;
        const p: V3 = [x, y, z];
        if (dist(eye, center(p)) > r) continue;
        const b = t.block(x, y, z);
        if (b !== 255 && pred(b, p)) out.push(p);
      }
  out.sort((a, b) => dist(eye, center(a)) - dist(eye, center(b)));
  return out;
}

export type Hunt = {
  animal: Animal;
  /** Hunting column and the walk spawn → P. */
  P: Col;
  pathP: V3[];
};

export type Plan = {
  /** Column next to water, the block next to water to break, the walk P → W. */
  W: Col;
  Q: V3;
  pathW: V3[];
  /** Log column (3 logs within reach), the walk W → L. */
  L: Col;
  logs: V3[];
  pathL: V3[];
  /** Work column (feet g0), the walk L → S. */
  S: Col;
  g0: number;
  pathS: V3[];
  /** Second player's column (next to S) and its walk from the spawn. */
  Bc: Col;
  pathB: V3[];
  stones: V3[];
  soft: V3[];
  /** Crafting table position (air, solid below). */
  T: V3;
  /** Air block with no solid face neighbour. */
  nfa: V3;
  /** Nonlethal fall: pillar SMALL_PILLAR on S, step off onto C1 (feet g1). */
  C1: Col;
  g1: number;
  /** Lethal fall: pillar on C1 up to feet `top`, step off onto C2 (feet g2). */
  C2: Col;
  g2: number;
  top: number;
};

const eq = (a: Col, b: Col) => a[0] === b[0] && a[1] === b[1];
const FACES: V3[] = [
  [0, -1, 0],
  [0, 1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** An animal (prefer pigs) within melee reach of a column walkable from the
 *  spawn, or why not. */
export function scoutHunt(
  t: Terrain,
  spawn: V3,
  animals: Animal[]
): Hunt | string {
  const fromSpawn = walkTree(t, [spawn[0], spawn[2]]);
  // Prefer pigs (kind 1), then cows and sheep.
  let hunt: { animal: Animal; P: Col } | null = null;
  for (const kind of [1, 2, 3]) {
    for (const c of fromSpawn.order) {
      const eye = eyeOf(c, t.h(...c)!);
      const a = animals.find((a) => {
        if (a.kind !== kind) return false;
        const ny = Math.min(Math.max(eye[1], a.pos[1]), a.pos[1] + 2);
        return (
          dist(eye, [a.pos[0] + 0.5, ny, a.pos[2] + 0.5]) <= PLAN_ATTACK_REACH
        );
      });
      if (a) {
        hunt = { animal: a, P: c };
        break;
      }
    }
    if (hunt) break;
  }
  if (!hunt) return `no reachable animal (${animals.length} animals)`;
  return { ...hunt, pathP: fromSpawn.path(hunt.P)! };
}

/** Plans the work route from column `start` (the second player walks from the
 *  spawn), or explains why not (`string`). Mutates `t` (the planned breaks are
 *  applied, so later walks see them). */
export function scoutWork(t: Terrain, start: Col, spawn: V3): Plan | string {
  const sp: Col = [spawn[0], spawn[2]];
  // 1. A breakable block with water on a face, within reach of a walkable column.
  const fromP = walkTree(t, start);
  let water: { W: Col; Q: V3 } | null = null;
  for (const c of fromP.order) {
    const eye = eyeOf(c, t.h(...c)!);
    const q = blocksNear(t, eye, PLAN_REACH, (b, p) => {
      // Not a log: its drop would change the log counts later.
      if (!isSolid(b) || b === B.BEDROCK || b === B.LOG || b === 255)
        return false;
      if (p[0] === c[0] && p[2] === c[1]) return false; // not under our feet
      return FACES.some(([a, b2, cc]) =>
        isWater(t.block(p[0] + a, p[1] + b2, p[2] + cc))
      );
    });
    if (q.length) {
      water = { W: c, Q: q[0] };
      break;
    }
  }
  if (!water) return "no block next to water within reach";
  const pathW = fromP.path(water.W)!;
  t.set(water.Q, B.AIR);

  // 2. Three logs within reach.
  const fromW = walkTree(t, water.W);
  let wood: { L: Col; logs: V3[] } | null = null;
  for (const c of fromW.order) {
    const logs = blocksNear(
      t,
      eyeOf(c, t.h(...c)!),
      PLAN_REACH,
      (b) => b === B.LOG
    );
    if (logs.length >= 3) {
      wood = { L: c, logs: logs.slice(0, 3) };
      break;
    }
  }
  if (!wood) return "no 3 logs within reach";
  const pathL = fromW.path(wood.L)!;
  for (const l of wood.logs) t.set(l, B.AIR);

  // 3. Work spot.
  const fromL = walkTree(t, wood.L);
  const fromSpawn2 = walkTree(t, sp);
  for (const S of fromL.order) {
    const g0 = t.h(...S)!;
    const eye = eyeOf(S, g0);
    // Second player: a neighbour of S reachable from the spawn.
    const bcs = N4.map(([dx, dz]) => [S[0] + dx, S[1] + dz] as Col).filter(
      (c) => fromSpawn2.has(c) && !eq(c, sp)
    );
    for (const Bc of bcs) {
      const pathB = fromSpawn2.path(Bc)!;
      for (const [dx1, dz1] of N4) {
        const C1: Col = [S[0] + dx1, S[1] + dz1];
        const g1 = t.h(...C1);
        if (g1 === null || eq(C1, Bc)) continue;
        const dmg1 = g0 + SMALL_PILLAR - g1 - 3;
        if (dmg1 < 3 || dmg1 > 12) continue;
        for (const [dx2, dz2] of N4) {
          const C2: Col = [C1[0] + dx2, C1[1] + dz2];
          const g2 = t.h(...C2);
          if (g2 === null || eq(C2, S) || eq(C2, Bc)) continue;
          const top = g2 + 24; // fall damage top − g2 − 3 = 21 ≥ 20
          if (top > 64 || top - g1 < 2) continue;
          // Protected columns: their top block (support) must stay.
          const prot = new Map<string, number>();
          const protect = (c: Col) => prot.set(key(...c), t.h(...c)! - 1);
          for (const c of [S, C1, C2, Bc]) protect(c);
          for (const p of pathB) protect([p[0], p[2]]);
          const breakable = (p: V3) =>
            !prot.has(key(p[0], p[2])) || p[1] < prot.get(key(p[0], p[2]))!;
          const tables = blocksNear(t, eye, 4.3, (b, p) => {
            const c: Col = [p[0], p[2]];
            return b === B.AIR && !prot.has(key(...c)) && t.h(...c) === p[1];
          });
          if (!tables.length) continue;
          const T = tables[0];
          protect([T[0], T[2]]);
          const solidAt = (x: number, y: number, z: number) => {
            const b = t.block(x, y, z);
            return b === 255 || isSolid(b);
          };
          const nfas = blocksNear(t, eye, 4.3, (b, p) => {
            if (b !== B.AIR) return false;
            const [x, y, z] = p;
            if (
              Math.abs(x - T[0]) + Math.abs(y - T[1]) + Math.abs(z - T[2]) <=
              1
            )
              return false;
            return !FACES.some(([a, b2, c]) => solidAt(x + a, y + b2, z + c));
          });
          if (!nfas.length) continue;
          const stones = blocksNear(
            t,
            eye,
            PLAN_REACH,
            (b, p) => b === B.STONE && breakable(p)
          );
          if (stones.length < 2) continue;
          const need = SMALL_PILLAR + (top - g1) + 2;
          const soft = blocksNear(
            t,
            eye,
            PLAN_REACH,
            (b, p) => SOFT.has(b) && breakable(p)
          );
          if (soft.length < need) continue;
          return {
            W: water.W,
            Q: water.Q,
            pathW,
            L: wood.L,
            logs: wood.logs,
            pathL,
            S,
            g0,
            pathS: fromL.path(S)!,
            Bc,
            pathB,
            stones: stones.slice(0, 2),
            soft: soft.slice(0, need),
            T,
            nfa: nfas[0],
            C1,
            g1,
            C2,
            g2,
            top,
          };
        }
      }
    }
  }
  return "no work spot";
}
