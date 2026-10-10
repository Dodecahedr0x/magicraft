import { describe, expect, it } from "vitest";
import { B } from "./blocks";
import { nearestTorches, scanTorches, TorchIndex, type TorchPos } from "./torches";

describe("torches", () => {
  it("scans torch blocks into world coords", () => {
    const b = new Uint8Array(16384);
    b[(10 * 16 + 3) * 16 + 2] = B.TORCH; // x 2, y 10, z 3
    b[(63 * 16 + 15) * 16 + 15] = B.TORCH;
    expect(scanTorches(b, -1, 2)).toEqual([
      [-14, 10, 35],
      [-1, 63, 47],
    ]);
  });

  it("selects the nearest N, nearest first", () => {
    const all: TorchPos[] = [];
    for (let i = 0; i < 40; i++) all.push([i * 2, 0, 0]);
    const p = [20.5, 0.5, 0.5];
    const got = nearestTorches(all, p, 16);
    expect(got).toHaveLength(16);
    expect(got[0]).toEqual([20, 0, 0]);
    // Brute force: every chosen torch is at least as near as every other one.
    const d = (t: TorchPos) => Math.hypot(t[0] + 0.5 - p[0], t[1] + 0.5 - p[1], t[2] + 0.5 - p[2]);
    const worstIn = Math.max(...got.map(d));
    for (const t of all) if (!got.includes(t)) expect(d(t)).toBeGreaterThanOrEqual(worstIn);
    for (let i = 1; i < got.length; i++) expect(d(got[i])).toBeGreaterThanOrEqual(d(got[i - 1]));
    for (let k = 0; k < 20; k++) {
      const q = [Math.random() * 80, Math.random() * 10, Math.random() * 5];
      const want = [...all].sort((a, b) => Math.hypot(a[0] + 0.5 - q[0], a[1] + 0.5 - q[1], a[2] + 0.5 - q[2]) - Math.hypot(b[0] + 0.5 - q[0], b[1] + 0.5 - q[1], b[2] + 0.5 - q[2])).slice(0, 16);
      expect(nearestTorches(all, q, 16)).toEqual(want);
    }
    expect(nearestTorches(all.slice(0, 3), p, 16)).toHaveLength(3);
  });

  it("index rescans invalidated chunks only", () => {
    const blocks = new Uint8Array(16384);
    const e = { key: "0,0", cx: 0, cz: 0, blocks };
    const idx = new TorchIndex({ entry: (k) => (k === "0,0" ? e : undefined), entries: () => [e] });
    expect(idx.pick([0, 0, 0])).toEqual([]);
    blocks[5] = B.TORCH;
    expect(idx.pick([0, 0, 0])).toEqual([]); // not invalidated yet
    idx.invalidate(["0,0"]);
    expect(idx.pick([0, 0, 0])).toEqual([[5, 0, 0]]);
    idx.invalidate(["0,0", "9,9"]);
    e.blocks = null as never;
    idx.invalidate(["0,0"]);
    expect(idx.count).toBe(0);
  });
});
