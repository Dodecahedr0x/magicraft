// Procedural block textures: one 16×16 RGBA tile per atlas layer (`T.*` in blocks.ts),
// painted from seeded hash noise — no external assets. The result is a layered buffer for a
// `DataArrayTexture` (each layer a tile, so greedy quads can repeat a tile with `fract`
// without bleeding into neighbors); `atlasCanvas` lays the tiles out on a canvas for
// inspection. Rows are stored bottom-up (texture t = 0 at the bottom of the tile).
import { T, TILE_COUNT } from "./blocks";

export const TILE = 16;

type RGB = [number, number, number];
type Px = (x: number, y: number) => [number, number, number, number] | RGB;

/** Integer hash → [0, 1). */
function hash(x: number, y: number, s: number): number {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const hex = (s: string): RGB => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Per-pixel brightness jitter around 1 (amplitude `a`). */
const n = (x: number, y: number, s: number, a: number) => 1 + (hash(x, y, s) - 0.5) * 2 * a;
/** Two-octave value noise in [0, 1) (2×2 blocks + pixels). */
const blotch = (x: number, y: number, s: number) => 0.6 * hash(x >> 1, y >> 1, s) + 0.4 * hash(x, y, s + 1);

function noisy(base: string, amp: number, seed: number): Px {
  const c = hex(base);
  return (x, y) => shade(c, n(x, y, seed, amp) * (0.92 + 0.16 * hash(x >> 2, y >> 2, seed + 7)));
}

/** Jittered cell pattern (cobble / furnace): cell id + distance to the nearest edge. */
function cells(x: number, y: number, seed: number, grid = 4) {
  let best = 1e9;
  let second = 1e9;
  let id = 0;
  const gx = Math.floor(x / grid);
  const gy = Math.floor(y / grid);
  for (let oy = -1; oy <= 1; oy++)
    for (let ox = -1; ox <= 1; ox++) {
      // Wrap so the tile repeats seamlessly.
      const cx = gx + ox;
      const cy = gy + oy;
      const wx = ((cx % (TILE / grid)) + TILE / grid) % (TILE / grid);
      const wy = ((cy % (TILE / grid)) + TILE / grid) % (TILE / grid);
      const px = cx * grid + 1 + hash(wx, wy, seed) * (grid - 2);
      const py = cy * grid + 1 + hash(wx, wy, seed + 3) * (grid - 2);
      const d = (x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2;
      if (d < best) {
        second = best;
        best = d;
        id = wx * 31 + wy;
      } else if (d < second) second = d;
    }
  return { id, edge: Math.sqrt(second) - Math.sqrt(best) };
}

const STONE = noisy("#7f7f7f", 0.1, 3);
const DIRT = noisy("#8a5f3e", 0.12, 2);

function ore(color: string, seed: number): Px {
  const c = hex(color);
  return (x, y) => {
    const spot = hash(x >> 1, y >> 1, seed) > 0.8 && hash(x, y, seed + 1) > 0.25;
    return spot ? shade(c, n(x, y, seed + 2, 0.15)) : STONE(x, y);
  };
}

function planks(x: number, y: number): RGB {
  const row = y >> 2;
  const seam = y % 4 === 3 || (x + row * 5) % 16 === 0;
  const c = shade(hex("#b28a52"), n(x >> 2, y, 13, 0.06) * (1 + (hash(row, 0, 14) - 0.5) * 0.12));
  return seam ? shade(c, 0.66) : shade(c, n(x, y, 15, 0.04));
}

function cobble(x: number, y: number, seed = 4, base = "#7a7a7a"): RGB {
  const { id, edge } = cells(x, y, seed);
  const c = shade(hex(base), 0.85 + hash(id, 0, seed + 9) * 0.3);
  if (edge < 0.9) return shade(c, 0.5);
  return shade(c, n(x, y, seed + 2, 0.06) * (edge < 1.8 ? 0.85 : 1));
}

const PAINT: Record<number, Px> = {
  [T.GRASS_TOP]: (x, y) => shade(hex("#6a9f3e"), n(x, y, 1, 0.14) * (0.94 + 0.12 * blotch(x, y, 9))),
  [T.GRASS_SIDE]: (x, y) => {
    // Grass fringe hangs 3–5 px from the top edge (y = 0 is the top row here).
    const depth = 3 + Math.floor(hash(x, 0, 5) * 3);
    return y < depth ? shade(hex("#6a9f3e"), n(x, y, 1, 0.14)) : DIRT(x, y);
  },
  [T.DIRT]: DIRT,
  [T.STONE]: STONE,
  [T.COBBLE]: (x, y) => cobble(x, y),
  [T.SAND]: noisy("#dccf9a", 0.05, 5),
  [T.SANDSTONE_SIDE]: (x, y) => {
    const c = hex("#d6c690");
    if (y < 3) return shade(c, n(x, y, 6, 0.04) * 1.04);
    if (y === 3 || y === 11) return shade(c, 0.86);
    return shade(c, n(x, y, 6, 0.05) * (y > 11 ? 0.95 : 1));
  },
  [T.SANDSTONE_TOP]: noisy("#ddd09a", 0.035, 7),
  [T.GRAVEL]: (x, y) => {
    const { id, edge } = cells(x, y, 8, 4);
    const tones = ["#8b8580", "#7a726c", "#9b938b", "#6d6a68", "#a39a90"];
    const c = hex(tones[id % tones.length]);
    return shade(c, edge < 0.7 ? 0.7 : n(x, y, 8, 0.07));
  },
  [T.BEDROCK]: (x, y) => shade(hex("#5a5a5a"), 0.45 + hash(x >> (hash(x, y, 9) > 0.5 ? 1 : 0), y, 9) * 0.9),
  [T.LOG_SIDE]: (x, y) => {
    const c = hex("#6b4f2e");
    const groove = (x + Math.floor(hash(x, y >> 3, 10) * 2)) % 4 === 0;
    return shade(c, (groove ? 0.7 : 1) * n(x, y, 11, 0.08));
  },
  [T.LOG_TOP]: (x, y) => {
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    if (d > 6.6) return shade(hex("#6b4f2e"), n(x, y, 11, 0.08));
    const ring = Math.floor(d) % 2 === 0;
    return shade(hex("#b8945c"), (ring ? 0.86 : 1) * n(x, y, 12, 0.04));
  },
  [T.LEAVES]: (x, y) => {
    if (hash(x, y, 12) < 0.2) return [0, 0, 0, 0];
    return shade(hex("#3e7a2c"), 0.75 + hash(x, y, 13) * 0.45);
  },
  [T.PLANKS]: planks,
  [T.COAL_ORE]: ore("#262626", 20),
  [T.IRON_ORE]: ore("#d4a888", 21),
  [T.DIAMOND_ORE]: ore("#5ee6e8", 22),
  [T.TABLE_TOP]: (x, y) => {
    if (x === 0 || y === 0 || x === 15 || y === 15) return shade(hex("#6e4d2b"), 1);
    if (x === 5 || x === 10 || y === 5 || y === 10) return shade(hex("#5b3e21"), 1);
    return planks(x, y);
  },
  [T.TABLE_SIDE]: (x, y) => {
    if (y < 3) return shade(hex("#6e4d2b"), n(x, y, 16, 0.08));
    // A saw silhouette on the side.
    if (y >= 6 && y <= 8 && x >= 3 && x <= 12) return y === 8 && x % 2 ? planks(x, y) : hex("#a7a7a7");
    if (x === 0 || x === 15) return shade(hex("#6e4d2b"), 1);
    return planks(x, y);
  },
  [T.TABLE_FRONT]: (x, y) => {
    if (y < 3) return shade(hex("#6e4d2b"), n(x, y, 16, 0.08));
    // Hammer + pick heads.
    if ((y === 5 || y === 6) && x >= 3 && x <= 6) return hex("#9a9a9a");
    if (y >= 7 && y <= 12 && x === 5) return hex("#5b3e21");
    if (y === 5 && x >= 9 && x <= 13) return hex("#9a9a9a");
    if (y >= 6 && y <= 12 && x === 11) return hex("#5b3e21");
    if (x === 0 || x === 15) return shade(hex("#6e4d2b"), 1);
    return planks(x, y);
  },
  [T.FURNACE_SIDE]: (x, y) => cobble(x, y, 30, "#808080"),
  [T.FURNACE_TOP]: (x, y) => shade(hex("#8a8a8a"), (x === 0 || y === 0 || x === 15 || y === 15 ? 0.7 : 1) * n(x, y, 31, 0.06)),
  [T.FURNACE_FRONT]: (x, y) => {
    if (x >= 4 && x <= 11 && y >= 8 && y <= 13) {
      const glow = y >= 11 ? mix(hex("#3a1a0a"), hex("#ff9a2e"), hash(x, y, 32) * 0.7) : hex("#1c1c1c");
      return glow;
    }
    if (x >= 3 && x <= 12 && y >= 7 && y <= 14) return hex("#4d4d4d");
    return cobble(x, y, 30, "#808080");
  },
  [T.TORCH]: (x, y) => {
    if (x < 7 || x > 8 || y < 6) return [0, 0, 0, 0];
    if (y < 8) return y === 6 ? hex("#ffe08a") : hex("#ffb02e");
    return shade(hex("#7a5a32"), x === 7 ? 1.1 : 0.85);
  },
  [T.TORCH_TOP]: () => hex("#ffd060"),
  [T.GLASS]: (x, y) => {
    const edge = x === 0 || y === 0 || x === 15 || y === 15;
    if (edge) return [205, 232, 240, 255];
    const streak = (x === y + 3 || x === y + 4) && x > 4 && x < 12;
    return streak ? [235, 248, 252, 255] : [0, 0, 0, 0];
  },
  [T.IRON_BLOCK]: (x, y) => {
    const edge = x === 0 || y === 0 || x === 15 || y === 15;
    const c = hex("#d8d8d8");
    if (edge) return shade(c, x === 0 || y === 0 ? 1.08 : 0.72);
    return shade(c, n(x, y, 33, 0.025) * (y % 5 === 2 ? 0.94 : 1));
  },
  [T.SNOW]: noisy("#f2f6f8", 0.025, 34),
  [T.ICE]: (x, y) => {
    const crack = (x * 3 + y * 5) % 17 === 0 && hash(x, y, 35) > 0.4;
    return shade(hex("#9cc4f2"), crack ? 1.18 : n(x, y, 35, 0.04));
  },
  [T.CACTUS_SIDE]: (x, y) => {
    const c = hex("#5a8a2c");
    if (x === 0 || x === 15) return [0, 0, 0, 0];
    if ((x === 3 || x === 8 || x === 12) && y % 4 === 1) return hex("#e8e0b0");
    return shade(c, (x % 5 === 2 ? 0.82 : 1) * n(x, y, 36, 0.06));
  },
  [T.CACTUS_TOP]: (x, y) => {
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    if (d > 7) return [0, 0, 0, 0];
    return shade(hex(d > 5.5 ? "#5a8a2c" : "#7aa847"), n(x, y, 37, 0.05));
  },
  [T.WATER]: (x, y) => shade(hex("#3b6fd8"), 0.92 + 0.16 * blotch(x + y, y, 38)),
  [T.UNKNOWN]: (x, y) => ((x >> 2) + (y >> 2)) % 2 ? hex("#c040c0") : hex("#202020"),
};

/** All tiles as RGBA layers (`TILE_COUNT` × 16 × 16 × 4), rows bottom-up per layer. */
export function buildAtlas(): { data: Uint8Array; size: number; layers: number } {
  const data = new Uint8Array(TILE_COUNT * TILE * TILE * 4);
  for (let l = 0; l < TILE_COUNT; l++) {
    const paint = PAINT[l] ?? PAINT[T.UNKNOWN];
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const p = paint(x, y);
        // Painters draw top-down; the texture's t axis points up.
        const o = ((l * TILE + (TILE - 1 - y)) * TILE + x) * 4;
        data[o] = clamp(p[0]);
        data[o + 1] = clamp(p[1]);
        data[o + 2] = clamp(p[2]);
        data[o + 3] = p.length === 4 ? (p as number[])[3] : 255;
      }
  }
  return { data, size: TILE, layers: TILE_COUNT };
}

/** The atlas laid out on a canvas (8 tiles per row, `scale`× nearest) — for debugging
 *  (`__magicraft.world.atlas()` in the console). */
export function atlasCanvas(scale = 4): HTMLCanvasElement {
  const { data, layers } = buildAtlas();
  const cols = 8;
  const rows = Math.ceil(layers / cols);
  const c = document.createElement("canvas");
  c.width = cols * TILE * scale;
  c.height = rows * TILE * scale;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  const tile = document.createElement("canvas");
  tile.width = tile.height = TILE;
  const tctx = tile.getContext("2d")!;
  for (let l = 0; l < layers; l++) {
    const img = tctx.createImageData(TILE, TILE);
    for (let y = 0; y < TILE; y++) {
      const src = ((l * TILE + (TILE - 1 - y)) * TILE) * 4;
      img.data.set(data.subarray(src, src + TILE * 4), y * TILE * 4);
    }
    tctx.putImageData(img, 0, 0);
    ctx.drawImage(tile, (l % cols) * TILE * scale, Math.floor(l / cols) * TILE * scale, TILE * scale, TILE * scale);
  }
  return c;
}
