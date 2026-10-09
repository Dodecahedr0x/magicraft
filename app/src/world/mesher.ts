// Chunk mesher (pure TS; runs in a Web Worker via mesher.worker.ts, and in tests).
//
// Input: a chunk's 16 384 block bytes (index `(y * 16 + lz) * 16 + lx`) and the facing
// border planes of its 4 side neighbors (N = cz−1, S = cz+1, E = cx+1, W = cx−1; each
// 64 × 16 bytes, see `borderOf`). Output: three meshes in chunk-local block units —
//
// - `opaque`: greedy-meshed full cubes. Faces are culled against occluding neighbors
//   (full opaque cubes) and merged into rectangles when they share tile + per-vertex AO.
// - `cutout`: alpha-tested blocks, one quad per visible face (leaves, glass, ice, inset
//   cactus, torch as a small stick).
// - `water`: one quad per visible face, top height by level (source 14/16, flowing level
//   n lower, full height under water); never merged (levels differ per cell).
//
// Missing neighbor chunk (border plane null): its cells read as **air**, so border faces are
// emitted (visible). That avoids holes into the void while a neighbor is not loaded or not
// created yet; when it arrives the store re-meshes this chunk and the faces get culled.
// Below y = 0 reads as opaque (no bottom faces under bedrock); above y = 63 as air. The
// diagonal neighbor chunks are unknown and read as air (only affects AO at chunk corners).
//
// Vertex data: positions (f32 ×3), normals (i8 ×3), uvs (f32 ×3: s, t in block units and the
// atlas layer — the shader repeats the tile with `fract`), colors (u8 ×3 normalized: face
// brightness × ambient occlusion), indices (u32).
import { FACE_TILES, Kind, KIND, OCCLUDES, isFluid, waterLevel, B } from "./blocks";

export const CW = 16;
export const CH = 64;
export const CVOL = CW * CW * CH;
/** Border plane size (64 rows × 16). */
export const BORDER = CH * CW;

export type MeshArrays = {
  positions: Float32Array;
  normals: Int8Array;
  uvs: Float32Array;
  colors: Uint8Array;
  indices: Uint32Array;
};

export type ChunkMesh = { opaque: MeshArrays; cutout: MeshArrays; water: MeshArrays };

export type MeshInput = {
  blocks: Uint8Array;
  /** N, S, E, W border planes (`borderOf`), null when that neighbor is not available. */
  borders: (Uint8Array | null)[];
};

/** Neighbor directions in `borders` order: N (−z), S (+z), E (+x), W (−x). */
export const DIRS: readonly [number, number][] = [
  [0, -1],
  [0, 1],
  [1, 0],
  [-1, 0],
];

/** The plane of `blocks` that touches the chunk in direction `dir` (0 N, 1 S, 2 E, 3 W)
 *  from the neighbor's point of view: what neighbor `dir` of *this* chunk needs is this
 *  chunk's plane facing it. Layout `[y * 16 + t]`, t = lx for N/S planes, lz for E/W. */
export function borderOf(blocks: Uint8Array, dir: number, out = new Uint8Array(BORDER)): Uint8Array {
  for (let y = 0; y < CH; y++)
    for (let t = 0; t < CW; t++) {
      let i: number;
      if (dir === 0) i = (y * CW + 0) * CW + t; // facing north: lz = 0
      else if (dir === 1) i = (y * CW + 15) * CW + t; // facing south: lz = 15
      else if (dir === 2) i = (y * CW + t) * CW + 15; // facing east: lx = 15
      else i = (y * CW + t) * CW + 0; // facing west: lx = 0
      out[y * CW + t] = blocks[i];
    }
  return out;
}

// ---------------------------------------------------------------- padded volume

const PX = CW + 2;
const PY = CH + 2;
const pidx = (x: number, y: number, z: number) => ((y + 1) * PX + (z + 1)) * PX + (x + 1);
/** Strides of the padded volume along x, y, z. */
const STRIDE = [1, PX * PX, PX];

function padded(input: MeshInput): Uint8Array {
  const p = new Uint8Array(PX * PX * PY);
  // y = −1: opaque floor (no faces under the world).
  p.fill(B.STONE, 0, PX * PX);
  const { blocks, borders } = input;
  for (let y = 0; y < CH; y++)
    for (let z = 0; z < CW; z++) {
      const src = (y * CW + z) * CW;
      p.set(blocks.subarray(src, src + CW), pidx(0, y, z));
    }
  const [n, s, e, w] = borders;
  for (let y = 0; y < CH; y++)
    for (let t = 0; t < CW; t++) {
      // Neighbor N's plane facing us is its south plane (lz = 15) → our z = −1.
      if (n) p[pidx(t, y, -1)] = n[y * CW + t];
      if (s) p[pidx(t, y, CW)] = s[y * CW + t];
      if (e) p[pidx(CW, y, t)] = e[y * CW + t];
      if (w) p[pidx(-1, y, t)] = w[y * CW + t];
    }
  return p;
}

// ---------------------------------------------------------------- vertex builder

class Builder {
  pos = new Float32Array(4096 * 3);
  nrm = new Int8Array(4096 * 3);
  uv = new Float32Array(4096 * 3);
  col = new Uint8Array(4096 * 3);
  idx = new Uint32Array(4096 * 1.5);
  nv = 0;
  ni = 0;

  private grow() {
    const g = <T extends Float32Array | Int8Array | Uint8Array | Uint32Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(a.length * 2);
      b.set(a);
      return b;
    };
    this.pos = g(this.pos);
    this.nrm = g(this.nrm);
    this.uv = g(this.uv);
    this.col = g(this.col);
    this.idx = g(this.idx);
  }

  /** One quad: 4 corners (xyz × 4), face `f`, atlas layer, 4 corner brightness (0..1),
   *  `flip` = use the other diagonal. Corners are CCW seen from the front. */
  quad(c: number[], f: number, layer: number, br: number[], flip: boolean) {
    if ((this.nv + 4) * 3 > this.pos.length || this.ni + 6 > this.idx.length) this.grow();
    const [nx, ny, nz] = NORMALS[f];
    const v0 = this.nv;
    for (let k = 0; k < 4; k++) {
      const o = (v0 + k) * 3;
      const x = c[k * 3];
      const y = c[k * 3 + 1];
      const z = c[k * 3 + 2];
      this.pos[o] = x;
      this.pos[o + 1] = y;
      this.pos[o + 2] = z;
      this.nrm[o] = nx;
      this.nrm[o + 1] = ny;
      this.nrm[o + 2] = nz;
      // Texture coords in block units, oriented so side textures stand upright.
      let s: number;
      let t: number;
      switch (f) {
        case 0: s = -z; t = y; break;
        case 1: s = z; t = y; break;
        case 4: s = x; t = y; break;
        case 5: s = -x; t = y; break;
        default: s = x; t = z;
      }
      this.uv[o] = s;
      this.uv[o + 1] = t;
      this.uv[o + 2] = layer;
      const b = Math.round(br[k] * 255);
      this.col[o] = this.col[o + 1] = this.col[o + 2] = b;
    }
    const I = this.idx;
    const i = this.ni;
    if (!flip) {
      I[i] = v0; I[i + 1] = v0 + 1; I[i + 2] = v0 + 2;
      I[i + 3] = v0; I[i + 4] = v0 + 2; I[i + 5] = v0 + 3;
    } else {
      I[i] = v0 + 1; I[i + 1] = v0 + 2; I[i + 2] = v0 + 3;
      I[i + 3] = v0 + 1; I[i + 4] = v0 + 3; I[i + 5] = v0;
    }
    this.nv += 4;
    this.ni += 6;
  }

  done(): MeshArrays {
    return {
      positions: this.pos.slice(0, this.nv * 3),
      normals: this.nrm.slice(0, this.nv * 3),
      uvs: this.uv.slice(0, this.nv * 3),
      colors: this.col.slice(0, this.nv * 3),
      indices: this.idx.slice(0, this.ni),
    };
  }
}

/** Face normals: 0 +x, 1 −x, 2 +y, 3 −y, 4 +z, 5 −z. */
const NORMALS: readonly [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
/** Directional face brightness (top brightest, bottom darkest). */
export const FACE_SHADE = [0.75, 0.75, 1, 0.55, 0.86, 0.86];
/** Brightness per AO level (0 = corner fully enclosed .. 3 = open). */
export const AO_CURVE = [0.5, 0.66, 0.83, 1];

const faceOf = (a: number, sgn: number) => a * 2 + (sgn > 0 ? 0 : 1);
/** Face axis 0 x, 1 y, 2 z → the face's (u, v) axes, cyclic so e_u × e_v = e_a. */
const U_AXIS = [1, 2, 0];
const V_AXIS = [2, 0, 1];

/** Emits face `f` of the box [min, max] (block units) as one quad. */
function boxFace(m: Builder, f: number, min: number[], max: number[], layer: number, br: number) {
  const a = f >> 1;
  const pos = (f & 1) === 0;
  const u = U_AXIS[a];
  const v = V_AXIS[a];
  const plane = pos ? max[a] : min[a];
  const corners: number[] = [];
  const uv = [
    [min[u], min[v]],
    [max[u], min[v]],
    [max[u], max[v]],
    [min[u], max[v]],
  ];
  // Positive faces: c0..c3 is CCW from +a; negative faces: reversed (c0, c3, c2, c1).
  const order = pos ? [0, 1, 2, 3] : [0, 3, 2, 1];
  for (const k of order) {
    const p = [0, 0, 0];
    p[a] = plane;
    p[u] = uv[k][0];
    p[v] = uv[k][1];
    corners.push(p[0], p[1], p[2]);
  }
  m.quad(corners, f, layer, [br, br, br, br], false);
}

// ---------------------------------------------------------------- meshing

const DIMS = [CW, CH, CW];

/** Water surface height of water block `b` with `above` on top of it. */
export function waterHeight(b: number, above: number): number {
  if (isFluid(above)) return 1;
  const l = waterLevel(b);
  return l <= 0 ? 14 / 16 : ((14 / 16) * (8 - l)) / 8;
}

export function meshChunk(input: MeshInput): ChunkMesh {
  const P = padded(input);
  const opaque = new Builder();
  const cutout = new Builder();
  const water = new Builder();
  greedyOpaque(P, opaque);
  perBlock(P, cutout, water);
  return { opaque: opaque.done(), cutout: cutout.done(), water: water.done() };
}

function greedyOpaque(P: Uint8Array, m: Builder) {
  const mask = new Int32Array(CH * CW);
  const p = [0, 0, 0];
  const corners = new Array<number>(12);
  const br = [0, 0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const u = U_AXIS[a];
    const v = V_AXIS[a];
    const du = DIMS[u];
    const dv = DIMS[v];
    const sa = STRIDE[a];
    const su = STRIDE[u];
    const sv = STRIDE[v];
    for (const sgn of [1, -1]) {
      const f = faceOf(a, sgn);
      const shadeF = FACE_SHADE[f];
      for (let i = 0; i < DIMS[a]; i++) {
        // Build the face mask of slice i: key = tile + 1 | AO corners << 8, 0 = no face.
        let any = false;
        for (let cv = 0; cv < dv; cv++)
          for (let cu = 0; cu < du; cu++) {
            p[a] = i;
            p[u] = cu;
            p[v] = cv;
            const at = pidx(p[0], p[1], p[2]);
            const b = P[at];
            let key = 0;
            if (KIND[b] === Kind.Opaque) {
              const q = at + sgn * sa;
              if (!OCCLUDES[P[q]]) {
                // AO at corners (−u,−v), (+u,−v), (+u,+v), (−u,+v) of the face, sampled in
                // the cell layer in front of the face.
                const s1m = OCCLUDES[P[q - su]];
                const s1p = OCCLUDES[P[q + su]];
                const s2m = OCCLUDES[P[q - sv]];
                const s2p = OCCLUDES[P[q + sv]];
                const ao0 = ao(s1m, s2m, OCCLUDES[P[q - su - sv]]);
                const ao1 = ao(s1p, s2m, OCCLUDES[P[q + su - sv]]);
                const ao2 = ao(s1p, s2p, OCCLUDES[P[q + su + sv]]);
                const ao3 = ao(s1m, s2p, OCCLUDES[P[q - su + sv]]);
                key = (FACE_TILES[b * 6 + f] + 1) | (ao0 << 8) | (ao1 << 10) | (ao2 << 12) | (ao3 << 14);
                any = true;
              }
            }
            mask[cv * du + cu] = key;
          }
        if (!any) continue;
        // Greedy merge: widest run along u, then extend along v while rows match.
        const plane = i + (sgn > 0 ? 1 : 0);
        for (let cv = 0; cv < dv; cv++)
          for (let cu = 0; cu < du; ) {
            const key = mask[cv * du + cu];
            if (!key) {
              cu++;
              continue;
            }
            let w = 1;
            while (cu + w < du && mask[cv * du + cu + w] === key) w++;
            let h = 1;
            outer: for (; cv + h < dv; h++)
              for (let k = 0; k < w; k++) if (mask[(cv + h) * du + cu + k] !== key) break outer;
            for (let hv = 0; hv < h; hv++) mask.fill(0, (cv + hv) * du + cu, (cv + hv) * du + cu + w);
            // Corners (u, v): (cu, cv), (cu+w, cv), (cu+w, cv+h), (cu, cv+h).
            const cs = [
              [cu, cv],
              [cu + w, cv],
              [cu + w, cv + h],
              [cu, cv + h],
            ];
            const aos = [(key >> 8) & 3, (key >> 10) & 3, (key >> 12) & 3, (key >> 14) & 3];
            const order = sgn > 0 ? [0, 1, 2, 3] : [0, 3, 2, 1];
            for (let k = 0; k < 4; k++) {
              const c = order[k];
              const q = [0, 0, 0];
              q[a] = plane;
              q[u] = cs[c][0];
              q[v] = cs[c][1];
              corners[k * 3] = q[0];
              corners[k * 3 + 1] = q[1];
              corners[k * 3 + 2] = q[2];
              br[k] = shadeF * AO_CURVE[aos[c]];
            }
            // Split along the diagonal with the brighter pair to avoid AO anisotropy.
            const flip = br[0] + br[2] < br[1] + br[3];
            m.quad(corners, f, (key & 0xff) - 1, br, flip);
            cu += w;
          }
      }
    }
  }
}

const ao = (s1: number, s2: number, c: number) => (s1 && s2 ? 0 : 3 - s1 - s2 - c);

function perBlock(P: Uint8Array, cut: Builder, wat: Builder) {
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  for (let y = 0; y < CH; y++)
    for (let z = 0; z < CW; z++)
      for (let x = 0; x < CW; x++) {
        const at = pidx(x, y, z);
        const b = P[at];
        const k = KIND[b];
        if (k === Kind.None || k === Kind.Opaque) continue;
        if (k === Kind.Water) {
          waterBlock(P, wat, x, y, z, at, b);
          continue;
        }
        for (let f = 0; f < 6; f++) {
          const a = f >> 1;
          const sgn = f & 1 ? -1 : 1;
          const nb = P[at + sgn * STRIDE[a]];
          min[0] = x;
          min[1] = y;
          min[2] = z;
          max[0] = x + 1;
          max[1] = y + 1;
          max[2] = z + 1;
          if (k === Kind.Cutout) {
            if (OCCLUDES[nb] || (nb === b && b !== B.LEAVES)) continue;
          } else if (k === Kind.Cactus) {
            if (a === 1) {
              if (OCCLUDES[nb] || nb === B.CACTUS) continue;
            } else {
              // Inset sides (1/16), always drawn.
              min[a] += 1 / 16;
              max[a] -= 1 / 16;
            }
          } else {
            // Torch: a 2 × 10 px stick in the middle of the cell, no bottom face.
            if (f === 3) continue;
            min[0] = x + 7 / 16;
            max[0] = x + 9 / 16;
            min[2] = z + 7 / 16;
            max[2] = z + 9 / 16;
            max[1] = y + 10 / 16;
          }
          boxFace(cut, f, min, max, FACE_TILES[b * 6 + f], FACE_SHADE[f]);
        }
      }
}

function waterBlock(P: Uint8Array, m: Builder, x: number, y: number, z: number, at: number, b: number) {
  const SY = STRIDE[1];
  const above = P[at + SY];
  const h = waterHeight(b, above);
  const layer = FACE_TILES[b * 6 + 2];
  const min = [x, y, z];
  const max = [x + 1, y + h, z + 1];
  if (!isFluid(above)) boxFace(m, 2, min, max, layer, FACE_SHADE[2]);
  const below = P[at - SY];
  if (!isFluid(below) && !OCCLUDES[below]) boxFace(m, 3, min, max, layer, FACE_SHADE[3]);
  for (const f of [0, 1, 4, 5]) {
    const a = f >> 1;
    const sgn = f & 1 ? -1 : 1;
    const nat = at + sgn * STRIDE[a];
    const nb = P[nat];
    if (OCCLUDES[nb]) continue;
    let y0 = y;
    if (isFluid(nb)) {
      // Only the step above a lower neighbor surface is visible.
      const hn = waterHeight(nb, P[nat + SY]);
      if (hn >= h) continue;
      y0 = y + hn;
    }
    boxFace(m, f, [x, y0, z], max, layer, FACE_SHADE[f]);
  }
}

/** Number of quads in a mesh. */
export const quadCount = (m: MeshArrays) => m.indices.length / 6;
