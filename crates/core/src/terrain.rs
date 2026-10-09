//! Terrain stage 1: biomes, blended heightmap and column fill. Integer-only, no heap.
//!
//! # Biomes
//! Three low-frequency 2-octave fbm channels (raw `0..=1024`, typical band
//! [`SPREAD_2OCT`](crate::noise::SPREAD_2OCT) ≈ 165..860, mean ≈ 512):
//! temperature `t` (cell 2^8), moisture `m` (cell 2^8) and relief `r` (cell 2^7).
//! Classification, first match wins (see [`classify`]):
//! `r > RELIEF_MOUNTAINS` → Mountains; `t < TEMP_SNOWY` → Snowy;
//! `t > TEMP_DESERT && m < MOIST_DESERT` → Desert; `m > MOIST_FOREST` → Forest; else Plains.
//!
//! # Height
//! Each biome has `(base, amp)` ([`params`]). Blending: biome params are sampled on a
//! coarse lattice of stride 4 (world points `(4i, 4j)`), box-summed over a 5×5 lattice
//! neighborhood (a 20×20-block window), and bilinearly interpolated between the four
//! surrounding lattice points. This is continuous, so biome borders ramp over ≈ 20 blocks
//! instead of forming walls. Detail noise `n` = 3-octave fbm (cells 32/16/8) remapped from
//! [`SPREAD_3OCT`](crate::noise::SPREAD_3OCT) to `nn ∈ -512..=512` (clamped), and
//! `h = round(base + amp · nn / 512)` clamped to `MIN_HEIGHT..=MAX_HEIGHT`.
//!
//! Lattice trick: sampling an fbm with world cell `2^k` at `x = 4i` equals sampling the
//! same fbm with cell `2^(k−2)` at `i` (index `4i >> k = i >> (k−2)`, fraction identical),
//! so the chunk path gets the 9×9 lattice biomes it needs from one `fbm_chunk` per channel
//! in lattice space, bit-exact with [`biome_at`]`(4i, 4j)`.
//!
//! # Column fill (stage 1)
//! y=0 bedrock; stone `1..=h−4`; 3 filler blocks; surface at `h`; water `h+1..=SEA_LEVEL`
//! (top layer Ice in Snowy); air above. Surfaces: any column with `h ≤ SEA_LEVEL+1` is
//! Sand (beach / sea floor). Otherwise Plains/Forest Grass over Dirt; Desert Sand over
//! Sandstone (also under beaches in desert); Snowy Snow over Dirt; Mountains Grass over Dirt
//! below `STONE_LINE` (42), bare Stone in `STONE_LINE..=SNOW_LINE`, Snow over Stone above
//! `SNOW_LINE` (50).
//!
//! # Cost estimate (SBF ops ≈ CU)
//! `generate_stage1`: 7 `fbm_chunk` calls — 3 in lattice space (2 oct), 3 per column (2 oct),
//! 1 height (3 oct) — at ≈ 20 ops per column per octave + corner hashing ≈ 15 × 256 × 20 +
//! ~2k hashing ≈ 80k; classification of 81 + 256 points ≈ 5k; box sums + bilinear + height
//! ≈ 8k; column fill touches only layers `min(h)−3 ..= max(max h, SEA_LEVEL)` per byte
//! (typically 10–25 layers × 256 ≈ 2.5k–6.5k bytes × ~5 ops ≈ 15–35k); the remaining layers
//! are bulk `fill`s (nearly free). Total ≈ 110–130k ops, well under the 600k target.

use crate::blocks::Block;
use crate::consts::{CHUNK_H, CHUNK_VOL, SEA_LEVEL};
use crate::hash::Seed;
use crate::noise::{fbm_2d, fbm_chunk, SPREAD_3OCT};

/// Lowest generated surface height.
pub const MIN_HEIGHT: i32 = 1;
/// Highest generated surface height (leaves room for trees).
pub const MAX_HEIGHT: i32 = CHUNK_H as i32 - 8;
/// Mountains above this height are snow-capped.
pub const SNOW_LINE: i32 = 50;
/// Mountains at or above this height (up to [`SNOW_LINE`]) have a bare stone surface.
pub const STONE_LINE: i32 = 42;
/// Bound on |Δh| between adjacent columns when neither is Mountains (asserted by tests).
pub const MAX_STEP_FLAT: i32 = 3;
/// Bound on |Δh| between adjacent columns when either is Mountains (asserted by tests).
pub const MAX_STEP_MOUNTAIN: i32 = 6;

/// Biome classification thresholds on raw 2-octave fbm values (mean ≈ 512).
pub const RELIEF_MOUNTAINS: i32 = 640;
pub const TEMP_SNOWY: i32 = 380;
pub const TEMP_DESERT: i32 = 560;
pub const MOIST_DESERT: i32 = 520;
pub const MOIST_FOREST: i32 = 550;

const SALT_TEMP: u32 = 0x7E41_0001;
const SALT_MOIST: u32 = 0x3015_0002;
const SALT_RELIEF: u32 = 0x5E1F_0003;
const SALT_HEIGHT: u32 = 0x4E16_0004;

/// World-space cell log2 of the temperature/moisture and relief channels.
const CLIMATE_CELL: u32 = 8;
const RELIEF_CELL: u32 = 7;
/// Detail height noise: 3 octaves, cells 32/16/8.
const HEIGHT_OCT: u32 = 3;
const HEIGHT_CELL: u32 = 5;

/// Lattice stride (log2) for param blending, and box radius in lattice points.
const LAT: u32 = 2;
const BOX_R: usize = 2;
const BOX: usize = 2 * BOX_R + 1; // 5
/// Lattice points the chunk path samples per axis: 5 interpolation points + 2·BOX_R margin.
const LAT_N: usize = 16 / (1 << LAT) + 1 + 2 * BOX_R; // 9
/// Blended-param scale: BOX² samples × 16 bilinear weight.
const PARAM_SCALE: i32 = (BOX * BOX) as i32 * 16;

/// Biome of a column.
#[repr(u8)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Biome {
    #[default]
    Plains = 0,
    Forest = 1,
    Desert = 2,
    Snowy = 3,
    Mountains = 4,
}

/// Per-column results of stage 1, needed by later stages (index `lz * 16 + lx`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stage1Info {
    pub heights: [i32; 256],
    pub biomes: [Biome; 256],
}

/// Biome from raw channel values (see module docs).
#[inline(always)]
pub fn classify(t: i32, m: i32, r: i32) -> Biome {
    if r > RELIEF_MOUNTAINS {
        Biome::Mountains
    } else if t < TEMP_SNOWY {
        Biome::Snowy
    } else if t > TEMP_DESERT && m < MOIST_DESERT {
        Biome::Desert
    } else if m > MOIST_FOREST {
        Biome::Forest
    } else {
        Biome::Plains
    }
}

/// Height parameters `(base, amp)` of a biome: `h ≈ base + amp · nn/512`.
#[inline(always)]
pub fn params(b: Biome) -> (i32, i32) {
    match b {
        Biome::Plains => (30, 5),
        Biome::Forest => (32, 6),
        Biome::Desert => (31, 4),
        Biome::Snowy => (30, 5),
        Biome::Mountains => (43, 14),
    }
}

/// Biome of world column `(x, z)`.
pub fn biome_at(seed: &Seed, x: i32, z: i32) -> Biome {
    classify(
        fbm_2d(seed, x, z, 2, CLIMATE_CELL, SALT_TEMP),
        fbm_2d(seed, x, z, 2, CLIMATE_CELL, SALT_MOIST),
        fbm_2d(seed, x, z, 2, RELIEF_CELL, SALT_RELIEF),
    )
}

/// Biome at lattice point `(i, j)`; equals `biome_at(4i, 4j)` exactly.
fn lattice_biome(seed: &Seed, i: i32, j: i32) -> Biome {
    classify(
        fbm_2d(seed, i, j, 2, CLIMATE_CELL - LAT, SALT_TEMP),
        fbm_2d(seed, i, j, 2, CLIMATE_CELL - LAT, SALT_MOIST),
        fbm_2d(seed, i, j, 2, RELIEF_CELL - LAT, SALT_RELIEF),
    )
}

/// [`biome_at`] for all 256 columns of chunk `(cx, cz)` (index `lz * 16 + lx`).
pub fn biomes_chunk(seed: &Seed, cx: i32, cz: i32, out: &mut [Biome; 256]) {
    let (ox, oz) = (cx.wrapping_mul(16), cz.wrapping_mul(16));
    let (mut t, mut m, mut r) = ([0i32; 256], [0i32; 256], [0i32; 256]);
    fbm_chunk(seed, ox, oz, 2, CLIMATE_CELL, SALT_TEMP, &mut t);
    fbm_chunk(seed, ox, oz, 2, CLIMATE_CELL, SALT_MOIST, &mut m);
    fbm_chunk(seed, ox, oz, 2, RELIEF_CELL, SALT_RELIEF, &mut r);
    for i in 0..256 {
        out[i] = classify(t[i], m[i], r[i]);
    }
}

/// Detail noise remapped from the 3-octave percentile band to `-512..=512`.
#[inline(always)]
fn remap_detail(n: i32) -> i32 {
    // (n − lo) · 1024 / (hi − lo) − 512 with the ratio as a 10-bit fixed-point multiplier.
    const MUL: i32 = (1024 << 10) / (SPREAD_3OCT.1 - SPREAD_3OCT.0);
    ((((n - SPREAD_3OCT.0) * MUL) >> 10) - 512).clamp(-512, 512)
}

/// Height from blended params (scaled by [`PARAM_SCALE`]) and remapped detail noise.
#[inline(always)]
fn height_from(base_s: i32, amp_s: i32, nn: i32) -> i32 {
    let den = PARAM_SCALE * 512;
    ((base_s * 512 + amp_s * nn + den / 2).div_euclid(den)).clamp(MIN_HEIGHT, MAX_HEIGHT)
}

/// Bilinear blend of four box sums with in-cell offsets `fx, fz ∈ 0..4`.
#[inline(always)]
fn bilerp(s00: i32, s10: i32, s01: i32, s11: i32, fx: i32, fz: i32) -> i32 {
    let (gx, gz) = (4 - fx, 4 - fz);
    s00 * gx * gz + s10 * fx * gz + s01 * gx * fz + s11 * fx * fz
}

/// Box sum of `(base, amp)` over the 5×5 lattice neighborhood of lattice point `(i, j)`.
fn box_params(seed: &Seed, i: i32, j: i32) -> (i32, i32) {
    let (mut b, mut a) = (0, 0);
    for dj in -(BOX_R as i32)..=BOX_R as i32 {
        for di in -(BOX_R as i32)..=BOX_R as i32 {
            let (pb, pa) = params(lattice_biome(seed, i + di, j + dj));
            b += pb;
            a += pa;
        }
    }
    (b, a)
}

/// Surface height of world column `(x, z)`, in `MIN_HEIGHT..=MAX_HEIGHT`.
/// Reference implementation (≈ 100 lattice biome evaluations); use [`heights_chunk`] in
/// hot paths.
pub fn height_at(seed: &Seed, x: i32, z: i32) -> i32 {
    let (i, j) = (x >> LAT, z >> LAT);
    let (fx, fz) = (x & 3, z & 3);
    let p00 = box_params(seed, i, j);
    let p10 = box_params(seed, i + 1, j);
    let p01 = box_params(seed, i, j + 1);
    let p11 = box_params(seed, i + 1, j + 1);
    let b = bilerp(p00.0, p10.0, p01.0, p11.0, fx, fz);
    let a = bilerp(p00.1, p10.1, p01.1, p11.1, fx, fz);
    let n = fbm_2d(seed, x, z, HEIGHT_OCT, HEIGHT_CELL, SALT_HEIGHT);
    height_from(b, a, remap_detail(n))
}

/// [`height_at`] for all 256 columns of chunk `(cx, cz)` (index `lz * 16 + lx`).
///
/// Samples the 9×9 lattice biomes covering the chunk + box margin with one `fbm_chunk` per
/// channel in lattice space, box-sums them separably into the 5×5 interpolation points, then
/// interpolates per column.
pub fn heights_chunk(seed: &Seed, cx: i32, cz: i32, out: &mut [i32; 256]) {
    let (ox, oz) = (cx.wrapping_mul(16), cz.wrapping_mul(16));
    // Lattice origin: chunk's first lattice point minus the box margin.
    let (li, lj) = ((ox >> LAT) - BOX_R as i32, (oz >> LAT) - BOX_R as i32);
    let (mut t, mut m, mut r) = ([0i32; 256], [0i32; 256], [0i32; 256]);
    fbm_chunk(seed, li, lj, 2, CLIMATE_CELL - LAT, SALT_TEMP, &mut t);
    fbm_chunk(seed, li, lj, 2, CLIMATE_CELL - LAT, SALT_MOIST, &mut m);
    fbm_chunk(seed, li, lj, 2, RELIEF_CELL - LAT, SALT_RELIEF, &mut r);

    // Horizontal box sums: rows[j][a] = Σ params(j, a..a+5), a in 0..5.
    const NI: usize = LAT_N - 2 * BOX_R; // 5 interpolation points per axis
    let mut rows = [[(0i32, 0i32); NI]; LAT_N];
    for (j, row) in rows.iter_mut().enumerate() {
        let mut p = [(0i32, 0i32); LAT_N];
        for (i, v) in p.iter_mut().enumerate() {
            let k = j * 16 + i;
            *v = params(classify(t[k], m[k], r[k]));
        }
        for (a, s) in row.iter_mut().enumerate() {
            for v in &p[a..a + BOX] {
                s.0 += v.0;
                s.1 += v.1;
            }
        }
    }
    // Vertical box sums: sums[b][a] = Σ rows[b..b+5][a].
    let mut sums = [[(0i32, 0i32); NI]; NI];
    for (b, srow) in sums.iter_mut().enumerate() {
        for row in &rows[b..b + BOX] {
            for (s, v) in srow.iter_mut().zip(row) {
                s.0 += v.0;
                s.1 += v.1;
            }
        }
    }

    fbm_chunk(seed, ox, oz, HEIGHT_OCT, HEIGHT_CELL, SALT_HEIGHT, out);
    for lz in 0..16 {
        let (b, fz) = (lz >> 2, (lz & 3) as i32);
        for lx in 0..16 {
            let (a, fx) = (lx >> 2, (lx & 3) as i32);
            let (s00, s10, s01, s11) = (
                sums[b][a],
                sums[b][a + 1],
                sums[b + 1][a],
                sums[b + 1][a + 1],
            );
            let base = bilerp(s00.0, s10.0, s01.0, s11.0, fx, fz);
            let amp = bilerp(s00.1, s10.1, s01.1, s11.1, fx, fz);
            let o = &mut out[lz * 16 + lx];
            *o = height_from(base, amp, remap_detail(*o));
        }
    }
}

/// `(surface, filler)` blocks of a column.
#[inline(always)]
fn surface_of(b: Biome, h: i32) -> (Block, Block) {
    if h <= SEA_LEVEL + 1 {
        let filler = if b == Biome::Desert {
            Block::Sandstone
        } else {
            Block::Dirt
        };
        return (Block::Sand, filler);
    }
    match b {
        Biome::Plains | Biome::Forest => (Block::Grass, Block::Dirt),
        Biome::Desert => (Block::Sand, Block::Sandstone),
        Biome::Snowy => (Block::Snow, Block::Dirt),
        Biome::Mountains if h > SNOW_LINE => (Block::Snow, Block::Stone),
        Biome::Mountains if h >= STONE_LINE => (Block::Stone, Block::Stone),
        Biome::Mountains => (Block::Grass, Block::Dirt),
    }
}

/// Stage-1 generation of chunk `(cx, cz)` into `out` (every byte is written; prior content
/// is irrelevant). Returns per-column heights and biomes for later stages.
pub fn generate_stage1(seed: &Seed, cx: i32, cz: i32, out: &mut [u8; CHUNK_VOL]) -> Stage1Info {
    let mut info = Stage1Info {
        heights: [0; 256],
        biomes: [Biome::Plains; 256],
    };
    biomes_chunk(seed, cx, cz, &mut info.biomes);
    heights_chunk(seed, cx, cz, &mut info.heights);

    let (mut hmin, mut hmax) = (MAX_HEIGHT, MIN_HEIGHT);
    for &h in &info.heights {
        hmin = hmin.min(h);
        hmax = hmax.max(h);
    }
    // Per-byte band; everything outside it is a bulk fill.
    let lo = (hmin - 3).max(1) as usize;
    let hi = hmax.max(SEA_LEVEL) as usize;
    const L: usize = 256;
    out[..L].fill(Block::Bedrock as u8);
    out[L..lo * L].fill(Block::Stone as u8);
    out[(hi + 1) * L..].fill(Block::Air as u8);

    for c in 0..256 {
        let (h, b) = (info.heights[c] as usize, info.biomes[c]);
        let (surface, filler) = surface_of(b, h as i32);
        let filler_lo = h.saturating_sub(3).max(lo);
        let mut i = lo * L + c;
        for _ in lo..filler_lo {
            out[i] = Block::Stone as u8;
            i += L;
        }
        for _ in filler_lo..h {
            out[i] = filler as u8;
            i += L;
        }
        out[i] = surface as u8;
        i += L;
        let sea = SEA_LEVEL as usize;
        for _ in h + 1..=sea {
            out[i] = Block::WaterSource as u8;
            i += L;
        }
        if b == Biome::Snowy && h < sea {
            out[sea * L + c] = Block::Ice as u8;
        }
        for _ in h.max(sea) + 1..=hi {
            out[i] = Block::Air as u8;
            i += L;
        }
    }
    info
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blocks::Block;
    use crate::coords::block_index;

    fn seed(tag: u8) -> Seed {
        let mut b = [0u8; 32];
        for (i, v) in b.iter_mut().enumerate() {
            *v = (i as u8).wrapping_mul(37).wrapping_add(tag);
        }
        Seed::new(&b)
    }

    const CHUNKS: [(i32, i32); 7] = [
        (0, 0),
        (1, 0),
        (-1, -1),
        (3, -7),
        (-12, 5),
        (40, 40),
        (-100, 63),
    ];

    fn col_block(out: &[u8; CHUNK_VOL], lx: usize, y: i32, lz: usize) -> u8 {
        out[block_index(lx, y as usize, lz)]
    }

    #[test]
    fn deterministic() {
        let s = seed(1);
        let mut a = [0u8; CHUNK_VOL];
        let mut b = [7u8; CHUNK_VOL];
        for &(cx, cz) in &CHUNKS {
            let ia = generate_stage1(&s, cx, cz, &mut a);
            let ib = generate_stage1(&s, cx, cz, &mut b);
            assert!(a == b, "chunk {cx},{cz} differs");
            assert_eq!(ia.heights, ib.heights);
            assert_eq!(ia.biomes, ib.biomes);
        }
        // A different seed gives different terrain.
        let ia = generate_stage1(&s, 0, 0, &mut a);
        let ib = generate_stage1(&seed(2), 0, 0, &mut b);
        assert!(ia.heights != ib.heights);
    }

    #[test]
    fn bedrock_floor_and_contiguous_columns() {
        let s = seed(3);
        let mut out = [0u8; CHUNK_VOL];
        for &(cx, cz) in &CHUNKS {
            let info = generate_stage1(&s, cx, cz, &mut out);
            for lz in 0..16 {
                for lx in 0..16 {
                    let h = info.heights[lz * 16 + lx];
                    assert!((MIN_HEIGHT..=MAX_HEIGHT).contains(&h));
                    assert_eq!(col_block(&out, lx, 0, lz), Block::Bedrock as u8);
                    for y in 1..=h {
                        let b = col_block(&out, lx, y, lz);
                        assert!(
                            b != Block::Air as u8
                                && b < Block::WaterSource as u8
                                && b != Block::Ice as u8,
                            "non-solid {b} at {lx},{y},{lz} below surface {h}"
                        );
                    }
                    for y in h + 1..CHUNK_H as i32 {
                        let b = col_block(&out, lx, y, lz);
                        if y <= SEA_LEVEL {
                            let top_ice = y == SEA_LEVEL && b == Block::Ice as u8;
                            assert!(
                                b == Block::WaterSource as u8 || top_ice,
                                "{b} at {lx},{y},{lz}"
                            );
                        } else {
                            assert_eq!(b, Block::Air as u8, "{lx},{y},{lz}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn chunk_fns_match_point_fns() {
        let s = seed(4);
        let mut b = [Biome::Plains; 256];
        let mut h = [0i32; 256];
        for &(cx, cz) in &CHUNKS {
            biomes_chunk(&s, cx, cz, &mut b);
            heights_chunk(&s, cx, cz, &mut h);
            let mut out = [0u8; CHUNK_VOL];
            let info = generate_stage1(&s, cx, cz, &mut out);
            assert_eq!(info.heights, h);
            assert_eq!(info.biomes, b);
            for lz in 0..16 {
                for lx in 0..16 {
                    let (x, z) = (cx * 16 + lx as i32, cz * 16 + lz as i32);
                    assert_eq!(b[lz * 16 + lx], biome_at(&s, x, z), "biome {x},{z}");
                    assert_eq!(h[lz * 16 + lx], height_at(&s, x, z), "height {x},{z}");
                }
            }
        }
    }

    #[test]
    fn lattice_biome_matches_biome_at() {
        let s = seed(7);
        for j in -40..40 {
            for i in -40..40 {
                assert_eq!(
                    lattice_biome(&s, i, j),
                    biome_at(&s, 4 * i, 4 * j),
                    "{i},{j}"
                );
            }
        }
    }

    #[test]
    fn seams_and_slopes() {
        let s = seed(5);
        let (mut h0, mut h1) = ([0i32; 256], [0i32; 256]);
        heights_chunk(&s, 0, 0, &mut h0);
        heights_chunk(&s, 1, 0, &mut h1);
        for z in 0..16 {
            assert_eq!(h0[z * 16 + 15], height_at(&s, 15, z as i32));
            assert_eq!(h1[z * 16], height_at(&s, 16, z as i32));
        }
        // Max |dh| between adjacent columns over a 512x512 sweep (chunk fns + point fn at
        // chunk borders), split by whether either column is Mountains.
        let mut b = [Biome::Plains; 256];
        let (mut worst_flat, mut worst_mtn) = (0, 0);
        for cz in -16..16 {
            for cx in -16..16 {
                heights_chunk(&s, cx, cz, &mut h0);
                biomes_chunk(&s, cx, cz, &mut b);
                for lz in 0..16 {
                    for lx in 0..16 {
                        let (x, z) = (cx * 16 + lx as i32, cz * 16 + lz as i32);
                        let h = h0[lz * 16 + lx];
                        let m0 = b[lz * 16 + lx] == Biome::Mountains;
                        let (hx, mx) = if lx < 15 {
                            (
                                h0[lz * 16 + lx + 1],
                                b[lz * 16 + lx + 1] == Biome::Mountains,
                            )
                        } else {
                            (
                                height_at(&s, x + 1, z),
                                biome_at(&s, x + 1, z) == Biome::Mountains,
                            )
                        };
                        let (hz, mz) = if lz < 15 {
                            (
                                h0[lz * 16 + 16 + lx],
                                b[lz * 16 + 16 + lx] == Biome::Mountains,
                            )
                        } else {
                            (
                                height_at(&s, x, z + 1),
                                biome_at(&s, x, z + 1) == Biome::Mountains,
                            )
                        };
                        for (hn, mn) in [(hx, mx), (hz, mz)] {
                            let d = (hn - h).abs();
                            if m0 || mn {
                                worst_mtn = worst_mtn.max(d);
                            } else {
                                worst_flat = worst_flat.max(d);
                            }
                        }
                    }
                }
            }
        }
        println!("max adjacent dh: non-mountain {worst_flat}, mountain {worst_mtn}");
        assert!(
            worst_flat <= MAX_STEP_FLAT,
            "non-mountain step {worst_flat}"
        );
        assert!(worst_mtn <= MAX_STEP_MOUNTAIN, "mountain step {worst_mtn}");
    }

    #[test]
    fn biome_coverage_sea_and_surfaces() {
        for tag in [6u8, 60, 200] {
            coverage(&seed(tag));
        }
    }

    fn coverage(s: &Seed) {
        let s = *s;
        let mut counts = [0u32; 5];
        let (mut sea, mut total, mut hmax) = (0u32, 0u32, 0);
        for cz in -32..32 {
            for cx in -32..32 {
                let (x, z) = (cx * 16 + 7, cz * 16 + 7);
                counts[biome_at(&s, x, z) as usize] += 1;
                let h = height_at(&s, x, z);
                sea += (h < SEA_LEVEL) as u32;
                hmax = hmax.max(h);
                total += 1;
            }
        }
        println!("biomes {counts:?} sea {sea}/{total} max h {hmax}");
        for (i, &c) in counts.iter().enumerate() {
            assert!(c > total / 50, "biome {i} too rare: {counts:?}");
        }
        assert!(
            sea > total / 50 && sea < total / 2,
            "sea columns {sea}/{total}"
        );
        assert!(hmax > 48, "no tall mountains: {hmax}");

        // Surfaces: desert sand, snowy sea ice, sea water up to SEA_LEVEL, mountain snow.
        let mut out = [0u8; CHUNK_VOL];
        let (mut desert_sand, mut snowy_ice, mut grass, mut snow_cap) = (0, 0, 0, 0);
        for cz in -32..32 {
            for cx in -32..32 {
                let info = generate_stage1(&s, cx, cz, &mut out);
                for lz in 0..16 {
                    for lx in 0..16 {
                        let i = lz * 16 + lx;
                        let (h, b) = (info.heights[i], info.biomes[i]);
                        let top = col_block(&out, lx, h, lz);
                        if b == Biome::Desert {
                            assert_eq!(top, Block::Sand as u8);
                            desert_sand += 1;
                        }
                        if h <= SEA_LEVEL + 1 && !(b == Biome::Mountains && h > SNOW_LINE) {
                            assert_eq!(top, Block::Sand as u8, "beach at {cx},{cz} {lx},{lz}");
                        }
                        if h < SEA_LEVEL {
                            let w = col_block(&out, lx, SEA_LEVEL, lz);
                            if b == Biome::Snowy {
                                assert_eq!(w, Block::Ice as u8);
                                snowy_ice += 1;
                            } else {
                                assert_eq!(w, Block::WaterSource as u8);
                            }
                            for y in h + 1..SEA_LEVEL {
                                assert_eq!(col_block(&out, lx, y, lz), Block::WaterSource as u8);
                            }
                        }
                        if top == Block::Grass as u8 {
                            grass += 1;
                        }
                        if b == Biome::Mountains && h > SNOW_LINE {
                            assert_eq!(top, Block::Snow as u8);
                            snow_cap += 1;
                        }
                    }
                }
            }
        }
        println!(
            "desert sand {desert_sand} snowy ice {snowy_ice} grass {grass} snow caps {snow_cap}"
        );
        assert!(desert_sand > 0 && snowy_ice > 0 && grass > 0 && snow_cap > 0);
    }

    #[test]
    #[ignore]
    fn bench_stage1() {
        let s = seed(8);
        const REPS: i32 = 2000;
        let mut out = [0u8; CHUNK_VOL];
        let mut acc = 0i64;
        let t = std::time::Instant::now();
        for r in 0..REPS {
            let info = generate_stage1(&s, r % 64 - 32, r / 64 - 16, &mut out);
            acc += info.heights[17] as i64 + out[5000] as i64;
        }
        let per = t.elapsed() / REPS as u32;
        let t = std::time::Instant::now();
        let mut h = [0i32; 256];
        for r in 0..REPS {
            heights_chunk(&s, r % 64 - 32, r / 64 - 16, &mut h);
            acc += h[3] as i64;
        }
        let per_h = t.elapsed() / REPS as u32;
        println!("generate_stage1: {per:?}/chunk  heights_chunk: {per_h:?}  (acc {acc})");
    }
}
