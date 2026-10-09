// Item names and icons. Properties (tool info, stack size, durability, food) come from
// the core wasm (`coreItems()`); names are client-side. Icons are drawn procedurally (no
// assets): block items as a small isometric cube from the block atlas tiles, everything else
// as 16×16 pixel sprites (tools by kind + tier color, materials, food, drops).
import { buildAtlas, TILE } from "../world/atlas";
import { FACE_TILES } from "../world/blocks";
import { coreItems, type CoreItem } from "../wasm";

export const ITEM_NAMES: Record<number, string> = {
  1: "Grass",
  2: "Dirt",
  3: "Stone",
  4: "Cobblestone",
  5: "Sand",
  6: "Sandstone",
  7: "Gravel",
  9: "Log",
  10: "Leaves",
  11: "Planks",
  12: "Coal Ore",
  13: "Iron Ore",
  14: "Diamond Ore",
  15: "Crafting Table",
  16: "Furnace",
  17: "Torch",
  18: "Glass",
  19: "Iron Block",
  20: "Snow",
  21: "Ice",
  22: "Cactus",
  256: "Wooden Pickaxe",
  257: "Stone Pickaxe",
  258: "Iron Pickaxe",
  259: "Diamond Pickaxe",
  260: "Wooden Axe",
  261: "Stone Axe",
  262: "Iron Axe",
  263: "Diamond Axe",
  264: "Wooden Shovel",
  265: "Stone Shovel",
  266: "Iron Shovel",
  267: "Diamond Shovel",
  268: "Wooden Sword",
  269: "Stone Sword",
  270: "Iron Sword",
  271: "Diamond Sword",
  512: "Stick",
  513: "Coal",
  514: "Iron Ingot",
  515: "Diamond",
  768: "Raw Porkchop",
  769: "Cooked Porkchop",
  770: "Raw Beef",
  771: "Steak",
  772: "Raw Mutton",
  773: "Cooked Mutton",
  1024: "Leather",
  1025: "Wool",
  1026: "Rotten Flesh",
};

export const itemName = (id: number) => ITEM_NAMES[id] ?? `Item ${id}`;

/** Core properties of item `id` (null for 0 / unknown ids). Needs the core wasm. */
export const itemInfo = (id: number): CoreItem | null => (id ? (coreItems().get(id) ?? null) : null);

// ---------------------------------------------------------------- sprites

type RGBA = [number, number, number, number];
const hex = (s: string): RGBA => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 255];
const shade = (c: RGBA, k: number): RGBA => [c[0] * k, c[1] * k, c[2] * k, c[3]];
function hash(x: number, y: number, s: number) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A 16×16 sprite (RGBA, rows top-down). */
export type Sprite = Uint8ClampedArray;

class Pen {
  readonly px: Sprite = new Uint8ClampedArray(16 * 16 * 4);
  set(x: number, y: number, c: RGBA) {
    if (x < 0 || y < 0 || x > 15 || y > 15) return;
    this.px.set(c.map(Math.round), (y * 16 + x) * 4);
  }
  /** Thick (2 px) diagonal-ish line from a to b. */
  line(ax: number, ay: number, bx: number, by: number, c: RGBA, dark?: RGBA) {
    const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
    for (let i = 0; i <= n; i++) {
      const x = Math.round(ax + ((bx - ax) * i) / n);
      const y = Math.round(ay + ((by - ay) * i) / n);
      this.set(x, y, c);
      if (dark) this.set(x + 1, y, dark);
    }
  }
  blob(cx: number, cy: number, rx: number, ry: number, c: RGBA, seed: number, edge = 0.7) {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const d = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2;
        if (d > 1) continue;
        const k = d > 0.65 ? edge : 0.9 + hash(x, y, seed) * 0.2;
        this.set(x, y, shade(c, k));
      }
  }
}

const TIER_COLORS = ["#a0763f", "#8d8d8d", "#e6e6e6", "#5ee6e8"];
const STICK = hex("#7a5a32");
const STICK_D = hex("#553d20");

function toolSprite(kind: number, tier: number): Sprite {
  const p = new Pen();
  const head = hex(TIER_COLORS[Math.max(0, tier - 1)] ?? TIER_COLORS[0]);
  const hd = shade(head, 0.7);
  if (kind === 3) {
    // Sword: blade along the diagonal, guard, short grip.
    p.line(5, 10, 13, 2, head, hd);
    p.line(14, 1, 14, 1, shade(head, 1.1));
    p.line(3, 9, 6, 12, shade(hd, 0.8));
    p.line(2, 13, 4, 11, STICK, STICK_D);
    p.set(1, 14, STICK_D);
    return p.px;
  }
  p.line(2, 13, 10, 5, STICK, STICK_D);
  if (kind === 0) {
    // Pickaxe: curved head across the top of the handle.
    const pts: [number, number][] = [[4, 3], [5, 2], [6, 2], [7, 1], [8, 1], [9, 1], [10, 2], [11, 2], [12, 3], [13, 4], [13, 5], [14, 6], [14, 7], [14, 8], [13, 9]];
    for (const [x, y] of pts) {
      p.set(x, y, head);
      p.set(x - 1, y + 1, hd);
    }
  } else if (kind === 1) {
    // Axe: a blade on one side of the handle's top.
    for (let y = 1; y <= 7; y++) for (let x = 8; x <= 13; x++) if (x - y >= 4 && x - y <= 9 && x + y >= 10) p.set(x, y, x - y > 7 ? hd : head);
  } else {
    // Shovel: a rounded blade at the end.
    p.blob(11.5, 4.5, 2.8, 2.8, head, 7, 0.75);
  }
  return p.px;
}

function materialSprite(id: number): Sprite {
  const p = new Pen();
  switch (id) {
    case 512: // stick
      p.line(3, 12, 12, 3, STICK, STICK_D);
      break;
    case 513: // coal
      p.blob(8, 8.5, 5.5, 5, hex("#2c2c2c"), 11, 0.6);
      p.set(6, 6, hex("#5a5a5a"));
      p.set(9, 8, hex("#4a4a4a"));
      break;
    case 514: // iron ingot: a trapezoid bar
      for (let y = 6; y <= 11; y++)
        for (let x = 2 + (11 - y) / 2; x <= 13 - (11 - y) / 2; x++) p.set(Math.round(x), y, y === 6 ? hex("#f4f4f4") : y === 11 ? hex("#9a9a9a") : hex("#d4d4d4"));
      break;
    case 515: // diamond: rhombus
      for (let y = 2; y <= 14; y++)
        for (let x = 2; x <= 14; x++) {
          const d = Math.abs(x - 8) / 6 + Math.abs(y - 8) / 6;
          if (d <= 1) p.set(x, y, d > 0.8 ? hex("#1f9fa3") : y < 8 && x < 8 ? hex("#c8fbfc") : hex("#5ee6e8"));
        }
      break;
    case 1024: // leather
      p.blob(8, 8, 6, 5.5, hex("#9a5b32"), 12, 0.7);
      break;
    case 1025: // wool
      p.blob(8, 8, 6.5, 6, hex("#ececec"), 13, 0.82);
      break;
    case 1026: // rotten flesh
      p.blob(8, 8.5, 6, 4.5, hex("#7d6a3a"), 14, 0.7);
      p.blob(9, 8, 2.5, 2, hex("#5d7a2c"), 15, 0.9);
      break;
    default: {
      // Food: raw (pink/red) vs cooked (brown).
      const colors: Record<number, string> = { 768: "#e8908e", 769: "#c47a46", 770: "#c8423c", 771: "#7a4a2a", 772: "#d0605a", 773: "#a0643c" };
      const c = colors[id];
      if (!c) {
        p.blob(8, 8, 6, 6, hex("#c040c0"), 1);
        break;
      }
      p.blob(8.5, 9, 6, 4.5, hex(c), id, 0.72);
      p.blob(4, 5, 1.6, 1.6, hex("#efe6d6"), id + 1, 0.9); // bone end
    }
  }
  return p.px;
}

/** The 16×16 sprite of a non-block item (tools, materials, food, drops). */
export function itemSprite(id: number, info: Pick<CoreItem, "toolKind" | "tier"> | null): Sprite {
  if (info && info.toolKind >= 0) return toolSprite(info.toolKind, info.tier);
  return materialSprite(id);
}

// ---------------------------------------------------------------- icons (DOM)

let atlasData: Uint8Array | null = null;
const iconCache = new Map<number, string>();

/** One atlas tile as a 16×16 canvas (rows top-down), brightness × `k`. */
function tileCanvas(layer: number, k: number): HTMLCanvasElement {
  atlasData ??= buildAtlas().data;
  const c = document.createElement("canvas");
  c.width = c.height = TILE;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(TILE, TILE);
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      const src = ((layer * TILE + (TILE - 1 - y)) * TILE + x) * 4;
      const dst = (y * TILE + x) * 4;
      img.data[dst] = atlasData[src] * k;
      img.data[dst + 1] = atlasData[src + 1] * k;
      img.data[dst + 2] = atlasData[src + 2] * k;
      img.data[dst + 3] = atlasData[src + 3];
    }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Isometric cube icon (32×32) of block `b`: top, south (left) and east (right) faces. */
function cubeIcon(b: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  const s = 1 / 16;
  const face = (f: number, k: number, m: [number, number, number, number, number, number]) => {
    ctx.setTransform(...m);
    ctx.drawImage(tileCanvas(FACE_TILES[b * 6 + f], k), 0, 0);
  };
  // Top: u → toward the top vertex, v → toward the center.
  face(2, 1, [14 * s, -7.5 * s, 14 * s, 7.5 * s, 2, 8.5]);
  // Left (south, +z): u → toward the center, v → down.
  face(4, 0.82, [14 * s, 7.5 * s, 0, 15 * s, 2, 8.5]);
  // Right (east, +x): u → toward the right corner, v → down.
  face(0, 0.64, [14 * s, -7.5 * s, 0, 15 * s, 16, 16]);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}

function spriteIcon(px: Sprite): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(16, 16);
  img.data.set(px);
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Data URL of item `id`'s icon (cached). Torches use their flat tile like Minecraft. */
export function itemIconUrl(id: number): string {
  const hit = iconCache.get(id);
  if (hit) return hit;
  const info = itemInfo(id);
  let c: HTMLCanvasElement;
  if (info && info.block >= 0 && info.block !== 17) c = cubeIcon(info.block);
  else if (info && info.block === 17) c = tileCanvas(FACE_TILES[17 * 6], 1);
  else c = spriteIcon(itemSprite(id, info));
  const url = c.toDataURL();
  iconCache.set(id, url);
  return url;
}
