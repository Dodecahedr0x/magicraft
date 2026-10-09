import { describe, expect, it } from "vitest";
import { DEFAULT_WORLD_PARAMS } from "../chain/layout";
import { moveWindow } from "../chain/actions";
import { checkMove, coreMoveWindow, defaultParamsBytes, physicsConstants, spawnState } from "../wasm";
import { BODY_H, FEET_EPS, FP, HALF_W, PlayerPhysics, sampleOf } from "./physics";
import { encodeParams } from "./sync";
import { ChunkWorld, coreBlock, fp, PARAMS, runClient, type Script } from "./testkit";

const B = FP;
const bf = (b: number, f = 0) => b * B + f;
/** Core test `HOME`: (5.5, 10, 5.5). */
const HOME = [bf(5, 128), bf(10), bf(5, 128)];
const YAW_PX = -Math.PI / 2; // forward = +x
const YAW_NX = Math.PI / 2; // forward = −x
const YAW_PZ = Math.PI; // forward = +z

const world = () => new ChunkWorld();

describe("wasm core", () => {
  it("params encode like the core and move_window matches the TS port", () => {
    expect([...encodeParams(DEFAULT_WORLD_PARAMS)]).toEqual([...defaultParamsBytes()]);
    const cases = [
      [HOME, HOME],
      [[10, 2560, 10], [10, 2560, 10]],
      [[128, 0, 128], [20 * 256, 0, 128]],
      [[128, 0, 128], [40 * 256, 0, 128]],
      [[-4000, 0, 4090], [-4200, 0, 4200]],
    ];
    for (const [a, b] of cases) expect(coreMoveWindow(a, b)).toEqual(moveWindow(a, b));
    const [halfW, feetEps, bodyH] = physicsConstants();
    expect([feetEps, bodyH]).toEqual([FEET_EPS, BODY_H]);
    expect(HALF_W).toBeGreaterThan(halfW);
  });

  it("check_move mirrors core cases: walk ok, teleport / into stone rejected, 10-block fall = 7", () => {
    const w = world();
    const p = defaultParamsBytes();
    const prev = spawnState(HOME, 1000, true);
    const q = w.quad(0, 0);
    expect(checkMove(p, prev, [HOME[0] + 100, HOME[1], HOME[2]], [0, 0, 0], true, 1125, 1125, q).ok).toBe(true);
    expect(checkMove(p, prev, [HOME[0] + 3 * 179, HOME[1], HOME[2]], [0, 0, 0], true, 1125, 1125, q)).toEqual({ ok: false, error: "MoveTooFast" });
    const atWall = spawnState([bf(19, 154), bf(10), bf(5)], 0, true);
    expect(checkMove(p, atWall, [bf(19, 205), bf(10), bf(5)], [0, 0, 0], true, 125, 125, w.quad(0, 0))).toEqual({ ok: false, error: "Collision" });
    // falling_ten_blocks_deals_seven: airborne from support y 20 (tower column).
    const air = spawnState([bf(-9, 128), bf(10, 154), bf(5)], 1000, false);
    // Patch fall_start_y / support_y (offsets 40 / 44) and support_ms (8) like `airborne()`.
    const v = new DataView(air.buffer);
    v.setInt32(40, bf(20), true);
    v.setInt32(44, bf(20), true);
    v.setBigInt64(8, 200n, true);
    const r = checkMove(p, air, [bf(-9, 128), bf(10), bf(5)], [0, 0, 0], true, 1125, 1125, w.quad(-1, 0));
    expect(r.ok && r.fallDamage).toBe(7);
  });
});

describe("client physics (parity with core tests)", () => {
  it("stands still on the ground", () => {
    const r = runClient(world(), HOME, 120, () => ({}));
    expect(r.rejected).toEqual([]);
    expect(r.phys.body.pos).toEqual(HOME);
    expect(r.phys.body.onGround).toBe(true);
  });

  it("walks 4.3 and sprints 5.6 blocks per second", () => {
    for (const [sprint, speed] of [
      [false, PARAMS.walkSpeed],
      [true, PARAMS.sprintSpeed],
    ] as const) {
      const start = [bf(-5), bf(10), bf(-20, 128)];
      const r = runClient(world(), start, 120, () => ({ forward: true, sprint, yaw: YAW_PZ }));
      expect(r.rejected).toEqual([]);
      const dist = (r.phys.body.pos[2] - start[2]) / FP;
      expect(dist).toBeCloseTo((2 * speed) / FP, 3);
    }
  });

  it("walking into stone is blocked at the face", () => {
    // Wall at x = 20.
    const r = runClient(world(), [bf(17, 128), bf(10), bf(5)], 120, () => ({ forward: true, sprint: true, yaw: YAW_PX }));
    expect(r.rejected).toEqual([]);
    expect(r.phys.body.pos[0]).toBeCloseTo(20 * B - HALF_W, 6);
    expect(r.phys.body.hitWall).toBe(true);
  });

  it("a one-block step needs a jump (no auto step-up)", () => {
    const start = [bf(28, 128), bf(10), bf(5, 128)];
    const walk = runClient(world(), start, 90, () => ({ forward: true, yaw: YAW_PX }));
    expect(walk.rejected).toEqual([]);
    expect(walk.phys.body.pos[1]).toBe(bf(10));
    expect(walk.phys.body.pos[0]).toBeCloseTo(30 * B - HALF_W, 6);
    const jump = runClient(world(), start, 50, (f) => ({ forward: true, jump: f > 10 && f < 20, yaw: YAW_PX }));
    expect(jump.rejected).toEqual([]);
    expect(jump.phys.body.pos[1]).toBe(bf(11));
    expect(jump.phys.body.onGround).toBe(true);
    expect(jump.phys.body.pos[0]).toBeGreaterThan(bf(30));
  });

  it("walking off the 10-block tower costs 7 (computed by the core)", () => {
    const r = runClient(world(), [bf(-12, 0), bf(20), bf(5, 0)], 150, () => ({ forward: true, yaw: YAW_PX }));
    expect(r.rejected).toEqual([]);
    expect(r.fallDamage).toBe(7);
    expect(r.phys.body.pos[1]).toBe(bf(10));
  });

  it("swims at swim speed (2 b/s) in water", () => {
    const start = [bf(-39, 128), bf(8), bf(5, 128)];
    const r = runClient(world(), start, 60, () => ({ forward: true, sprint: true, yaw: YAW_PX }), 8, { onGround: false });
    expect(r.rejected).toEqual([]);
    expect(r.phys.body.inWater).toBe(true);
    expect((r.phys.body.pos[0] - start[0]) / FP).toBeCloseTo(PARAMS.swimSpeed / FP, 3);
  });

  it("jump apex ≈ 1.25 blocks, never above v²/2g", () => {
    const phys = new PlayerPhysics(HOME, PARAMS, world().physWorld());
    phys.update(1 / 60);
    phys.input = { ...phys.input, jump: true };
    let max = 0;
    for (let i = 0; i < 60; i++) {
      phys.update(1 / 60);
      phys.input = { ...phys.input, jump: false };
      max = Math.max(max, phys.body.pos[1] - HOME[1]);
    }
    const h = (PARAMS.jumpVelocity * PARAMS.jumpVelocity) / (2 * PARAMS.gravity);
    expect(max).toBeLessThanOrEqual(h);
    expect(max / FP).toBeGreaterThan(1.22);
    expect(phys.body.pos[1]).toBe(HOME[1]);
  });

  it("standing on a block edge reports ground the core accepts", () => {
    // Overlapping the step by < 1/256 block.
    const r = runClient(world(), [bf(30) - 76, bf(11), bf(5)], 60, () => ({}));
    expect(r.rejected).toEqual([]);
    expect(r.checks.every((c) => c.onGround)).toBe(true);
  });
});

// ---------------------------------------------------------------- the key parity test

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bumpy terrain with walls, pillars, an overhang lane, pools, puddles, a pit and a cliff. */
function bumpy(x: number, y: number, z: number): number {
  if (y < 0) return 8;
  const h = (x: number, z: number) => {
    const n = ((x * 73856093) ^ (z * 19349663)) >>> 0;
    if (x >= -6 && x <= 6 && z >= -6 && z <= 6) return 10; // flat start
    if (x >= 20 && x <= 30 && z >= -10 && z <= 10) return 4; // pit: 6 deep
    if (x <= -20 && z >= 10) return 18; // plateau (8-block cliff)
    return 10 + (n % 7 === 0 ? 1 : 0) + (n % 31 === 0 ? 1 : 0);
  };
  const top = h(x, z);
  if (x >= -15 && x <= -8 && z >= -15 && z <= -8) return y < 6 ? 3 : y < 10 ? 23 : 0; // pool 4 deep
  if (y < top) return 3;
  if (y === top && (x * 7 + z * 3) % 13 === 0 && top === 10 && Math.abs(x) > 6) return 30; // puddle
  if (x === 12 && z >= -4 && z <= 4 && y === top + 2) return 3; // overhang at head height
  if (z === -18 && x >= -12 && x <= 12 && y >= top && y < top + 3) return 3; // wall
  if ((x === 8 || x === -8) && (z === 8 || z === -3) && y >= top && y < top + 4) return 9; // pillars
  return 0;
}

describe("60 fps client vs check_move at 8 Hz", () => {
  const scenarios: [string, ChunkWorld, number[], number, Script][] = [
    ["sprint bunny-hop on flat ground", world(), [bf(0, 128), bf(10), bf(5, 128)], 180, () => ({ forward: true, sprint: true, jump: true, yaw: YAW_PX })],
    ["bunny-hop up the stairs", world(), [bf(46), bf(10), bf(5)], 240, () => ({ forward: true, sprint: true, jump: true, yaw: YAW_PX })],
    ["walk off the tower", world(), [bf(-12), bf(20), bf(5)], 120, () => ({ forward: true, yaw: YAW_PX })],
    ["sprint off the tower jumping", world(), [bf(-13), bf(20), bf(5)], 120, () => ({ forward: true, sprint: true, jump: true, yaw: YAW_PX })],
    ["run into the pit", world(), [bf(66, 128), bf(19), bf(5)], 150, () => ({ forward: true, sprint: true, yaw: YAW_PX })],
    ["jump onto the step and the platform", world(), [bf(27), bf(10), bf(5)], 240, (f) => ({ forward: true, jump: f % 40 > 30, yaw: YAW_PX })],
    ["jump under the overhang", world(), [bf(23, 128), bf(10), bf(5)], 180, () => ({ forward: true, jump: true, yaw: YAW_PX })],
    ["slide along the wall diagonally", world(), [bf(17), bf(10), bf(-5)], 180, () => ({ forward: true, sprint: true, yaw: -Math.PI / 4 - Math.PI / 2 })],
    ["walk into the pool, swim across, climb out", world(), [bf(-29, 128), bf(10), bf(5, 128)], 600, () => ({ forward: true, jump: true, yaw: YAW_NX })],
    ["sink in the pool, then swim up", world(), [bf(-35, 128), bf(10), bf(5, 128)], 300, (f) => ({ jump: f > 150 })],
    ["puddles and the shallow pond", world(), [bf(-2, 128), bf(10), bf(25)], 480, (f) => ({ forward: true, sprint: f % 120 < 60, jump: f % 90 < 10, yaw: YAW_NX * (f > 240 ? 1 : -1) })],
    ["leaves canopy (bonk)", world(), [bf(8), bf(10), bf(22)], 180, () => ({ forward: true, jump: true, yaw: YAW_PX })],
  ];
  for (const [name, w, start, frames, script] of scenarios)
    it(name, () => {
      const r = runClient(w, start, frames, script);
      expect(r.rejected).toEqual([]);
      expect(r.checks.length).toBe(Math.floor(frames / 8));
    });

  it("walking off ledges and stairs down", () => {
    const r = runClient(world(), [bf(69, 128), bf(20), bf(5)], 120, () => ({ forward: true, sprint: true, yaw: YAW_NX }));
    expect(r.rejected).toEqual([]);
  });

  /** Random input (direction, yaw, jump, sprint changes every 0.3 s) on bumpy terrain. */
  const randomPlay = (seed: number, frames: number, every: number) => {
    const w = new ChunkWorld(bumpy, 4);
    const rand = rng(seed);
    let inp: ReturnType<Script> = {};
    let yaw = rand() * 6.28;
    return runClient(
      w,
      [bf(0, 128), bf(10), bf(0, 128)],
      frames,
      (f, phys) => {
        if (f % 18 === 1) {
          yaw += (rand() - 0.5) * 2;
          inp = { forward: rand() < 0.8, back: rand() < 0.1, left: rand() < 0.2, right: rand() < 0.2, jump: rand() < 0.4, sprint: rand() < 0.6 };
        }
        // Stay inside the generated area.
        const [x, , z] = phys.body.pos.map((v) => v / FP);
        if (Math.abs(x) > 50 || Math.abs(z) > 50) yaw = Math.atan2(x, z);
        return { ...inp, yaw };
      },
      every,
      { fallback: true },
    );
  };

  // Bumps, pillars and walls: sliding around a corner or landing on a bump for one frame
  // between two updates can make the *newest* frame unacceptable (the program samples a
  // straight line / only sees surfaces under the two endpoints); the sync layer's frame
  // choice (`chooseFrame`) then sends a landing or earlier frame. With it, nothing is
  // rejected.
  it("random play on bumpy terrain at 8 Hz: no update rejected (sync frame choice)", () => {
    let total = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const r = randomPlay(seed, 60 * 40, 8);
      expect(r.rejected, `seed ${seed}`).toEqual([]);
      total += r.checks.length;
    }
    expect(total).toBe(16 * 300);
  });

  it("random play at ~4 Hz and ~2 Hz (slow round trips): no update rejected", () => {
    for (const every of [15, 30])
      for (let seed = 1; seed <= 6; seed++) expect(randomPlay(100 + seed, 60 * 30, every).rejected, `every ${every} seed ${seed}`).toEqual([]);
  });

  it("coreBlock mirrors the core test world", () => {
    expect(coreBlock(20, 11, 0)).toBe(3);
    expect(coreBlock(-35, 8, 5)).toBe(23);
    expect(coreBlock(5, 9, 5)).toBe(3);
    expect(coreBlock(5, 10, 5)).toBe(0);
    expect(fp(1.5)).toBe(384);
    expect(sampleOf(new PlayerPhysics(HOME, PARAMS, world().physWorld()).body).pos).toEqual(HOME);
  });
});

