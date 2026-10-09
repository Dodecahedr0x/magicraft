// Client player physics: 60 fps fixed steps in FP units (1 block = 256), built to stay
// inside what `core::physics::check_move` accepts (crates/core/src/physics.rs, "Client
// parity requirements"); the sync layer additionally pre-validates every update with the
// core itself (wasm) before sending it.
//
// Parity decisions:
// - Units: positions are FP floats (feet center), speeds FP/s, gravity FP/s² straight from
//   `WorldParams`; updates send positions rounded to the nearest FP (`sampleOf`).
// - Box 0.6 × 1.8 × 0.6 (half-width 76.8 FP, height 460.8 FP), larger than the program's
//   (74 / 4..456 FP), so resting against a face never overlaps onchain after rounding.
// - Fixed step 1/60 s (≤ 50 ms per integration step); a frame catches up at most
//   `MAX_CATCHUP_S` (1.5 s; dropping time inside a jump makes the body rise later in chain
//   time than the program's jump ceiling allows, so slow frames must be simulated in full;
//   the controller snaps to the confirmed state after longer stalls). Gravity is integrated exactly per step (trapezoid with the max-fall clamp),
//   so the jump apex is ≤ `v²/2g` (1.25 blocks with default params).
// - Horizontal: no inertia, full air control; walk / sprint (Shift) speed, swim speed
//   whenever the feet or head voxel is water (puddles / flowing water count, like the
//   program's `in_water`). Diagonals are normalized.
// - Jump: `vy = jump_velocity` only from the ground (also standing in shallow water). In
//   water: Space swims up at `swim_speed` (bobbing at the surface); with the feet in water
//   within 0.3 block of the surface for ≥ 0.25 s, the head out and pressed against a wall,
//   Space is a one-off water-jump (0.1 block lower than a ground jump) to climb out onto a
//   one-block ledge. Without Space the player sinks; falling into water clamps the sink
//   rate to `swim_speed`.
// - Collision: axis sweeps (x, then z, then y) against every voxel layer the box crosses;
//   `getBlock` null (unknown / not generated) is solid; already-overlapped voxels don't
//   block (stepping out of a block placed into the player). No auto step-up.
// - Landing snaps y exactly to the block top; `onGround` is true only while resting on a
//   block top (a downward move was stopped by a solid voxel).
export const FP = 256;
/** Client box half-width (0.3 block), FP. */
export const HALF_W = 76.8;
/** Client box height (1.8 blocks), FP. */
export const HEIGHT = 460.8;
/** Camera height above the feet, blocks. */
export const EYE = 1.62;
/** Fixed integration step, s. */
export const STEP_S = 1 / 60;
/** Most simulated time per frame, s. Frames up to this are simulated in full (dropping
 *  time mid-jump fails the program's jump ceiling); longer stalls are dropped and the
 *  controller snaps the player back to the confirmed state (`PlayerController`). */
export const MAX_CATCHUP_S = 1.5;
/** Integration steps per `update` call (bounds the work of one frame). */
export const MAX_STEPS_PER_UPDATE = Math.ceil(MAX_CATCHUP_S / (1 / 60)) + 1;
/** `physics::FEET_EPS` / `BODY_H`: the program's water probes (feet / head voxel). */
export const FEET_EPS = 4;
export const BODY_H = 456;
/** Overlaps thinner than this don't count (float noise at exact faces), FP. */
const EPS = 1e-4;

export type PhysParams = {
  walkSpeed: number;
  sprintSpeed: number;
  swimSpeed: number;
  jumpVelocity: number;
  gravity: number;
  maxFallSpeed: number;
};

/** Block id at integer block coords; null = unknown (treated as solid). */
export type GetBlock = (x: number, y: number, z: number) => number | null;

export type Input = {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sprint: boolean;
};

export const NO_INPUT: Readonly<Input> = Object.freeze({ forward: false, back: false, left: false, right: false, jump: false, sprint: false });

export type Body = {
  /** Feet center, FP. */
  pos: [number, number, number];
  /** FP/s. */
  vel: [number, number, number];
  onGround: boolean;
  /** The program's `in_water` at the rounded position. */
  inWater: boolean;
  /** A horizontal move was stopped by a wall in the last step. */
  hitWall: boolean;
  /** How long the body has been in water without interruption, s. */
  waterTime: number;
};

export const newBody = (pos: readonly number[]): Body => ({
  pos: [pos[0], pos[1], pos[2]],
  vel: [0, 0, 0],
  onGround: false,
  inWater: false,
  hitWall: false,
  waterTime: 0,
});

export type World = {
  get: GetBlock;
  /** `core::blocks::BLOCK_FLAGS` (bit 1 solid, 4 fluid). */
  flags: Uint8Array;
};

const solid = (w: World, x: number, y: number, z: number) => {
  const b = w.get(x, y, z);
  return b === null || (w.flags[b] & 1) !== 0;
};
const water = (w: World, x: number, y: number, z: number) => {
  const b = w.get(x, y, z);
  return b !== null && (w.flags[b] & 4) !== 0;
};

/** `physics::in_water` at FP integer position `p`: feet or head voxel at the xz center. */
export function waterProbe(w: World, p: readonly number[]): { feet: boolean; head: boolean } {
  const bx = Math.floor(p[0] / FP);
  const bz = Math.floor(p[2] / FP);
  return {
    feet: water(w, bx, Math.floor((p[1] + FEET_EPS) / FP), bz),
    head: water(w, bx, Math.floor((p[1] + BODY_H - 1) / FP), bz),
  };
}

const roundPos = (p: readonly number[]): [number, number, number] => [Math.round(p[0]), Math.round(p[1]), Math.round(p[2])];

const lo = (b: Body, a: number) => (a === 1 ? b.pos[1] : b.pos[a] - HALF_W);
const hi = (b: Body, a: number) => (a === 1 ? b.pos[1] + HEIGHT : b.pos[a] + HALF_W);
/** Voxel range covered by `[l, h]` (touching faces excluded). */
const cells = (l: number, h: number): [number, number] => [Math.floor((l + EPS) / FP), Math.floor((h - EPS) / FP)];

/** Any solid voxel in layer `c` of axis `a` within the box's cross-section. */
function layerSolid(w: World, b: Body, a: number, c: number): boolean {
  const [u, v] = a === 0 ? [1, 2] : a === 1 ? [0, 2] : [0, 1];
  const [u0, u1] = cells(lo(b, u), hi(b, u));
  const [v0, v1] = cells(lo(b, v), hi(b, v));
  for (let i = u0; i <= u1; i++)
    for (let j = v0; j <= v1; j++) {
      const p = [0, 0, 0];
      p[a] = c;
      p[u] = i;
      p[v] = j;
      if (solid(w, p[0], p[1], p[2])) return true;
    }
  return false;
}

/** Moves the box by `d` along axis `a`, stopping at the first solid voxel layer; exact face
 *  positions on contact. Returns true if stopped. */
function sweep(w: World, b: Body, a: number, d: number): boolean {
  if (d === 0) return false;
  const off = a === 1 ? 0 : -HALF_W;
  const size = a === 1 ? HEIGHT : 2 * HALF_W;
  if (d > 0) {
    const L = hi(b, a);
    const end = L + d;
    for (let c = Math.floor((L - EPS) / FP) + 1; c * FP < end - EPS; c++)
      if (layerSolid(w, b, a, c)) {
        b.pos[a] = c * FP - size - off;
        return true;
      }
  } else {
    const L = lo(b, a);
    const end = L + d;
    for (let c = Math.floor((L + EPS) / FP) - 1; (c + 1) * FP > end + EPS; c--)
      if (layerSolid(w, b, a, c)) {
        b.pos[a] = (c + 1) * FP - off;
        return true;
      }
  }
  b.pos[a] += d;
  return false;
}

/** Water-jump margin below the full jump height, FP (0.1 block). */
const WATER_JUMP_MARGIN = 25.6;
/** Water-jump only after this long in water, s: the program grants the new ceiling only
 *  from an update sent while in water (8 Hz ⇒ one lands within ~133 ms). */
const WATER_JUMP_AFTER_S = 0.25;
/** The water surface is within this above the feet, FP (0.3 block). */
const SURFACE_DIST = 76.8;

/** Water-jump speed: a jump `WATER_JUMP_MARGIN` lower than a ground jump. The program's
 *  ceiling after leaving water is the last in-water update's y + jump height + 0.25 block,
 *  and the player may have swum up to ~0.27 block since that update. */
export const waterJumpVelocity = (p: PhysParams) => {
  const h = (p.jumpVelocity * p.jumpVelocity) / (2 * p.gravity) - WATER_JUMP_MARGIN;
  return h > 0 ? Math.sqrt(2 * p.gravity * h) : 0;
};

/** The voxel `SURFACE_DIST` above the feet (at the xz center) is not water. */
const nearSurface = (w: World, pos: readonly number[]) =>
  !water(w, Math.floor(pos[0] / FP), Math.floor((pos[1] + SURFACE_DIST) / FP), Math.floor(pos[2] / FP));

/** One fixed step of `h` seconds (≤ 50 ms). `yaw`: radians, forward = −z rotated by yaw. */
export function step(b: Body, input: Input, yaw: number, p: PhysParams, w: World, h = STEP_S) {
  const wp = waterProbe(w, roundPos(b.pos));
  const inWater = wp.feet || wp.head;

  // Horizontal velocity.
  const f = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
  const s = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  let vx = 0;
  let vz = 0;
  if (f || s) {
    const n = f && s ? Math.SQRT1_2 : 1;
    const speed = inWater ? p.swimSpeed : input.sprint ? p.sprintSpeed : p.walkSpeed;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    vx = (-sin * f + cos * s) * n * speed;
    vz = (-cos * f - sin * s) * n * speed;
  }

  // Vertical velocity and displacement.
  let vy = b.vel[1];
  let dy: number;
  if (inWater) {
    if (input.jump && b.onGround) vy = p.jumpVelocity;
    else if (input.jump && vy <= p.swimSpeed && b.waterTime >= WATER_JUMP_AFTER_S && b.hitWall && wp.feet && !wp.head && nearSurface(w, b.pos))
      vy = waterJumpVelocity(p);
    else if (input.jump) vy = Math.max(p.swimSpeed, vy - p.gravity * h);
    else vy = Math.max(vy - (p.gravity * h) / 4, -p.swimSpeed);
    dy = vy * h;
  } else {
    if (input.jump && b.onGround) vy = p.jumpVelocity;
    const v1 = Math.max(vy - p.gravity * h, -p.maxFallSpeed);
    dy = ((vy + v1) / 2) * h;
    vy = v1;
  }

  // Collide: x, then z, then y (so `onGround` describes the final xz: stepping off an edge
  // and reporting ground there would be rejected).
  const stopX = sweep(w, b, 0, vx * h);
  const stopZ = sweep(w, b, 2, vz * h);
  const stopY = sweep(w, b, 1, dy);
  b.onGround = stopY && dy < 0;
  if (stopY) vy = 0;
  b.hitWall = stopX || stopZ;
  b.vel = [stopX ? 0 : vx, vy, stopZ ? 0 : vz];
  const after = waterProbe(w, roundPos(b.pos));
  b.inWater = after.feet || after.head;
  b.waterTime = b.inWater ? b.waterTime + h : 0;
}

/** What a move update reports for the body's current state. */
export type Sample = { pos: [number, number, number]; vel: [number, number, number]; onGround: boolean };

/** Position rounded to the nearest FP, velocity rounded (FP/s), `onGround`. */
export function sampleOf(b: Body): Sample {
  return { pos: roundPos(b.pos), vel: roundPos(b.vel), onGround: b.onGround };
}

/** Fixed-step driver with an accumulator (and render interpolation). */
export class PlayerPhysics {
  body: Body;
  input: Input = { ...NO_INPUT };
  yaw = 0;
  /** Unsimulated time, s (< STEP_S after `update`). */
  acc = 0;
  private prevPos: [number, number, number];

  constructor(
    pos: readonly number[],
    public params: PhysParams,
    public world: World,
  ) {
    this.body = newBody(pos);
    this.prevPos = [...this.body.pos];
  }

  /** Advances by a frame of `dt` seconds; returns the number of steps taken. */
  update(dt: number): number {
    this.acc += Math.min(Math.max(dt, 0), MAX_CATCHUP_S);
    let n = 0;
    while (this.acc >= STEP_S && n < MAX_STEPS_PER_UPDATE) {
      this.prevPos = [...this.body.pos];
      step(this.body, this.input, this.yaw, this.params, this.world);
      this.acc -= STEP_S;
      n++;
    }
    return n;
  }

  /** Puts the body at `pos` (FP) at rest (spawn, snap-back). */
  teleport(pos: readonly number[]) {
    this.body = newBody(pos);
    this.prevPos = [...this.body.pos];
    this.acc = 0;
  }

  /** Interpolated render position, FP. */
  renderPos(): [number, number, number] {
    const t = this.acc / STEP_S;
    const [a, b] = [this.prevPos, this.body.pos];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
}
