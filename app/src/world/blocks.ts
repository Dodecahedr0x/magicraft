// Client mirror of `core::blocks` (ids 0..30) plus the render classes the mesher uses.
// Keep in sync with crates/core/src/blocks.rs (`is_transparent`, `is_fluid`).

export const B = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  COBBLESTONE: 4,
  SAND: 5,
  SANDSTONE: 6,
  GRAVEL: 7,
  BEDROCK: 8,
  LOG: 9,
  LEAVES: 10,
  PLANKS: 11,
  COAL_ORE: 12,
  IRON_ORE: 13,
  DIAMOND_ORE: 14,
  CRAFTING_TABLE: 15,
  FURNACE: 16,
  TORCH: 17,
  GLASS: 18,
  IRON_BLOCK: 19,
  SNOW: 20,
  ICE: 21,
  CACTUS: 22,
  WATER_SOURCE: 23,
  WATER7: 30,
} as const;

export const BLOCK_NAMES = [
  "air", "grass", "dirt", "stone", "cobblestone", "sand", "sandstone", "gravel", "bedrock", "log",
  "leaves", "planks", "coal ore", "iron ore", "diamond ore", "crafting table", "furnace", "torch",
  "glass", "iron block", "snow", "ice", "cactus", "water", "water 1", "water 2", "water 3",
  "water 4", "water 5", "water 6", "water 7",
] as const;

export const isFluid = (b: number) => b >= B.WATER_SOURCE && b <= B.WATER7;
/** Water level: source 0, flowing 1..7; -1 for non-water. */
export const waterLevel = (b: number) => (isFluid(b) ? b - B.WATER_SOURCE : -1);

/** How the mesher draws a block. */
export const Kind = {
  /** Not drawn (air). */
  None: 0,
  /** Full opaque cube: greedy-meshed, occludes neighbors. */
  Opaque: 1,
  /** Alpha-tested cube (leaves, glass, ice), per-face. */
  Cutout: 2,
  /** Cactus: 1/16-inset sides, cutout mesh; does not occlude neighbors. */
  Cactus: 3,
  /** Torch: a small stick box, cutout mesh. */
  Torch: 4,
  Water: 5,
} as const;

/** Render kind per byte value. Bytes outside the palette render as opaque stone-like
 *  cubes (core treats them as solid + opaque, fail closed). */
export const KIND: Uint8Array = (() => {
  const t = new Uint8Array(256).fill(Kind.Opaque);
  t[B.AIR] = Kind.None;
  t[B.LEAVES] = t[B.GLASS] = t[B.ICE] = Kind.Cutout;
  t[B.CACTUS] = Kind.Cactus;
  t[B.TORCH] = Kind.Torch;
  for (let b = B.WATER_SOURCE; b <= B.WATER7; b++) t[b] = Kind.Water;
  return t;
})();

/** Blocks that hide the faces of their neighbors (full opaque cubes). */
export const OCCLUDES: Uint8Array = KIND.map((k) => (k === Kind.Opaque ? 1 : 0));

// ---------------------------------------------------------------- tiles (atlas layers)

export const T = {
  GRASS_TOP: 0,
  GRASS_SIDE: 1,
  DIRT: 2,
  STONE: 3,
  COBBLE: 4,
  SAND: 5,
  SANDSTONE_SIDE: 6,
  SANDSTONE_TOP: 7,
  GRAVEL: 8,
  BEDROCK: 9,
  LOG_SIDE: 10,
  LOG_TOP: 11,
  LEAVES: 12,
  PLANKS: 13,
  COAL_ORE: 14,
  IRON_ORE: 15,
  DIAMOND_ORE: 16,
  TABLE_TOP: 17,
  TABLE_SIDE: 18,
  TABLE_FRONT: 19,
  FURNACE_SIDE: 20,
  FURNACE_FRONT: 21,
  FURNACE_TOP: 22,
  TORCH: 23,
  TORCH_TOP: 24,
  GLASS: 25,
  IRON_BLOCK: 26,
  SNOW: 27,
  ICE: 28,
  CACTUS_SIDE: 29,
  CACTUS_TOP: 30,
  WATER: 31,
  UNKNOWN: 32,
} as const;
export const TILE_COUNT = 33;

/** Faces: 0 +x (E), 1 −x (W), 2 +y (top), 3 −y (bottom), 4 +z (S), 5 −z (N). */
export const FACE_TILES: Uint8Array = (() => {
  const t = new Uint8Array(256 * 6).fill(T.UNKNOWN);
  const set = (b: number, all: number, top = all, bottom = all, front = all) => {
    for (let f = 0; f < 6; f++) t[b * 6 + f] = all;
    t[b * 6 + 2] = top;
    t[b * 6 + 3] = bottom;
    t[b * 6 + 4] = front;
  };
  set(B.GRASS, T.GRASS_SIDE, T.GRASS_TOP, T.DIRT);
  set(B.DIRT, T.DIRT);
  set(B.STONE, T.STONE);
  set(B.COBBLESTONE, T.COBBLE);
  set(B.SAND, T.SAND);
  set(B.SANDSTONE, T.SANDSTONE_SIDE, T.SANDSTONE_TOP, T.SANDSTONE_TOP);
  set(B.GRAVEL, T.GRAVEL);
  set(B.BEDROCK, T.BEDROCK);
  set(B.LOG, T.LOG_SIDE, T.LOG_TOP, T.LOG_TOP);
  set(B.LEAVES, T.LEAVES);
  set(B.PLANKS, T.PLANKS);
  set(B.COAL_ORE, T.COAL_ORE);
  set(B.IRON_ORE, T.IRON_ORE);
  set(B.DIAMOND_ORE, T.DIAMOND_ORE);
  // No orientation is stored: the "front" faces south (+z).
  set(B.CRAFTING_TABLE, T.TABLE_SIDE, T.TABLE_TOP, T.PLANKS, T.TABLE_FRONT);
  set(B.FURNACE, T.FURNACE_SIDE, T.FURNACE_TOP, T.FURNACE_TOP, T.FURNACE_FRONT);
  set(B.TORCH, T.TORCH, T.TORCH_TOP, T.TORCH);
  set(B.GLASS, T.GLASS);
  set(B.IRON_BLOCK, T.IRON_BLOCK);
  set(B.SNOW, T.SNOW);
  set(B.ICE, T.ICE);
  set(B.CACTUS, T.CACTUS_SIDE, T.CACTUS_TOP, T.CACTUS_TOP);
  for (let b = B.WATER_SOURCE; b <= B.WATER7; b++) set(b, T.WATER);
  return t;
})();
