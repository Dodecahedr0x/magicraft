import { describe, expect, it } from "vitest";
import { blockFlags } from "../wasm";
import { placePresenceChunks } from "./presence";
import { SlotSelect, actionMessage, optimisticEdit, type EditStore } from "./interact";
import type { SendResult } from "../chain";
import { blockInReach, boxOverlapsBlock, mobInReach, nearestStation, pickMob, placeError, raycast, rayBox, within, type PlaceInput } from "./rules";
import type { V3 } from "../chain";

const B = 256;
/** Feet at the center of block column (x, z), standing at y (as in the program's tests). */
const feet = (x: number, y: number, z: number): V3 => [x * B + 128, y * B, z * B + 128];

/** A sparse world: listed blocks, air elsewhere, unknown (null) outside |x|,|z| ≤ 64. */
function world(blocks: [number, number, number, number][]) {
  const m = new Map(blocks.map(([x, y, z, b]) => [`${x},${y},${z}`, b]));
  return (x: number, y: number, z: number): number | null => {
    if (Math.abs(x) > 64 || Math.abs(z) > 64 || y < 0) return null;
    return m.get(`${x},${y},${z}`) ?? 0;
  };
}
const solid = (id: number) => id !== 0;

describe("raycast (DDA)", () => {
  const get = world([
    [5, 10, 0, 3],
    [-3, 10, -3, 3],
    [0, 7, 0, 2],
    [2, 10, 2, 1],
  ]);

  it("axis-aligned hits with the entry face", () => {
    const h = raycast([0.5, 10.5, 0.5], [1, 0, 0], 10, get, solid)!;
    expect(h.block).toEqual([5, 10, 0]);
    expect(h.face).toEqual([-1, 0, 0]);
    expect(h.dist).toBeCloseTo(4.5);
    // Straight down onto the top face.
    const d = raycast([0.5, 10.5, 0.5], [0, -1, 0], 10, get, solid)!;
    expect(d.block).toEqual([0, 7, 0]);
    expect(d.face).toEqual([0, 1, 0]);
    expect(d.dist).toBeCloseTo(2.5);
  });

  it("diagonal and negative coordinates", () => {
    // Toward (-3, 10, -3) from (0.5, 10.5, 0.5): crosses x and z boundaries alternately.
    const h = raycast([0.5, 10.5, 0.5], [-1, 0, -1], 10, get, solid)!;
    expect(h.block).toEqual([-3, 10, -3]);
    expect(Math.abs(h.face[0]) + Math.abs(h.face[2])).toBe(1);
    expect(h.dist).toBeCloseTo(Math.hypot(2.5, 2.5) + 0, 0);
    // Diagonal in xz toward (2, 10, 2) through the corner region.
    const g = raycast([0.2, 10.5, 0.9], [1, 0, 0.8], 10, get, solid)!;
    expect(g.block).toEqual([2, 10, 2]);
    // Negative-coordinate origin and unit vectors not normalized.
    const n = raycast([-0.5, 10.5, -2.5], [-10, 0, 0], 10, get, solid)!;
    expect(n.block).toEqual([-3, 10, -3]);
    expect(n.face).toEqual([1, 0, 0]);
  });

  it("respects the max distance and stops at unknown voxels", () => {
    expect(raycast([0.5, 10.5, 0.5], [1, 0, 0], 4.4, get, solid)).toBeNull();
    expect(raycast([0.5, 10.5, 0.5], [1, 0, 0], 4.5, get, solid)?.block).toEqual([5, 10, 0]);
    // Into unloaded space (|x| > 64) the ray stops without a hit even if solid lies beyond.
    expect(raycast([60.5, 10.5, 0.5], [1, 0, 0], 50, get, solid)).toBeNull();
    // Zero direction.
    expect(raycast([0.5, 10.5, 0.5], [0, 0, 0], 5, get, solid)).toBeNull();
  });

  it("starting inside a block hits it with no face", () => {
    const h = raycast([5.5, 10.5, 0.5], [1, 0, 0], 5, get, solid)!;
    expect(h.block).toEqual([5, 10, 0]);
    expect(h.face).toEqual([0, 0, 0]);
    expect(h.dist).toBe(0);
  });

  it("face normals for each axis direction", () => {
    const g = world([
      [0, 20, 0, 3],
    ]);
    const cases: [number[], number[], V3][] = [
      [[-2.5, 20.5, 0.5], [1, 0, 0], [-1, 0, 0]],
      [[3.5, 20.5, 0.5], [-1, 0, 0], [1, 0, 0]],
      [[0.5, 23.5, 0.5], [0, -1, 0], [0, 1, 0]],
      [[0.5, 17.5, 0.5], [0, 1, 0], [0, -1, 0]],
      [[0.5, 20.5, -2.5], [0, 0, 1], [0, 0, -1]],
      [[0.5, 20.5, 3.5], [0, 0, -1], [0, 0, 1]],
    ];
    for (const [o, d, f] of cases) expect(raycast(o, d, 10, g, solid)?.face).toEqual(f);
  });
});

describe("reach rules (parity with actions.rs tests)", () => {
  it("within is Euclidean and total", () => {
    expect(within([3, 4, 0], 5)).toBe(true);
    expect(within([3, 4, 1], 5)).toBe(false);
    expect(within([0, 0, 0], 0)).toBe(true);
    expect(within([1, 0, 0], -5)).toBe(false);
  });

  it("block reach from the eye", () => {
    const reach = 5 * B;
    const p = feet(0, 40, 0);
    expect(blockInReach(p, [0, 39, 0], reach)).toBe(true);
    expect(blockInReach(p, [5, 41, 0], reach)).toBe(true);
    expect(blockInReach(p, [6, 41, 0], reach)).toBe(false);
    expect(blockInReach(p, [0, 35, 0], reach)).toBe(false);
    expect(blockInReach(p, [0, 36, 0], reach)).toBe(true);
    expect(blockInReach(p, [2 ** 31 - 1, 0, -(2 ** 31)], 16 * B)).toBe(false);
  });

  it("matches an exact integer (BigInt) model of the program on random cases", () => {
    const exact = (pos: number[], b: number[], reach: number) => {
      const d = [BigInt(b[0] * 256 + 128 - pos[0]), BigInt(b[1] * 256 + 128 - pos[1] - 415), BigInt(b[2] * 256 + 128 - pos[2])];
      const r = BigInt(reach + 128);
      if (d.some((v) => (v < 0n ? -v : v) > r)) return false;
      return d.reduce((s, v) => s + v * v, 0n) <= r * r;
    };
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let i = 0; i < 5000; i++) {
      const pos = [rnd(4096) - 2048, rnd(64 * 256), rnd(4096) - 2048];
      const b = [Math.floor(pos[0] / 256) + rnd(15) - 7, Math.floor(pos[1] / 256) + rnd(15) - 7, Math.floor(pos[2] / 256) + rnd(15) - 7];
      const reach = 256 + rnd(15 * 256);
      expect(blockInReach(pos, b, reach)).toBe(exact(pos, b, reach));
    }
  });

  it("mob reach to the column", () => {
    const p = feet(0, 40, 0);
    expect(mobInReach(p, feet(3, 40, 0))).toBe(true);
    expect(mobInReach(p, feet(4, 40, 0))).toBe(false);
    expect(mobInReach(p, feet(2, 38, 0))).toBe(true);
    expect(mobInReach(p, feet(0, 30, 0))).toBe(false);
  });

  it("overlap box", () => {
    const p = feet(5, 40, 5);
    expect(boxOverlapsBlock(p, [5, 40, 5])).toBe(true);
    expect(boxOverlapsBlock(p, [5, 41, 5])).toBe(true);
    expect(boxOverlapsBlock(p, [5, 39, 5])).toBe(false);
    expect(boxOverlapsBlock(p, [5, 42, 5])).toBe(false);
    expect(boxOverlapsBlock(p, [6, 40, 5])).toBe(false);
    expect(boxOverlapsBlock(p, [5, 40, 4])).toBe(false);
    expect(boxOverlapsBlock([5 * B + 200, 40 * B, 5 * B + 128], [6, 40, 5])).toBe(true);
    const up: V3 = [5 * B + 128, 40 * B + 307, 5 * B + 128];
    expect(boxOverlapsBlock(up, [5, 40, 5])).toBe(false);
    expect(boxOverlapsBlock(up, [5, 41, 5])).toBe(true);
    expect(boxOverlapsBlock(feet(-1, 40, -1), [-1, 41, -1])).toBe(true);
    expect(boxOverlapsBlock(feet(-1, 40, -1), [0, 41, -1])).toBe(false);
    expect(boxOverlapsBlock([-10, 40 * B, 128], [0, 40, 0])).toBe(true);
  });

  it("presence chunks = own chunk + needed_neighbors order", () => {
    expect(placePresenceChunks(5, 5)).toEqual([[0, 0]]);
    expect(placePresenceChunks(16, 31)).toEqual([[1, 1], [0, 1], [1, 2], [0, 2]]);
    expect(placePresenceChunks(-1, 3)).toEqual([[-1, 0], [0, 0]]);
    expect(placePresenceChunks(7, -16)).toEqual([[0, -1], [0, -2]]);
  });
});

describe("placement checks", () => {
  const flags = blockFlags();
  // Floor of stone at y = 9 around the origin, water at (3, 10, 0), a torch at (0, 10, 3).
  const floor: [number, number, number, number][] = [];
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) floor.push([x, 9, z, 3]);
  floor.push([3, 10, 0, 23], [0, 10, 3, 17]);
  const base = (over: Partial<PlaceInput> = {}): PlaceInput => ({
    target: [2, 10, 0],
    block: 2,
    empty: false,
    pos: feet(0, 10, 0),
    others: [],
    reach: 5 * B,
    get: world(floor),
    flags,
    ...over,
  });

  it("accepts a supported, free, reachable target", () => {
    expect(placeError(base())).toBeNull();
    // Replacing water is allowed.
    expect(placeError(base({ target: [3, 10, 0] }))).toBeNull();
  });

  it("rejects in the program's order", () => {
    expect(placeError(base({ target: [2, 64, 0] }))).toBe("InvalidTarget");
    expect(placeError(base({ target: [9, 10, 0] }))).toBe("OutOfReach");
    expect(placeError(base({ empty: true, block: -1 }))).toBe("EmptySlot");
    expect(placeError(base({ block: -1 }))).toBe("NotPlaceable");
    expect(placeError(base({ target: [2, 9, 0] }))).toBe("InvalidTarget"); // stone there
    expect(placeError(base({ target: [0, 10, 3] }))).toBe("InvalidTarget"); // torch is not replaceable
    expect(placeError(base({ target: [2, 12, 0] }))).toBe("NotFaceAdjacent"); // mid-air
    expect(placeError(base({ target: [99, 10, 0], reach: 16 * B, pos: feet(96, 10, 0) }))).toBe("ChunkNotReady");
  });

  it("support across an unknown chunk does not count", () => {
    // Block at x = 64 next to unknown x = 65 (null): only its own floor supports it.
    const get = world([[64, 9, 0, 3]]);
    expect(placeError(base({ target: [64, 10, 0], pos: feet(62, 10, 0), get }))).toBeNull();
    const get2 = world([]);
    expect(placeError(base({ target: [64, 10, 0], pos: feet(62, 10, 0), get: get2 }))).toBe("NotFaceAdjacent");
  });

  it("no overlap with the placer or fresh players (solid blocks only)", () => {
    expect(placeError(base({ target: [0, 10, 0] }))).toBe("SelfOverlap");
    expect(placeError(base({ target: [0, 11, 0], get: world([...floor, [0, 12, 0, 3]]) }))).toBe("SelfOverlap");
    // Another player standing on the target column.
    expect(placeError(base({ others: [feet(2, 10, 0)] }))).toBe("SelfOverlap");
    // A torch (not solid) may be placed where a player stands.
    expect(placeError(base({ target: [0, 10, 0], block: 17 }))).toBeNull();
  });
});

describe("mobs and stations", () => {
  it("ray vs box and nearest mob", () => {
    expect(rayBox([0, 0, 0], [1, 0, 0], [2, -1, -1], [3, 1, 1])).toBeCloseTo(2);
    expect(rayBox([0, 0, 0], [-1, 0, 0], [2, -1, -1], [3, 1, 1])).toBeNull();
    expect(rayBox([2.5, 0, 0], [1, 0, 0], [2, -1, -1], [3, 1, 1])).toBe(0);
    const mobs = [
      { cx: 0, cz: 0, idx: 0, kind: 1, hp: 10, pos: feet(4, 10, 0) },
      { cx: 0, cz: 0, idx: 1, kind: 4, hp: 20, pos: feet(2, 10, 0) },
      { cx: 0, cz: 0, idx: 2, kind: 2, hp: 10, pos: feet(2, 10, 3) },
    ];
    const eye = [0.5, 11.62, 0.5];
    const hit = pickMob(eye, [1, -0.1, 0], 6, mobs)!;
    expect(hit.mob.idx).toBe(1);
    expect(pickMob(eye, [1, -0.1, 0], 1.5, mobs)).toBeNull();
    expect(pickMob(eye, [0, 1, 0], 6, mobs)).toBeNull();
  });

  it("nearest station within reach", () => {
    const get = world([
      [3, 10, 0, 15],
      [-1, 10, 1, 15],
      [9, 10, 0, 16],
    ]);
    const p = feet(0, 10, 0);
    expect(nearestStation(p, 5 * B, 15, get)).toEqual([-1, 10, 1]);
    expect(nearestStation(p, 5 * B, 16, get)).toBeNull();
    expect(nearestStation(p, 10 * B, 16, get)).toEqual([9, 10, 0]);
  });
});

describe("held slot sync", () => {
  it("debounces selections and syncs before use", async () => {
    const sent: number[] = [];
    const sel = new SlotSelect(async (s) => {
      sent.push(s);
      return { status: "confirmed", sig: "x", ms: 1 };
    }, 20);
    sel.onPlayerState(4);
    expect(sel.selected).toBe(4);
    expect(sel.chainHeld).toBe(4);
    sel.select(5);
    sel.select(6);
    sel.select(-1); // wraps to 8
    expect(sel.selected).toBe(8);
    expect(await sel.sync()).toBe(true);
    expect(sent).toEqual([8]);
    expect(sel.chainHeld).toBe(8);
    await new Promise((r) => setTimeout(r, 40));
    expect(sent).toEqual([8]); // the debounce timer was cancelled by sync()
    // A held slot outside the hotbar is replaced by slot 0.
    const sel2 = new SlotSelect(async (s) => (sent.push(s), { status: "confirmed", sig: "y", ms: 1 }), 0);
    sel2.onPlayerState(20);
    expect(sel2.selected).toBe(0);
    expect(await sel2.sync()).toBe(true);
  });

  it("maps failures to short messages", () => {
    expect(actionMessage({ kind: "retry", name: "Cooldown", message: "" }, "Breaking")).toBeNull();
    expect(actionMessage({ kind: "other", name: "OutOfReach", message: "" }, "Breaking")).toBe("Too far away.");
    expect(actionMessage({ kind: "other", name: "MissingInputs", message: "" }, "Crafting")).toBe("Missing ingredients.");
    expect(actionMessage({ kind: "other", name: "NoMob", message: "" }, "Attack")).toBeNull();
    expect(actionMessage({ kind: "timeout", message: "" }, "Placing")).toMatch(/may still land/);
    expect(actionMessage({ kind: "other", name: "Weird", message: "" }, "Placing")).toBe("Placing failed (Weird).");
  });
});

describe("optimistic edits (mock sender)", () => {
  /** A one-voxel store recording the overlay calls. */
  function fakeStore(initial = 3) {
    let byte = initial;
    let seq = 0;
    const log: string[] = [];
    const store: EditStore = {
      setLocal: (_x, _y, _z, b) => {
        const old = byte;
        byte = b;
        log.push(`set ${b}`);
        return { seq: ++seq, old };
      },
      clearLocal: (_x, _y, _z, s) => void log.push(`clear ${s}`),
      revertLocal: (_x, _y, _z, s, old) => {
        byte = old;
        log.push(`revert ${s}`);
      },
    };
    return { store, log, byte: () => byte };
  }
  const ok: SendResult = { status: "confirmed", sig: "s", ms: 1 };
  const fail = (kind: "retry" | "other", name: string): SendResult => ({ status: "failed", error: { kind, name, message: name } });
  const sender = (...rs: SendResult[]) => {
    let i = 0;
    const f = async () => rs[Math.min(i++, rs.length - 1)];
    return Object.assign(f, { calls: () => i });
  };

  it("break confirmed: the local air is kept, then dropped from the overlay", async () => {
    const f = fakeStore();
    const r = await optimisticEdit({ store: f.store, at: [1, 2, 3], block: 0, send: sender(ok) });
    expect(r?.status).toBe("confirmed");
    expect(f.log).toEqual(["set 0", "clear 1"]);
    expect(f.byte()).toBe(0);
  });

  it("break rejected (OutOfReach): rolled back", async () => {
    const f = fakeStore();
    const r = await optimisticEdit({ store: f.store, at: [1, 2, 3], block: 0, send: sender(fail("other", "OutOfReach")) });
    expect(r?.status).toBe("failed");
    expect(f.log).toEqual(["set 0", "revert 1"]);
    expect(f.byte()).toBe(3);
  });

  it("cooldown is retried silently, keeping the local edit", async () => {
    const f = fakeStore();
    const send = sender(fail("retry", "Cooldown"), fail("retry", "Cooldown"), ok);
    let retries = 0;
    const r = await optimisticEdit({ store: f.store, at: [1, 2, 3], block: 0, send, retryMs: 1, onRetry: () => retries++ });
    expect(r?.status).toBe("confirmed");
    expect(send.calls()).toBe(3);
    expect(retries).toBe(2);
    expect(f.log).toEqual(["set 0", "clear 1"]);
  });

  it("cooldown retries are bounded, then rolled back", async () => {
    const f = fakeStore();
    const send = sender(fail("retry", "Cooldown"));
    const r = await optimisticEdit({ store: f.store, at: [1, 2, 3], block: 0, send, retryMs: 1, maxRetries: 3 });
    expect(r?.status).toBe("failed");
    expect(send.calls()).toBe(4);
    expect(f.log).toEqual(["set 0", "revert 1"]);
  });

  it("place rejected (SelfOverlap): the placed block is removed again", async () => {
    const f = fakeStore(0);
    const r = await optimisticEdit({ store: f.store, at: [1, 2, 3], block: 11, send: sender(fail("other", "SelfOverlap")), maxRetries: 0 });
    expect(r?.status).toBe("failed");
    expect(f.byte()).toBe(0);
    expect(f.log).toEqual(["set 11", "revert 1"]);
  });

  it("nothing is sent when the chunk isn't ready locally", async () => {
    const send = sender(ok);
    const store: EditStore = { setLocal: () => null, clearLocal: () => {}, revertLocal: () => {} };
    expect(await optimisticEdit({ store, at: [1, 2, 3], block: 0, send })).toBeNull();
    expect(send.calls()).toBe(0);
  });
});
