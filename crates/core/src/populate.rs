//! Terrain stage 2 (`populate_chunk`): caves, ores, trees, cacti and passive animals.
//! Integer-only, no heap. Runs on the stage-1 output of the same chunk.
//!
//! [`generate_stage2`] is a pure function of `(seed, cx, cz)` plus the chunk's own stage-1
//! output (itself pure), so the result is independent of chunk creation order. Features
//! that cross chunk borders (cave worms, tree canopies) are replayed from the 3×3 chunk
//! neighborhood and written only into local voxels, so a feature's voxels on both sides of
//! a border are exactly what a single-buffer generation of the whole world would give.
//!
//! **Inputs onchain:** the chunk stores its 256 biome bytes (`Chunk` header
//! `biomes: [u8; 256]`, written by stage 1); `populate_chunk` rebuilds [`Stage1Info`] with
//! [`stage1_info_from_blocks`](crate::terrain::stage1_info_from_blocks) (heights re-derived
//! by scanning columns of the still-stage-1 blocks; tested equal to `generate_stage1`'s).
//!
//! # Steps (in order)
//! 1. **Caves** — [`carve_caves`]; rule, entrances and work cap in [`crate::caves`].
//! 2. **Ores** ([`place_ores`]) — chunk-local blobs: [`ORES`] lists `(block, clusters,
//!    y_max exclusive)`: coal ×8 y<50, iron ×4 y<32, diamond ×1 y<12. Each blob is a random
//!    walk of 2–4 steps (axis-aligned ±1) from a hashed start; a voxel becomes ore only if
//!    it is currently Stone (so only where stage 1 had stone and caves left it), and walk
//!    steps leaving the chunk or the y band are skipped. Ores never cross chunk borders.
//! 3. **Trees** ([`place_trees`]) — [`TREE_CANDIDATES`] hashed columns per chunk. A
//!    candidate becomes a tree if its column's biome is Forest (`roll < 176/256`, ≈ 4.1 trees
//!    per forest chunk) or Plains (`roll < 20/256`, ≈ 0.5 per chunk) and its stage-1 surface
//!    is Grass (`h > SEA_LEVEL + 1`; Plains/Forest surfaces above the beach line are always
//!    Grass, and caves never open them). Trunk `y = h+1 ..= h+t`, `t ∈ 4..=6` (Log); leaves
//!    at `h+t−1` and `h+t` in a 5×5 square without its corners, and a plus at `h+t+1`
//!    (canopy radius 2). Writes are clipped to `y < 64` and to voxels strictly above their
//!    column's stage-1 surface; a log goes into Air or Leaves, leaves only into Air. Logs
//!    win over leaves and nothing else is overwritten, so overlapping trees give the same
//!    result in any replay order.
//!
//!    Neighbor replay: candidates of the 8 neighbor chunks are first filtered by position
//!    (canopy must reach this chunk: local column in `-2..=17` on both axes), then by biome
//!    ([`biome_at`]) and roll; only then is the base height read from [`HeightWindow`]
//!    (2-column strips / 2×2 corners via [`heights_cols`]). The slow
//!    [`height_at`](crate::terrain::height_at) is never called.
//! 4. **Cacti** ([`place_cacti`]) — chunk-local: [`CACTUS_CANDIDATES`] hashed columns, half
//!    accepted, in Desert columns whose live surface block is Sand at `h > SEA_LEVEL`
//!    (so never on an opened cave entrance); 1–3 tall, only into Air.
//! 5. **Animals** ([`spawn_animals`]) — 0–3 attempts per chunk at hashed columns; a spawn
//!    succeeds in Plains/Forest columns whose surface block is still Grass with two Air
//!    blocks above (so never under a tree). Output [`MobSpawn`] in **chunk-local** block
//!    coordinates: `(x, z)` = column, `y` = the feet block (`h + 1`).
//!
//! (Snowy sea ice is placed by stage 1; stage 2 has no ice step.)
//!
//! # Cost: hard bound (modeled SBF ops ≈ CU)
//! A chunk whose `populate_chunk` exceeded the budget would be stuck at `gen_stage 1`
//! forever, so every term is bounded by construction; [`STAGE2_OPS_BOUND`] sums them and
//! is const-asserted ≤ 800k: ix overhead 30k (assumed) + Stage1Info rebuild 73k + worm
//! replay 57k + column ceilings 15k + neighbor heights 158k (4 strips × 25k + 4 corners ×
//! 14.5k) + trees 69k + misc 4k + caves ≤ [`CAVE_OPS_CAP`] 380k = **786k**. The op
//! constants are hand counts of the inner loops, not SBF measurements; the cave cap is
//! a true hard limit on modeled ops, the other terms are worst-case loop counts.
//!
//! Measured: `scan_cave_tail` (10^6 chunks) — cave demand mean 55k, p99 163k, p99.999
//! 288k, max 340k (cap never hit); side strips loaded avg 3.93 (max 4), corners avg 0.07
//! (p99.999 3, max 4). `bench_stage2` (native release): stage 2 ≈ 1.6× stage 1 on average,
//! ≈ 2.2–2.7× worst chunk; one strip ≈ 20% of a stage 1 (≈ 20–25k est.). Caveat: native
//! time ratios only approximate SBF CU ratios (different ISA, no bounds-check elision
//! guarantees, 64-bit multiply cost); measure real CU once `populate_chunk` exists.
//!
//! # SBF stack (4 KB per frame)
//! [`generate_stage2`] frame ≈ 0.5 KB ([`HeightWindow`] is 420 B); [`carve_caves`] ≈ 1.2 KB;
//! the window loader ≈ 0.2 KB + [`heights_cols`] ≈ 0.4 KB + its lattice-sum frame ≈ 1.9 KB;
//! [`place_trees`], [`place_ores`], [`place_cacti`], [`spawn_animals`] are
//! `#[inline(never)]` with < 0.3 KB each. The caller provides the 16 KB block buffer, the
//! [`Stage1Info`] (1.25 KB) and the mob output array.

use crate::blocks::Block;
use crate::caves::{carve_caves, CaveStats, CAVE_OPS_CAP, MAX_WORMS, SEGS};
use crate::consts::{CHUNK_H, CHUNK_VOL, SEA_LEVEL};
use crate::coords::block_index;
use crate::hash::{rand_range, splitmix_next, Seed};
use crate::terrain::{biome_at, heights_cols, Biome, Stage1Info, MAX_HEIGHT};

pub const SALT_ORE: u32 = 0x04E5_0011;
pub const SALT_TREE: u32 = 0x76EE_0012;
pub const SALT_CACTUS: u32 = 0xCAC7_0013;
pub const SALT_MOB: u32 = 0x30B5_0014;

/// `(ore, clusters per chunk, exclusive max y)`.
pub const ORES: [(Block, u32, i32); 3] = [
    (Block::CoalOre, 8, 50),
    (Block::IronOre, 4, 32),
    (Block::DiamondOre, 1, 12),
];
/// Blob size in voxels (walk length incl. start), inclusive.
pub const ORE_BLOB: (i32, i32) = (2, 4);

/// Tree candidates per chunk and acceptance rolls (out of 256).
pub const TREE_CANDIDATES: u32 = 6;
pub const FOREST_ROLL: u32 = 176;
pub const PLAINS_ROLL: u32 = 20;
/// Trunk height (inclusive).
pub const TRUNK: (i32, i32) = (4, 6);
/// Canopy horizontal radius.
pub const CANOPY_R: i32 = 2;

pub const CACTUS_CANDIDATES: u32 = 3;

/// Passive animal kinds.
pub const MOB_PIG: u8 = 1;
pub const MOB_COW: u8 = 2;
pub const MOB_SHEEP: u8 = 3;
/// Spawn attempts per chunk are `0..=MAX_SPAWNS`.
pub const MAX_SPAWNS: usize = 3;

/// # Worst-case op bound (modeled SBF ops; see module docs, "Cost")
/// Ix overhead (Anchor, account checks) — an assumption.
pub const OPS_IX_OVERHEAD: u32 = 30_000;
/// [`stage1_info_from_blocks`](crate::terrain::stage1_info_from_blocks): ≤ 57 probes × 5 ops
/// per column.
pub const OPS_STAGE1_INFO: u32 = 256 * MAX_HEIGHT as u32 * 5;
/// Worm replay: 9 chunks × (≤ 2 worms × ≤ 24 segments × 125 ops (3 draws, step, walls,
/// bbox clip + bound) + 300 ops of worm setup).
pub const OPS_WORM_REPLAY: u32 = 9 * (MAX_WORMS as u32 * SEGS.1 as u32 * 125 + 300);
/// Per-column carve ceilings: 256 × (4 window reads + mins).
pub const OPS_COL_LIMITS: u32 = 256 * 60;
/// [`heights_cols`] fixed part (3 `fbm_grid9` 2-octave ≈ 9.7k + 81 classifications ≈ 2k +
/// box sums ≈ 1.4k) and per column (3-octave `fbm_2d` ≈ 315 + blend ≈ 60).
pub const OPS_LATTICE: u32 = 13_000;
pub const OPS_COLUMN: u32 = 375;
/// 4 side strips (2×16) + 4 corners (2×2).
pub const OPS_NEIGHBOR_HEIGHTS: u32 =
    4 * (OPS_LATTICE + 32 * OPS_COLUMN) + 4 * (OPS_LATTICE + 4 * OPS_COLUMN);
/// Trees: 54 candidate hashes × 40 + ≤ 48 neighbor `biome_at` × 650 + writes × 20 ops
/// (6 own trees × ≤ 53 voxels; a neighbor tree reaches ≤ 2 columns in: ≤ 30 voxels).
pub const OPS_TREES: u32 = 54 * 40 + 48 * 650 + (6 * 53 + 48 * 30) * 20;
/// Ores, cacti, animals.
pub const OPS_MISC: u32 = 4_000;
/// Total modeled worst case of `populate_chunk` (caves capped at [`CAVE_OPS_CAP`]).
pub const STAGE2_OPS_BOUND: u32 = OPS_IX_OVERHEAD
    + OPS_STAGE1_INFO
    + OPS_WORM_REPLAY
    + OPS_COL_LIMITS
    + OPS_NEIGHBOR_HEIGHTS
    + OPS_TREES
    + OPS_MISC
    + CAVE_OPS_CAP;
const _: () = assert!(STAGE2_OPS_BOUND <= 800_000);

/// An animal spawned by populate. Chunk-local block coordinates: `x, z ∈ 0..16` is the
/// column, `y` the block the feet occupy (first air above the grass).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MobSpawn {
    pub kind: u8,
    pub x: u8,
    pub y: u8,
    pub z: u8,
}

/// Window side: the chunk plus a 2-column margin (tree canopy reach) on every side.
const WIN: usize = 20;
const MARGIN: i32 = 2;

/// Stage-1 surface heights of the chunk's columns plus a 2-column margin
/// (local `-2..18` on both axes). Own columns come from [`Stage1Info`]; each of the 8
/// neighbor parts (2×16 side strip or 2×2 corner) is computed on first access with one
/// [`heights_cols`] (exact stage-1 heights, bit-equal to the neighbor's own stage 1).
pub struct HeightWindow {
    seed: Seed,
    cx: i32,
    cz: i32,
    h: [u8; WIN * WIN],
    /// Bit `(dz + 1) * 3 + (dx + 1)` set once neighbor `(dx, dz)` is loaded.
    loaded: u16,
}

impl HeightWindow {
    pub fn new(seed: &Seed, cx: i32, cz: i32, own: &[i32; 256]) -> Self {
        let mut w = HeightWindow {
            seed: *seed,
            cx,
            cz,
            h: [0; WIN * WIN],
            loaded: 1 << 4,
        };
        for lz in 0..16 {
            for lx in 0..16 {
                w.h[Self::idx(lx, lz)] = own[lz as usize * 16 + lx as usize] as u8;
            }
        }
        w
    }

    #[inline(always)]
    fn idx(lx: i32, lz: i32) -> usize {
        ((lz + MARGIN) as usize) * WIN + (lx + MARGIN) as usize
    }

    /// Height of an own column (`lx, lz ∈ 0..16`).
    #[inline(always)]
    pub fn own(&self, lx: usize, lz: usize) -> i32 {
        self.h[(lz + MARGIN as usize) * WIN + lx + MARGIN as usize] as i32
    }

    /// Height of local column `(lx, lz)`, `lx, lz ∈ -2..18`; loads its chunk if needed.
    #[inline]
    pub fn get(&mut self, lx: i32, lz: i32) -> i32 {
        debug_assert!((-MARGIN..16 + MARGIN).contains(&lx) && (-MARGIN..16 + MARGIN).contains(&lz));
        let (dx, dz) = (lx.div_euclid(16), lz.div_euclid(16));
        let bit = 1u16 << ((dz + 1) * 3 + dx + 1);
        if self.loaded & bit == 0 {
            self.load(dx, dz);
            self.loaded |= bit;
        }
        self.h[Self::idx(lx, lz)] as i32
    }

    /// Number of neighbor chunks whose heights were computed (bench / cost accounting).
    pub fn neighbors_loaded(&self) -> u32 {
        self.loaded.count_ones() - 1
    }

    /// Loads the window cells of neighbor `(dx, dz)`: a 2×16 / 16×2 strip for a side, a 2×2
    /// block for a corner, via [`heights_cols`] (bit-exact with that chunk's stage 1).
    #[inline(never)]
    fn load(&mut self, dx: i32, dz: i32) {
        // Neighbor-local start and length per axis.
        let span = |d: i32| -> (usize, usize) {
            match d {
                -1 => (16 - MARGIN as usize, MARGIN as usize),
                0 => (0, 16),
                _ => (0, MARGIN as usize),
            }
        };
        let ((x0, w), (z0, d)) = (span(dx), span(dz));
        let mut t = [0i32; 16 * MARGIN as usize];
        let (ncx, ncz) = (self.cx.wrapping_add(dx), self.cz.wrapping_add(dz));
        heights_cols(&self.seed, ncx, ncz, x0, z0, w, d, &mut t);
        for j in 0..d {
            for i in 0..w {
                let (lx, lz) = ((x0 + i) as i32 + dx * 16, (z0 + j) as i32 + dz * 16);
                self.h[Self::idx(lx, lz)] = t[j * w + i] as u8;
            }
        }
    }
}

/// Work counters of one [`generate_stage2`] call (bench / CU accounting).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stage2Stats {
    pub caves: CaveStats,
    /// Neighbor chunks whose window heights were computed (side strips + corners).
    pub sides_loaded: u32,
    pub corners_loaded: u32,
}

/// Stage-2 generation of chunk `(cx, cz)`. `blocks` must hold the chunk's stage-1 output
/// and `info` its [`Stage1Info`] (from [`generate_stage1`](crate::terrain::generate_stage1)).
/// Writes up to [`MAX_SPAWNS`] animals into `mobs` and returns how many.
#[inline(never)]
pub fn generate_stage2(
    seed: &Seed,
    cx: i32,
    cz: i32,
    blocks: &mut [u8; CHUNK_VOL],
    info: &Stage1Info,
    mobs: &mut [MobSpawn; MAX_SPAWNS],
) -> usize {
    generate_stage2_stats(seed, cx, cz, blocks, info, mobs).0
}

/// [`generate_stage2`] that also returns its [`Stage2Stats`].
#[inline(never)]
pub fn generate_stage2_stats(
    seed: &Seed,
    cx: i32,
    cz: i32,
    blocks: &mut [u8; CHUNK_VOL],
    info: &Stage1Info,
    mobs: &mut [MobSpawn; MAX_SPAWNS],
) -> (usize, Stage2Stats) {
    let mut win = HeightWindow::new(seed, cx, cz, &info.heights);
    let caves = carve_caves(seed, cx, cz, blocks, &info.biomes, &mut win);
    place_ores(seed, cx, cz, blocks);
    place_trees(seed, cx, cz, blocks, info, &mut win);
    place_cacti(seed, cx, cz, blocks, info);
    let n = spawn_animals(seed, cx, cz, blocks, info, mobs);
    let corners = (win.loaded & 0b101_000_101).count_ones();
    let stats = Stage2Stats {
        caves,
        sides_loaded: win.neighbors_loaded() - corners,
        corners_loaded: corners,
    };
    (n, stats)
}

/// Ore blobs (step 2).
#[inline(never)]
pub fn place_ores(seed: &Seed, cx: i32, cz: i32, blocks: &mut [u8; CHUNK_VOL]) {
    for (k, &(ore, n, ymax)) in ORES.iter().enumerate() {
        for c in 0..n {
            let mut st = seed.h64(cx as i64, cz as i64, (k as i64) << 8 | c as i64, SALT_ORE);
            let mut x = rand_range(splitmix_next(&mut st), 0, 15);
            let mut z = rand_range(splitmix_next(&mut st), 0, 15);
            let mut y = rand_range(splitmix_next(&mut st), 1, ymax - 1);
            let size = rand_range(splitmix_next(&mut st), ORE_BLOB.0, ORE_BLOB.1);
            for step in 0..size {
                if step > 0 {
                    let d = splitmix_next(&mut st);
                    let delta = if d & 1 == 0 { -1 } else { 1 };
                    match (d >> 1) % 3 {
                        0 => x += delta,
                        1 => y += delta,
                        _ => z += delta,
                    }
                }
                if (0..16).contains(&x) && (0..16).contains(&z) && (1..ymax).contains(&y) {
                    let i = block_index(x as usize, y as usize, z as usize);
                    if blocks[i] == Block::Stone as u8 {
                        blocks[i] = ore as u8;
                    }
                }
            }
        }
    }
}

/// A tree candidate of chunk `(cx, cz)`: `(lx, lz, roll 0..256, trunk height)`.
#[inline]
pub fn tree_candidate(seed: &Seed, cx: i32, cz: i32, i: u32) -> (i32, i32, u32, i32) {
    let h = seed.h64(cx as i64, cz as i64, i as i64, SALT_TREE);
    let trunk = rand_range(h, TRUNK.0, TRUNK.1);
    (
        (h & 15) as i32,
        (h >> 4 & 15) as i32,
        (h >> 8 & 255) as u32,
        trunk,
    )
}

/// Whether a candidate with `roll` grows in `biome` (before the grass/height check).
#[inline]
pub fn tree_accepts(biome: Biome, roll: u32) -> bool {
    match biome {
        Biome::Forest => roll < FOREST_ROLL,
        Biome::Plains => roll < PLAINS_ROLL,
        _ => false,
    }
}

/// Trees (step 3): replays the candidates of the 3×3 neighborhood (see module docs).
#[inline(never)]
pub fn place_trees(
    seed: &Seed,
    cx: i32,
    cz: i32,
    blocks: &mut [u8; CHUNK_VOL],
    info: &Stage1Info,
    win: &mut HeightWindow,
) {
    let reach = -CANOPY_R..16 + CANOPY_R;
    for dz in -1..=1 {
        for dx in -1..=1 {
            for i in 0..TREE_CANDIDATES {
                let (ncx, ncz) = (cx.wrapping_add(dx), cz.wrapping_add(dz));
                let (tx, tz, roll, trunk) = tree_candidate(seed, ncx, ncz, i);
                let (lx, lz) = (tx + dx * 16, tz + dz * 16);
                if !reach.contains(&lx) || !reach.contains(&lz) {
                    continue;
                }
                let biome = if dx == 0 && dz == 0 {
                    info.biomes[(lz * 16 + lx) as usize]
                } else {
                    // Wrapping, as terrain does: unreachable for any bounded world.
                    let wx = ncx.wrapping_mul(16).wrapping_add(tx);
                    biome_at(seed, wx, ncz.wrapping_mul(16).wrapping_add(tz))
                };
                if !tree_accepts(biome, roll) {
                    continue;
                }
                let h = win.get(lx, lz);
                if h <= SEA_LEVEL + 1 {
                    continue;
                }
                write_tree(blocks, win, lx, h, lz, trunk);
            }
        }
    }
}

/// Writes the local voxels of a tree based at local column `(lx, lz)` with surface `h`.
#[inline(always)]
fn write_tree(blocks: &mut [u8; CHUNK_VOL], win: &HeightWindow, lx: i32, h: i32, lz: i32, t: i32) {
    let top = h + t;
    for y in top - 1..=top + 1 {
        let r = if y == top + 1 { 1 } else { CANOPY_R };
        for dz in -r..=r {
            for dx in -r..=r {
                if dx.abs() + dz.abs() > if r == 1 { 1 } else { 3 } {
                    continue; // corners
                }
                if dx == 0 && dz == 0 && y <= top {
                    continue; // trunk
                }
                put(blocks, win, lx + dx, y, lz + dz, Block::Leaves);
            }
        }
    }
    for y in h + 1..=top {
        put(blocks, win, lx, y, lz, Block::Log);
    }
}

/// Writes a tree/cactus voxel if it is local, below the world top, above its column's
/// stage-1 surface, and the target allows it (Log over Air/Leaves; others over Air only).
#[inline(always)]
fn put(blocks: &mut [u8; CHUNK_VOL], win: &HeightWindow, x: i32, y: i32, z: i32, b: Block) {
    if !(0..16).contains(&x) || !(0..16).contains(&z) || y >= CHUNK_H as i32 {
        return;
    }
    let (x, z) = (x as usize, z as usize);
    if y <= win.own(x, z) {
        return;
    }
    let i = block_index(x, y as usize, z);
    let cur = blocks[i];
    if cur == Block::Air as u8 || (b == Block::Log && cur == Block::Leaves as u8) {
        blocks[i] = b as u8;
    }
}

/// Cacti (step 4), chunk-local.
#[inline(never)]
pub fn place_cacti(seed: &Seed, cx: i32, cz: i32, blocks: &mut [u8; CHUNK_VOL], info: &Stage1Info) {
    for i in 0..CACTUS_CANDIDATES {
        let r = seed.h64(cx as i64, cz as i64, i as i64, SALT_CACTUS);
        let (lx, lz) = ((r & 15) as usize, (r >> 4 & 15) as usize);
        if r >> 8 & 1 == 0 {
            continue;
        }
        let c = lz * 16 + lx;
        let h = info.heights[c];
        if info.biomes[c] != Biome::Desert
            || h <= SEA_LEVEL
            || blocks[block_index(lx, h as usize, lz)] != Block::Sand as u8
        {
            continue;
        }
        let tall = rand_range(r, 1, 3);
        for y in h + 1..=h + tall {
            let j = block_index(lx, y as usize, lz);
            if blocks[j] != Block::Air as u8 {
                break;
            }
            blocks[j] = Block::Cactus as u8;
        }
    }
}

/// Passive animals (step 5); returns the number written to `mobs`.
#[inline(never)]
pub fn spawn_animals(
    seed: &Seed,
    cx: i32,
    cz: i32,
    blocks: &[u8; CHUNK_VOL],
    info: &Stage1Info,
    mobs: &mut [MobSpawn; MAX_SPAWNS],
) -> usize {
    let mut st = seed.h64(cx as i64, cz as i64, 0, SALT_MOB);
    let attempts = rand_range(splitmix_next(&mut st), 0, MAX_SPAWNS as i32);
    let mut n = 0;
    for _ in 0..attempts {
        let r = splitmix_next(&mut st);
        let (lx, lz) = ((r & 15) as usize, (r >> 4 & 15) as usize);
        let c = lz * 16 + lx;
        let h = info.heights[c] as usize;
        if !matches!(info.biomes[c], Biome::Plains | Biome::Forest)
            || h + 2 >= CHUNK_H
            || blocks[block_index(lx, h, lz)] != Block::Grass as u8
            || blocks[block_index(lx, h + 1, lz)] != Block::Air as u8
            || blocks[block_index(lx, h + 2, lz)] != Block::Air as u8
        {
            continue;
        }
        mobs[n] = MobSpawn {
            kind: rand_range(r, MOB_PIG as i32, MOB_SHEEP as i32) as u8,
            x: lx as u8,
            y: h as u8 + 1,
            z: lz as u8,
        };
        n += 1;
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caves::{is_wet_u8, worms_for_chunk};
    use crate::consts::FP;
    use crate::terrain::{generate_stage1, height_at, heights_chunk};
    use std::collections::HashMap;

    fn seed(tag: u32) -> Seed {
        let mut b = [0u8; 32];
        for (i, v) in b.iter_mut().enumerate() {
            *v = (i as u8).wrapping_mul(29).wrapping_add(tag as u8) ^ (tag >> 8) as u8;
        }
        Seed::new(&b)
    }

    /// Stage-1 heights of every column in chunks `bx-1..=bx+n` × `bz-1..=bz+n` (the region
    /// plus a one-chunk ring), via the chunk path.
    type Hts = HashMap<(i32, i32), i32>;

    fn ring_heights(s: &Seed, bx: i32, bz: i32, n: i32) -> Hts {
        let mut m = HashMap::new();
        let mut t = [0i32; 256];
        for cz in bz - 1..=bz + n {
            for cx in bx - 1..=bx + n {
                heights_chunk(s, cx, cz, &mut t);
                for (c, &h) in t.iter().enumerate() {
                    m.insert((cx * 16 + (c % 16) as i32, cz * 16 + (c / 16) as i32), h);
                }
            }
        }
        m
    }

    /// An `n×n` chunk region at chunk `(bx, bz)`: stage-1 and stage-2 bytes in one world-
    /// indexed buffer each, plus animal spawns in world coordinates.
    struct Region {
        s: Seed,
        bx: i32,
        bz: i32,
        n: i32,
        s1: Vec<u8>,
        s2: Vec<u8>,
        biomes: HashMap<(i32, i32), Biome>,
        mobs: Vec<(u8, i32, i32, i32)>,
    }

    impl Region {
        fn w(&self) -> i32 {
            self.n * 16
        }
        fn idx(&self, x: i32, y: i32, z: i32) -> Option<usize> {
            let (rx, rz, w) = (x - self.bx * 16, z - self.bz * 16, self.w());
            if (0..w).contains(&rx) && (0..w).contains(&rz) && (0..64).contains(&y) {
                Some(((y * w + rz) * w + rx) as usize)
            } else {
                None
            }
        }
        fn xs(&self) -> std::ops::Range<i32> {
            self.bx * 16..self.bx * 16 + self.w()
        }
        fn zs(&self) -> std::ops::Range<i32> {
            self.bz * 16..self.bz * 16 + self.w()
        }
    }

    /// One chunk through both stages; `stage2 = false` stops after caves (for the cave
    /// reference test).
    type ChunkOut = (
        Box<[u8; CHUNK_VOL]>,
        Box<[u8; CHUNK_VOL]>,
        Stage1Info,
        Vec<MobSpawn>,
    );

    fn gen_chunk(s: &Seed, cx: i32, cz: i32, full: bool) -> ChunkOut {
        let mut b = Box::new([0xEEu8; CHUNK_VOL]);
        let mut info = Stage1Info::EMPTY;
        generate_stage1(s, cx, cz, &mut b, &mut info);
        let s1 = b.clone();
        let mut mobs = [MobSpawn::default(); MAX_SPAWNS];
        let n = if full {
            generate_stage2(s, cx, cz, &mut b, &info, &mut mobs)
        } else {
            let mut win = HeightWindow::new(s, cx, cz, &info.heights);
            let st = carve_caves(s, cx, cz, &mut b, &info.biomes, &mut win);
            assert_eq!(st.skipped, 0, "cave cap hit in a reference-tested chunk");
            0
        };
        (s1, b, info, mobs[..n].to_vec())
    }

    fn region(s: &Seed, bx: i32, bz: i32, n: i32, full: bool, order: &[(i32, i32)]) -> Region {
        let w = (n * 16) as usize;
        let mut r = Region {
            s: *s,
            bx,
            bz,
            n,
            s1: vec![0; w * w * 64],
            s2: vec![0; w * w * 64],
            biomes: HashMap::new(),
            mobs: vec![],
        };
        for &(dx, dz) in order {
            let (cx, cz) = (bx + dx, bz + dz);
            let (s1, s2, info, mobs) = gen_chunk(s, cx, cz, full);
            for y in 0..64 {
                for lz in 0..16 {
                    for lx in 0..16 {
                        let (x, z) = (cx * 16 + lx as i32, cz * 16 + lz as i32);
                        let i = r.idx(x, y as i32, z).unwrap();
                        r.s1[i] = s1[block_index(lx, y, lz)];
                        r.s2[i] = s2[block_index(lx, y, lz)];
                    }
                }
            }
            for c in 0..256 {
                r.biomes.insert(
                    (cx * 16 + c as i32 % 16, cz * 16 + c as i32 / 16),
                    info.biomes[c],
                );
            }
            for m in mobs {
                r.mobs.push((
                    m.kind,
                    cx * 16 + m.x as i32,
                    m.y as i32,
                    cz * 16 + m.z as i32,
                ));
            }
        }
        r
    }

    fn row_major(n: i32) -> Vec<(i32, i32)> {
        (0..n * n).map(|i| (i % n, i / n)).collect()
    }

    fn scrambled(n: i32) -> Vec<(i32, i32)> {
        let mut v = row_major(n);
        v.reverse();
        let len = v.len();
        for i in 0..len {
            v.swap(i, (i * 7 + 3) % len);
        }
        v
    }

    /// Stage-1 wetness of world voxel: region buffer inside, height rule outside.
    fn wet(r: &Region, hts: &Hts, x: i32, y: i32, z: i32) -> bool {
        if !(0..64).contains(&y) {
            return false;
        }
        match r.idx(x, y, z) {
            Some(i) => is_wet_u8(r.s1[i]),
            None => y <= SEA_LEVEL && y > hts[&(x, z)],
        }
    }

    const NB6: [(i32, i32, i32); 6] = [
        (1, 0, 0),
        (-1, 0, 0),
        (0, 1, 0),
        (0, -1, 0),
        (0, 0, 1),
        (0, 0, -1),
    ];

    /// Single-buffer cave reference: every sphere of every worm that can reach the region,
    /// carved straight into the region's stage-1 buffer with the global rule.
    fn ref_caves(r: &Region, hts: &Hts) -> Vec<u8> {
        let mut out = r.s1.clone();
        let fp = FP as i64;
        for ocz in r.bz - 2..=r.bz + r.n + 1 {
            for ocx in r.bx - 2..=r.bx + r.n + 1 {
                for sp in worms_for_chunk(&r.s, ocx, ocz) {
                    let rf = sp.r as i64 * fp;
                    for y in (sp.y - rf).div_euclid(fp)..=(sp.y + rf).div_euclid(fp) {
                        for z in (sp.z - rf).div_euclid(fp)..=(sp.z + rf).div_euclid(fp) {
                            for x in (sp.x - rf).div_euclid(fp)..=(sp.x + rf).div_euclid(fp) {
                                let d = |v: i64, c: i64| (v * fp + fp / 2 - c).pow(2);
                                if d(x, sp.x) + d(y, sp.y) + d(z, sp.z) > rf * rf {
                                    continue;
                                }
                                let (x, y, z) = (x as i32, y as i32, z as i32);
                                let Some(i) = r.idx(x, y, z) else { continue };
                                let h = hts[&(x, z)];
                                let own = x.div_euclid(16) == ocx && z.div_euclid(16) == ocz;
                                let grassy =
                                    matches!(r.biomes[&(x, z)], Biome::Plains | Biome::Forest);
                                let top = if sp.entrance && own && !grassy && h >= SEA_LEVEL {
                                    h
                                } else {
                                    h - 1
                                };
                                if y < 1 || y > top {
                                    continue;
                                }
                                if NB6
                                    .iter()
                                    .any(|&(a, b, c)| wet(r, hts, x + a, y + b, z + c))
                                {
                                    continue;
                                }
                                out[i] = Block::Air as u8;
                            }
                        }
                    }
                }
            }
        }
        out
    }

    #[test]
    fn order_independent_and_deterministic() {
        for (tag, bx, bz) in [(1, 0, 0), (2, -5, 3), (3, 17, -9)] {
            let s = seed(tag);
            let a = region(&s, bx, bz, 3, true, &row_major(3));
            let b = region(&s, bx, bz, 3, true, &scrambled(3));
            assert!(a.s2 == b.s2, "order changed blocks");
            let mut ma = a.mobs.clone();
            let mut mb = b.mobs.clone();
            ma.sort();
            mb.sort();
            assert_eq!(ma, mb);
            // Repeat run is identical; stage 2 changed something.
            let c = region(&s, bx, bz, 3, true, &row_major(3));
            assert!(a.s2 == c.s2 && a.mobs == c.mobs);
            assert!(a.s1 != a.s2);
        }
        let a = region(&seed(1), 0, 0, 1, true, &[(0, 0)]);
        let b = region(&seed(9), 0, 0, 1, true, &[(0, 0)]);
        assert!(a.s2 != b.s2);
    }

    #[test]
    fn caves_match_single_buffer_reference() {
        let (mut cross, mut carved) = (0, 0);
        for (tag, bx, bz) in [(1, -1, -1), (4, 10, 2), (5, -30, 7), (6, 3, -40)] {
            let s = seed(tag);
            let r = region(&s, bx, bz, 3, false, &row_major(3));
            let hts = ring_heights(&s, bx, bz, 3);
            let reference = ref_caves(&r, &hts);
            for (i, (&a, &b)) in r.s2.iter().zip(&reference).enumerate() {
                assert_eq!(a, b, "seed {tag} voxel {i}");
            }
            // Meaningful: tunnels cross chunk borders (carved pairs straddling x or z seams).
            for y in 1..64 {
                for z in r.zs() {
                    for x in r.xs() {
                        let i = r.idx(x, y, z).unwrap();
                        let cv =
                            |j: usize| r.s1[j] != Block::Air as u8 && r.s2[j] == Block::Air as u8;
                        if !cv(i) {
                            continue;
                        }
                        carved += 1;
                        for (nx, nz) in [(x + 1, z), (x, z + 1)] {
                            let seam = nx.rem_euclid(16) == 0 && nx != x
                                || nz.rem_euclid(16) == 0 && nz != z;
                            if seam && r.idx(nx, y, nz).is_some_and(cv) {
                                cross += 1;
                            }
                        }
                    }
                }
            }
        }
        println!("carved {carved}, border-crossing pairs {cross}");
        assert!(carved > 1000 && cross > 20);
    }

    #[test]
    fn cave_cap_is_hard_and_deterministic() {
        use crate::caves::carve_caves_capped;
        let s = seed(3);
        let (mut skipped, mut total) = (0, 0);
        for (cx, cz) in [(0, 0), (5, -2), (-9, 14), (30, 30)] {
            let (s1, _, info, _) = gen_chunk(&s, cx, cz, false);
            let run = |cap: u32| {
                let mut b = s1.clone();
                let mut win = HeightWindow::new(&s, cx, cz, &info.heights);
                let st = carve_caves_capped(&s, cx, cz, &mut b, &info.biomes, &mut win, cap);
                (b, st)
            };
            let (full, st) = run(CAVE_OPS_CAP);
            assert!(st.ops <= CAVE_OPS_CAP && st.ops == st.demand && st.skipped == 0);
            for cap in [0, 5_000, 20_000] {
                let (a, sa) = run(cap);
                let (b, sb) = run(cap);
                assert!(a == b && sa == sb);
                assert!(sa.ops <= cap && sa.demand == st.demand);
                // Capped output only ever carves a subset of the uncapped output.
                assert!(a
                    .iter()
                    .zip(full.iter())
                    .zip(s1.iter())
                    .all(|((&a, &f), &o)| a == o || a == f));
                skipped += sa.skipped;
            }
            total += st.demand;
        }
        assert!(skipped > 0 && total > 0);
        println!("bound {STAGE2_OPS_BOUND} (caves cap {CAVE_OPS_CAP})");
    }

    #[test]
    fn caves_exist_and_avoid_water_and_bedrock() {
        let (mut total, mut total_entrances) = (0, 0);
        for (tag, bx, bz) in [(7, 0, 0), (8, -12, 20), (9, 33, -2)] {
            let s = seed(tag);
            let r = region(&s, bx, bz, 4, true, &row_major(4));
            let hts = ring_heights(&s, bx, bz, 4);
            let mut carved = 0;
            let mut near_sea = 0;
            let mut entrances = 0;
            for y in 0..64 {
                for z in r.zs() {
                    for x in r.xs() {
                        let i = r.idx(x, y, z).unwrap();
                        if y == 0 {
                            assert_eq!(r.s2[i], Block::Bedrock as u8);
                            continue;
                        }
                        if r.s1[i] == Block::Air as u8 || r.s2[i] != Block::Air as u8 {
                            continue;
                        }
                        carved += 1;
                        let h = hts[&(x, z)];
                        assert!(y <= h, "carved above surface at {x},{y},{z}");
                        if y == h {
                            // Entrance: never in grass biomes, never under water, and
                            // nothing (tree, cactus, animal) stands on it.
                            entrances += 1;
                            let b = r.biomes[&(x, z)];
                            assert!(!matches!(b, Biome::Plains | Biome::Forest), "{b:?}");
                            assert!(h >= SEA_LEVEL);
                            let above = r.s2[r.idx(x, y + 1, z).unwrap()];
                            assert!(above != Block::Log as u8 && above != Block::Cactus as u8);
                            assert!(!r.mobs.iter().any(|m| (m.1, m.3) == (x, z)));
                        }
                        for (a, b, c) in NB6 {
                            assert!(
                                !wet(&r, &hts, x + a, y + b, z + c),
                                "wet next to {x},{y},{z}"
                            );
                        }
                        near_sea += (y <= SEA_LEVEL) as i32;
                    }
                }
            }
            println!(
                "seed {tag}: carved {carved} ({near_sea} at y <= sea level, {entrances} surface)"
            );
            assert!(carved > 300, "no caves for seed {tag}");
            total += carved;
            total_entrances += entrances;
        }
        assert!(total > 2000);
        assert!(total_entrances > 0, "no cave entrances");
    }

    #[test]
    fn ores_in_bands_and_only_in_stone() {
        let mut counts = [0u32; 3];
        for (tag, bx, bz) in [(10, 0, 0), (11, 50, -50)] {
            let r = region(&seed(tag), bx, bz, 4, true, &row_major(4));
            for (i, &b) in r.s2.iter().enumerate() {
                let y = (i / (r.w() * r.w()) as usize) as i32;
                for (k, &(ore, _, ymax)) in ORES.iter().enumerate() {
                    if b == ore as u8 {
                        assert!(y < ymax && y >= 1, "{ore:?} at y {y}");
                        assert_eq!(r.s1[i], Block::Stone as u8);
                        counts[k] += 1;
                    }
                }
            }
        }
        println!("ore voxels coal/iron/diamond over 32 chunks: {counts:?}");
        // ≥ 1 voxel per cluster on average (some clusters land in caves/dirt).
        assert!(counts[0] > 8 * 32 && counts[1] > 4 * 32 && counts[2] > 10);
    }

    /// Reference trees on the region's stage-1 buffer using the slow point functions.
    fn ref_trees(r: &Region, hts: &Hts) -> Vec<u8> {
        let mut out = r.s1.clone();
        for ocz in r.bz - 1..=r.bz + r.n {
            for ocx in r.bx - 1..=r.bx + r.n {
                for i in 0..TREE_CANDIDATES {
                    let (tx, tz, roll, t) = tree_candidate(&r.s, ocx, ocz, i);
                    let (wx, wz) = (ocx * 16 + tx, ocz * 16 + tz);
                    if !tree_accepts(biome_at(&r.s, wx, wz), roll) {
                        continue;
                    }
                    let h = height_at(&r.s, wx, wz);
                    if h <= SEA_LEVEL + 1 {
                        continue;
                    }
                    let mut vox = vec![];
                    for dz in -2i32..=2 {
                        for dx in -2i32..=2 {
                            let corner = dx.abs() == 2 && dz.abs() == 2;
                            if !corner && (dx, dz) != (0, 0) {
                                vox.push((wx + dx, h + t - 1, wz + dz, Block::Leaves));
                                vox.push((wx + dx, h + t, wz + dz, Block::Leaves));
                            }
                            if dx.abs() + dz.abs() <= 1 {
                                vox.push((wx + dx, h + t + 1, wz + dz, Block::Leaves));
                            }
                        }
                    }
                    for y in h + 1..=h + t {
                        vox.push((wx, y, wz, Block::Log));
                    }
                    for (x, y, z, b) in vox {
                        let Some(j) = r.idx(x, y, z) else { continue };
                        if y <= hts[&(x, z)] {
                            continue;
                        }
                        if out[j] == Block::Air as u8
                            || (b == Block::Log && out[j] == Block::Leaves as u8)
                        {
                            out[j] = b as u8;
                        }
                    }
                }
            }
        }
        out
    }

    #[test]
    fn tree_canopy_crosses_border_consistently() {
        let mut checked = 0;
        let mut found = false;
        'search: for tag in 0..1000u32 {
            let s = seed(100 + tag);
            let (cx, cz) = ((tag % 13) as i32 * 3 - 20, (tag / 13) as i32 * 2 - 30);
            for i in 0..TREE_CANDIDATES {
                checked += 1;
                let (tx, tz, roll, _) = tree_candidate(&s, cx, cz, i);
                let (wx, wz) = (cx * 16 + tx, cz * 16 + tz);
                let near_edge = !(2..14).contains(&tx) || !(2..14).contains(&tz);
                if !near_edge || !tree_accepts(biome_at(&s, wx, wz), roll) {
                    continue;
                }
                if height_at(&s, wx, wz) <= SEA_LEVEL + 1 {
                    continue;
                }
                let r = region(&s, cx - 1, cz - 1, 3, true, &row_major(3));
                let hts = ring_heights(&s, cx - 1, cz - 1, 3);
                let reference = ref_trees(&r, &hts);
                let tree = |b: u8| b == Block::Log as u8 || b == Block::Leaves as u8;
                for (j, (&a, &b)) in r.s2.iter().zip(&reference).enumerate() {
                    if tree(a) || tree(b) {
                        assert_eq!(a, b, "tree voxel {j} differs (seed {tag})");
                    }
                }
                // Leaves of this tree on the other side of the border.
                let mut across = 0;
                for z in wz - 2..=wz + 2 {
                    for x in wx - 2..=wx + 2 {
                        if x.div_euclid(16) == cx && z.div_euclid(16) == cz {
                            continue;
                        }
                        for y in 0..64 {
                            if r.s2[r.idx(x, y, z).unwrap()] == Block::Leaves as u8 {
                                across += 1;
                            }
                        }
                    }
                }
                if across > 0 {
                    println!("straddling tree after {checked} candidates: seed {tag} {wx},{wz}, {across} leaves across");
                    found = true;
                    break 'search;
                }
            }
        }
        assert!(found, "no straddling tree within the search bound");
    }

    #[test]
    fn surface_features_on_right_blocks() {
        let (mut logs, mut cacti, mut mobs, mut trees) = (0, 0, 0, 0);
        for (tag, bx, bz) in [(20, 0, 0), (21, -40, 12), (22, 8, 60), (23, 100, -100)] {
            let r = region(&seed(tag), bx, bz, 5, true, &row_major(5));
            let w = r.w() as usize;
            for (i, &b) in r.s2.iter().enumerate() {
                if b != Block::Log as u8 && b != Block::Cactus as u8 {
                    continue;
                }
                // Walk down the stack to its base.
                let mut j = i;
                while r.s2[j] == b {
                    j -= w * w;
                }
                let base = r.s2[j];
                if b == Block::Log as u8 {
                    logs += 1;
                    assert_eq!(base, Block::Grass as u8, "log not on grass");
                    trees += (j + w * w == i) as i32; // trunk bottoms
                } else {
                    cacti += 1;
                    assert_eq!(base, Block::Sand as u8, "cactus not on sand");
                    assert!(i - j <= 3 * w * w, "cactus too tall");
                }
            }
            for &(kind, x, y, z) in &r.mobs {
                mobs += 1;
                assert!((MOB_PIG..=MOB_SHEEP).contains(&kind));
                assert!(matches!(r.biomes[&(x, z)], Biome::Plains | Biome::Forest));
                assert_eq!(r.s2[r.idx(x, y - 1, z).unwrap()], Block::Grass as u8);
                assert_eq!(r.s2[r.idx(x, y, z).unwrap()], Block::Air as u8);
                assert_eq!(r.s2[r.idx(x, y + 1, z).unwrap()], Block::Air as u8);
            }
        }
        println!("logs {logs} (trees {trees}) cacti {cacti} mobs {mobs}");
        assert!(trees > 10 && cacti > 0 && mobs > 5);
    }

    #[test]
    #[ignore]
    fn bench_stage2() {
        let s = seed(42);
        const REPS: i32 = 1000;
        let mut out = [0u8; CHUNK_VOL];
        let mut info = Stage1Info::EMPTY;
        let mut mobs = [MobSpawn::default(); MAX_SPAWNS];
        let (mut t1, mut t2) = (std::time::Duration::ZERO, std::time::Duration::ZERO);
        let mut worst = std::time::Duration::ZERO;
        let (mut acc, mut sides, mut corners) = (0u64, 0u32, 0u32);
        for rep in 0..REPS {
            let (cx, cz) = (rep % 40 - 20, rep / 40 - 12);
            let t = std::time::Instant::now();
            generate_stage1(&s, cx, cz, &mut out, &mut info);
            t1 += t.elapsed();
            let copy = out;
            let t = std::time::Instant::now();
            let (n, st) = generate_stage2_stats(&s, cx, cz, &mut out, &info, &mut mobs);
            let mut best = t.elapsed();
            t2 += best;
            acc += n as u64 + out[7000] as u64;
            sides += st.sides_loaded;
            corners += st.corners_loaded;
            // Worst chunk: min of 3 runs filters scheduler noise.
            for _ in 0..2 {
                let mut again = copy;
                let t = std::time::Instant::now();
                acc += generate_stage2(&s, cx, cz, &mut again, &info, &mut mobs) as u64;
                best = best.min(t.elapsed());
            }
            worst = worst.max(best);
        }
        let t = std::time::Instant::now();
        let mut h = [0i32; 32];
        for rep in 0..REPS {
            heights_cols(&s, rep, 3, 14, 0, 2, 16, &mut h);
            acc += h[5] as u64;
        }
        let strip = t.elapsed() / REPS as u32;
        let n = REPS as u32;
        println!(
            "stage1 {:?}/chunk  stage2 {:?}/chunk  ratio {:.2}  worst stage2 {worst:?}  \
             strip load {strip:?}  loads/chunk sides {:.2} corners {:.2}  (acc {acc})",
            t1 / n,
            t2 / n,
            t2.as_secs_f64() / t1.as_secs_f64(),
            sides as f64 / REPS as f64,
            corners as f64 / REPS as f64,
        );
    }

    /// Tail scan for the CU bound: cave bbox-test demand and neighbor loads over 10^6
    /// chunks (4 seeds × 500×500), multi-threaded.
    #[test]
    #[ignore]
    fn scan_cave_tail() {
        const SIDE: i32 = 500;
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
        let mut all: Vec<(u32, u32, u32, u32)> = Vec::new(); // demand, tests, sides, corners
        let rows: Vec<(u32, i32)> = (0..4u32)
            .flat_map(|t| (0..SIDE).map(move |z| (t, z)))
            .collect();
        let chunks: Vec<&[(u32, i32)]> = rows.chunks(rows.len().div_ceil(threads)).collect();
        std::thread::scope(|sc| {
            let hs: Vec<_> = chunks
                .iter()
                .map(|part| {
                    sc.spawn(move || {
                        let mut v = Vec::new();
                        let mut b = Box::new([0u8; CHUNK_VOL]);
                        let mut info = Stage1Info::EMPTY;
                        let mut mobs = [MobSpawn::default(); MAX_SPAWNS];
                        for &(tag, z) in part.iter() {
                            let s = seed(1000 + tag);
                            for x in 0..SIDE {
                                let (cx, cz) = (x - SIDE / 2 + tag as i32 * 7919, z - SIDE / 2);
                                generate_stage1(&s, cx, cz, &mut b, &mut info);
                                let (_, st) =
                                    generate_stage2_stats(&s, cx, cz, &mut b, &info, &mut mobs);
                                v.push((
                                    st.caves.demand,
                                    st.caves.ops,
                                    st.sides_loaded,
                                    st.corners_loaded,
                                ));
                            }
                        }
                        v
                    })
                })
                .collect();
            for h in hs {
                all.extend(h.join().unwrap());
            }
        });
        let n = all.len();
        let pick = |f: fn(&(u32, u32, u32, u32)) -> u32| {
            let mut v: Vec<u32> = all.iter().map(f).collect();
            v.sort_unstable();
            let p = |q: f64| v[((n as f64 - 1.0) * q) as usize];
            (
                v.iter().map(|&x| x as u64).sum::<u64>() as f64 / n as f64,
                p(0.99),
                p(0.99999),
                v[n - 1],
            )
        };
        let capped = all.iter().filter(|r| r.0 > r.1).count();
        println!("chunks {n}  capped {capped}");
        println!(
            "cave demand (modeled ops): mean/p99/p99.999/max {:?}",
            pick(|r| r.0)
        );
        println!("side loads:   mean/p99/p99.999/max {:?}", pick(|r| r.2));
        println!("corner loads: mean/p99/p99.999/max {:?}", pick(|r| r.3));
    }
}
