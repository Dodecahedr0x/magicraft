import { describe, expect, it } from "vitest";
import { B } from "./blocks";
import { BORDER, borderOf, CVOL, meshChunk, quadCount, waterHeight, type MeshArrays, type MeshInput } from "./mesher";

const idx = (x: number, y: number, z: number) => (y * 16 + z) * 16 + x;

function chunk(set: [number, number, number, number][] = []): Uint8Array {
  const b = new Uint8Array(CVOL);
  for (const [x, y, z, v] of set) b[idx(x, y, z)] = v;
  return b;
}
const input = (blocks: Uint8Array, borders: (Uint8Array | null)[] = [null, null, null, null]): MeshInput => ({ blocks, borders });

/** Quads per face normal ("+x", "-y", …). */
function byFace(m: MeshArrays) {
  const out: Record<string, number> = {};
  for (let q = 0; q < quadCount(m); q++) {
    const v = m.indices[q * 6];
    const n = [m.normals[v * 3], m.normals[v * 3 + 1], m.normals[v * 3 + 2]];
    const a = n.findIndex((c) => c !== 0);
    const k = `${n[a] > 0 ? "+" : "-"}${"xyz"[a]}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** Sum of quad areas (unit faces) for a mesh of axis-aligned quads. */
function area(m: MeshArrays) {
  let s = 0;
  for (let q = 0; q < quadCount(m); q++) {
    const i = m.indices.subarray(q * 6, q * 6 + 6);
    const p = (k: number) => [m.positions[k * 3], m.positions[k * 3 + 1], m.positions[k * 3 + 2]];
    const [a, b, c] = [p(i[0]), p(i[1]), p(i[2])];
    const ab = b.map((v, j) => v - a[j]);
    const ac = c.map((v, j) => v - a[j]);
    const cr = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    s += Math.hypot(...cr); // two triangles of equal area = |ab × ac|
  }
  return Math.round(s * 1000) / 1000;
}

describe("opaque greedy mesher", () => {
  it("single block: 6 faces, outward winding", () => {
    const m = meshChunk(input(chunk([[5, 10, 5, B.STONE]])));
    expect(quadCount(m.opaque)).toBe(6);
    expect(byFace(m.opaque)).toEqual({ "+x": 1, "-x": 1, "+y": 1, "-y": 1, "+z": 1, "-z": 1 });
    expect(quadCount(m.cutout) + quadCount(m.water)).toBe(0);
    // Every triangle's geometric normal (CCW) equals the stored normal.
    const o = m.opaque;
    for (let t = 0; t < o.indices.length / 3; t++) {
      const [i0, i1, i2] = o.indices.subarray(t * 3, t * 3 + 3);
      const p = (k: number) => [o.positions[k * 3], o.positions[k * 3 + 1], o.positions[k * 3 + 2]];
      const [a, b, c] = [p(i0), p(i1), p(i2)];
      const ab = b.map((v, j) => v - a[j]);
      const ac = c.map((v, j) => v - a[j]);
      const cr = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      const n = [o.normals[i0 * 3], o.normals[i0 * 3 + 1], o.normals[i0 * 3 + 2]];
      expect(cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2]).toBeGreaterThan(0);
    }
  });

  it("two adjacent blocks: shared faces culled (10 unit faces) and merged into 6 quads", () => {
    const m = meshChunk(input(chunk([[5, 10, 5, B.STONE], [6, 10, 5, B.STONE]])));
    expect(area(m.opaque)).toBe(10);
    expect(quadCount(m.opaque)).toBe(6);
  });

  it("different tiles are not merged", () => {
    const m = meshChunk(input(chunk([[5, 10, 5, B.STONE], [6, 10, 5, B.DIRT]])));
    expect(area(m.opaque)).toBe(10);
    expect(quadCount(m.opaque)).toBe(10);
  });

  it("a 16×16 floor merges into one quad per side", () => {
    const b = chunk();
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) b[idx(x, 10, z)] = B.STONE;
    const m = meshChunk(input(b));
    expect(quadCount(m.opaque)).toBe(6);
    expect(area(m.opaque)).toBe(256 * 2 + 16 * 4);
  });

  it("a filled chunk with all neighbors solid only shows its top", () => {
    const b = new Uint8Array(CVOL).fill(B.STONE);
    for (let y = 40; y < 64; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) b[idx(x, y, z)] = 0;
    const solid = new Uint8Array(BORDER).fill(B.STONE, 0, 40 * 16); // neighbors at the same height
    const m = meshChunk(input(b, [solid, solid, solid, solid]));
    expect(byFace(m.opaque)).toEqual({ "+y": 1 });
  });

  it("missing neighbors expose border faces; present neighbors cull them", () => {
    const b = chunk([[0, 10, 7, B.STONE]]); // on the west border
    const open = meshChunk(input(b));
    expect(byFace(open.opaque)["-x"]).toBe(1);
    const w = chunk([[15, 10, 7, B.DIRT]]); // the west neighbor's east column
    const culled = meshChunk(input(b, [null, null, null, borderOf(w, 2)]));
    expect(byFace(culled.opaque)["-x"]).toBeUndefined();
    expect(quadCount(culled.opaque)).toBe(5);
    // North border: neighbor N's south plane (lz = 15).
    const nb = chunk([[3, 5, 0, B.STONE]]);
    const n = chunk([[3, 5, 15, B.STONE]]);
    expect(byFace(meshChunk(input(nb, [borderOf(n, 1), null, null, null])).opaque)["-z"]).toBeUndefined();
    expect(byFace(meshChunk(input(nb)).opaque)["-z"]).toBe(1);
  });

  it("no faces below y = 0", () => {
    const m = meshChunk(input(chunk([[3, 0, 3, B.BEDROCK]])));
    expect(byFace(m.opaque)["-y"]).toBeUndefined();
    expect(quadCount(m.opaque)).toBe(5);
  });

  it("ambient occlusion breaks merges and darkens corners", () => {
    // A 3-wide floor with a block on top of the middle: the floor's top around it gets AO.
    const b = chunk([[4, 10, 4, B.STONE], [5, 10, 4, B.STONE], [6, 10, 4, B.STONE], [5, 11, 4, B.STONE]]);
    const m = meshChunk(input(b));
    const cols = m.opaque.colors;
    expect(Math.min(...cols)).toBeLessThan(Math.max(...cols));
  });
});

describe("cutout and water", () => {
  it("transparent next to opaque: opaque face drawn, cutout face hidden behind the opaque block", () => {
    const m = meshChunk(input(chunk([[5, 10, 5, B.STONE], [6, 10, 5, B.GLASS]])));
    expect(quadCount(m.opaque)).toBe(6); // the stone face toward the glass stays
    expect(quadCount(m.cutout)).toBe(5); // the glass face toward the stone is culled
  });

  it("glass–glass faces are culled, leaves–leaves are kept", () => {
    const g = meshChunk(input(chunk([[5, 10, 5, B.GLASS], [6, 10, 5, B.GLASS]])));
    expect(quadCount(g.cutout)).toBe(10);
    const l = meshChunk(input(chunk([[5, 10, 5, B.LEAVES], [6, 10, 5, B.LEAVES]])));
    expect(quadCount(l.cutout)).toBe(12);
  });

  it("cactus does not hide the sand under it; torch is a small stick", () => {
    const m = meshChunk(input(chunk([[5, 10, 5, B.SAND], [5, 11, 5, B.CACTUS], [8, 10, 8, B.TORCH]])));
    expect(quadCount(m.opaque)).toBe(6); // the sand top under the cactus is kept
    expect(quadCount(m.cutout)).toBe(5 + 5); // cactus (bottom on sand hidden) + torch (no bottom)
  });

  it("water heights by level", () => {
    expect(waterHeight(B.WATER_SOURCE, 0)).toBeCloseTo(14 / 16);
    expect(waterHeight(B.WATER_SOURCE, B.WATER_SOURCE)).toBe(1);
    expect(waterHeight(B.WATER_SOURCE + 3, 0)).toBeLessThan(waterHeight(B.WATER_SOURCE + 2, 0));
    expect(waterHeight(B.WATER7, 0)).toBeGreaterThan(0);
    const m = meshChunk(input(chunk([[5, 10, 5, B.WATER_SOURCE], [6, 10, 5, B.WATER_SOURCE + 4]])));
    const tops: number[] = [];
    const w = m.water;
    for (let v = 0; v < w.positions.length / 3; v++) if (w.normals[v * 3 + 1] === 1) tops.push(w.positions[v * 3 + 1]);
    expect(new Set(tops.map((t) => t.toFixed(4)))).toEqual(new Set([(10 + 14 / 16).toFixed(4), (10 + waterHeight(B.WATER_SOURCE + 4, 0)).toFixed(4)]));
    // Not merged: 2 tops; the source's side toward the lower cell shows only the step.
    expect(m.water.indices.length / 6).toBe(2 + 2 + 3 + 3 + 1);
  });

  it("water under water is full height; faces between water cells of equal level are hidden", () => {
    const m = meshChunk(input(chunk([[5, 10, 5, B.WATER_SOURCE], [5, 11, 5, B.WATER_SOURCE]])));
    // Lower: no top, 4 sides (full height), bottom. Upper: top + 4 sides, no bottom.
    expect(m.water.indices.length / 6).toBe(5 + 5);
    const ys = new Set<number>();
    for (let v = 0; v < m.water.positions.length / 3; v++) ys.add(m.water.positions[v * 3 + 1]);
    expect(ys.has(11)).toBe(true);
  });
});
