// Sky light for the mesher (Minecraft-style, levels 0..15): every cell open to the sky
// straight above gets 15 (minus what water / leaves on the way absorb), then light spreads
// to the 6 neighbors through non-opaque cells, losing 1 per step (+ the absorption of the
// cell it enters). Torches are separate (shader point lights, renderer.ts).
//
// Computed over the chunk plus a `MARGIN`-wide ring from its 8 neighbors (missing ones read
// as air: open sky), so light entering from a neighbor's cave mouth matches on both sides of
// the chunk border. Result: the levels of the mesher's padded volume (chunk ± 1 cell).
import { B, isFluid, OCCLUDES } from "./blocks";

const CW = 16;
const CH = 64;
/** Light reach beyond the chunk: 15 makes the border exact (a level-15 source 15 cells
 *  away has decayed to 0). */
export const MARGIN = 15;
const W = CW + 2 * MARGIN;
const PLANE = W * W;

/** Extra light a cell absorbs when light enters it (water dims faster, leaves a bit). */
const ABSORB = new Uint8Array(256);
for (let b = 0; b < 256; b++) ABSORB[b] = isFluid(b) ? 2 : b === B.LEAVES ? 1 : 0;

/** Brightness factor of a (possibly fractional) sky level: ≈ Minecraft's 0.8^(15 − l)
 *  curve, 1 at 15, ≈ 0.035 at 0. */
export const skyBrightness = (level: number) => Math.pow(0.8, 15 - level);

/** The 8 neighbors in `around` order: (dx, dz) for dz = −1..1, dx = −1..1, center skipped. */
export const AROUND: readonly [number, number][] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

/** Sky light levels of the padded volume `[(y + 1) * 18 + (z + 1)) * 18 + (x + 1)]` for
 *  x, z ∈ −1..16 and y ∈ −1..64 (y = −1 → 0, y = 64 → 15). `around`: the 8 neighbors'
 *  block arrays in `AROUND` order (null / missing → air). */
export function skyLight(blocks: Uint8Array, around?: readonly (Uint8Array | null)[]): Uint8Array {
  // Region blocks.
  const R = new Uint8Array(PLANE * CH);
  const src = (cdx: number, cdz: number): Uint8Array | null => {
    if (cdx === 0 && cdz === 0) return blocks;
    const i = AROUND.findIndex(([dx, dz]) => dx === cdx && dz === cdz);
    return around?.[i] ?? null;
  };
  for (let rz = 0; rz < W; rz++) {
    const z = rz - MARGIN;
    const cdz = z < 0 ? -1 : z >= CW ? 1 : 0;
    const lz = z - cdz * CW;
    for (let rx = 0; rx < W; rx++) {
      const x = rx - MARGIN;
      const cdx = x < 0 ? -1 : x >= CW ? 1 : 0;
      const s = src(cdx, cdz);
      if (!s) continue; // air
      const lx = x - cdx * CW;
      for (let y = 0; y < CH; y++) R[y * PLANE + rz * W + rx] = s[(y * CW + lz) * CW + lx];
    }
  }

  // Straight-down sky columns, then a bucketed flood (highest level first, so each cell is
  // expanded once at its final level).
  const L = new Uint8Array(PLANE * CH);
  const buckets: number[][] = Array.from({ length: 16 }, () => []);
  for (let c = 0; c < PLANE; c++) {
    let level = 15;
    for (let y = CH - 1; y >= 0 && level > 0; y--) {
      const i = y * PLANE + c;
      const b = R[i];
      if (OCCLUDES[b]) break;
      level = Math.max(0, level - ABSORB[b]);
      L[i] = level;
      if (level > 1) buckets[level].push(i);
    }
  }
  let level = 15;
  const spread = (n: number) => {
    const b = R[n];
    if (OCCLUDES[b]) return;
    const nl = level - 1 - ABSORB[b];
    if (nl > L[n]) {
      L[n] = nl;
      if (nl > 1) buckets[nl].push(n);
    }
  };
  for (; level > 1; level--) {
    const q = buckets[level];
    for (let k = 0; k < q.length; k++) {
      const i = q[k];
      if (L[i] !== level) continue;
      const y = (i / PLANE) | 0;
      const c = i - y * PLANE;
      const rz = (c / W) | 0;
      const rx = c - rz * W;
      if (rx > 0) spread(i - 1);
      if (rx < W - 1) spread(i + 1);
      if (rz > 0) spread(i - W);
      if (rz < W - 1) spread(i + W);
      if (y > 0) spread(i - PLANE);
      if (y < CH - 1) spread(i + PLANE);
    }
    q.length = 0;
  }

  // Padded volume (chunk ± 1).
  const PX = CW + 2;
  const out = new Uint8Array(PX * PX * (CH + 2));
  out.fill(15, (CH + 1) * PX * PX);
  for (let y = 0; y < CH; y++)
    for (let z = -1; z <= CW; z++)
      for (let x = -1; x <= CW; x++)
        out[((y + 1) * PX + (z + 1)) * PX + (x + 1)] = L[y * PLANE + (z + MARGIN) * W + (x + MARGIN)];
  return out;
}
