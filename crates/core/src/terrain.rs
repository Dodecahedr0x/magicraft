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
//! Each biome has `(base, amp)` ([`params`]). Low relief also lowers the base: a lattice
//! point with `r < LOWLAND_R` gets `base −= LOWLAND_DEPTH · min(LOWLAND_R − r, LOWLAND_SPAN) /
//! LOWLAND_SPAN` (in 1/8 blocks), which carves seas and lakes out of the relief channel
//! (low relief = lowland, high relief = mountains) with no extra noise.
//!
//! Blending: per-lattice-point params are sampled on a coarse lattice of stride 4 (world
//! points `(4i, 4j)`), box-summed over a 5×5 lattice neighborhood (a 20×20-block window), and
//! bilinearly interpolated between the four surrounding lattice points. This is continuous,
//! so biome borders ramp over ≈ 20 blocks instead of forming walls. The same box sum counts
//! Mountains samples, giving a continuous mountain weight `w ∈ 0..=1`.
//!
//! Detail: `n` = 3-octave fbm (cells 32/16/8) remapped from
//! [`SPREAD_3OCT`] to `nn ∈ -512..=512` (clamped); the ridged
//! variant is `ridge = 384 − 3|nn|/2 ∈ -384..=384` (sharp crests where `nn ≈ 0`; slope 1.5×
//! the rolling noise, which keeps mountain steps ≤ 6). Detail is
//! `d = (1 − w)·nn + w·ridge`, so mountains get ridges and everything else stays rolling, and
//! `h = round(base + amp · d / 512)` clamped to `MIN_HEIGHT..=MAX_HEIGHT`.
//!
//! Lattice trick: sampling an fbm with world cell `2^k` at `x = 4i` equals sampling the
//! same fbm with cell `2^(k−2)` at `i` (index `4i >> k = i >> (k−2)`, fraction identical) as
//! long as every octave's world cell is ≥ 4 (const-asserted). The chunk path therefore gets
//! the lattice samples it needs from one [`fbm_rect`] per channel over a lattice sub-grid
//! (`lattice_sums`), bit-exact with [`biome_at`]`(4i, 4j)`. Box sums are running sums and
//! the bilinear blend is separable (exact integers, so equal to the direct formulas, which
//! [`height_at`] keeps as the reference).
//!
//! # Column fill (stage 1)
//! y=0 bedrock; stone `1..=h−4`; 3 filler blocks; surface at `h`; water `h+1..=SEA_LEVEL`
//! (top layer Ice in Snowy); air above. Surfaces: any column with `h ≤ SEA_LEVEL+1` is
//! Sand (beach / sea floor). Otherwise Plains/Forest Grass over Dirt; Desert Sand over
//! Sandstone (also under beaches in desert); Snowy Snow over Dirt; Mountains Grass over Dirt
//! below `STONE_LINE` (42), bare Stone in `STONE_LINE..=SNOW_LINE`, Snow over Stone above
//! `SNOW_LINE` (50).
//!
//! # Cost (SBF-measured with `bench/cu`, Task 17b; see `docs/notes/spikes.md`)
//! `generate_stage1` ≈ **150-175k CU** (was 540-610k): [`biomes_chunk`] ≈ 51k,
//! [`heights_chunk`] ≈ 70k, column fill ≈ 30-50k (rows from `min(h)−3` up are bulk-filled
//! with water/air, then each column writes only its solid part). [`fbm_rect`] ≈ 6.2k per
//! 256-sample octave pass. [`heights_cols`]: 2×16 strip ≈ 30k, 2×2 corner ≈ 19k; populate
//! uses [`WindowSums`] (≈ 38k once) + [`window_heights`] (strip ≈ 9.6k, corner ≈ 3k)
//! instead. [`stage1_info_from_blocks`] ≈ 30-34k. The big Task 17 costs were signed `i64`
//! divisions (a ~200 CU routine each: one per noise sample and one per column height),
//! now unsigned on provably non-negative values. Measured with `overflow-checks = false`
//! for this crate in release (checked `i64` multiply is a software routine on SBF).
//!
//! # SBF stack (4 KB per frame)
//! The heavy functions are `#[inline(never)]` so their locals never pile up in one frame.
//! Estimated frames: [`fbm_rect`] ≈ 1.5 KB (17 × 16 row table + axis tables),
//! [`biomes_chunk`] ≈ 2.1 KB (two 256 × i32 buffers), `lattice_sums` ≤ 2.6 KB (three
//! 11 × 11 × i32 lattice grids + box-sum tables), `blend_heights` ≤ 1 KB,
//! [`heights_cols`] / [`window_heights`] < 0.5 KB, [`generate_stage1`] < 0.2 KB
//! ([`Stage1Info`], 1.25 KB, is caller-provided).

use crate::blocks::{is_fluid_u8, Block};
use crate::consts::{CHUNK_H, CHUNK_VOL, SEA_LEVEL};
use crate::hash::Seed;
use crate::noise::{fbm_2d, fbm_chunk, fbm_rect, SPREAD_3OCT};

/// Lowest generated surface height.
pub const MIN_HEIGHT: i32 = 1;
/// Highest generated surface height (6 blocks of headroom for trees: y 58..=63).
pub const MAX_HEIGHT: i32 = CHUNK_H as i32 - 7;
/// Mountains above this height are snow-capped.
pub const SNOW_LINE: i32 = 50;
/// Mountains at or above this height (up to [`SNOW_LINE`]) have a bare stone surface.
pub const STONE_LINE: i32 = 42;
/// Bound on |Δh| between adjacent columns when neither is Mountains (asserted by tests;
/// measured max over 3 seeds × 512² columns: 4, reached only next to mountain blend zones).
pub const MAX_STEP_FLAT: i32 = 4;
/// Bound on |Δh| between adjacent columns when either is Mountains (asserted by tests;
/// measured max over 3 seeds × 512² columns: 6, on ridge flanks).
pub const MAX_STEP_MOUNTAIN: i32 = 6;

/// Biome classification thresholds on raw 2-octave fbm values (mean ≈ 512).
pub const RELIEF_MOUNTAINS: i32 = 640;
pub const TEMP_SNOWY: i32 = 380;
pub const TEMP_DESERT: i32 = 560;
pub const MOIST_DESERT: i32 = 520;
pub const MOIST_FOREST: i32 = 550;

/// Lowlands: relief below `LOWLAND_R` lowers the base by up to `LOWLAND_DEPTH` blocks,
/// reached at `LOWLAND_R − LOWLAND_SPAN`.
pub const LOWLAND_R: i32 = 410;
pub const LOWLAND_SPAN: i32 = 160;
pub const LOWLAND_DEPTH: i32 = 5;

const SALT_TEMP: u32 = 0x7E41_0001;
const SALT_MOIST: u32 = 0x3015_0002;
const SALT_RELIEF: u32 = 0x5E1F_0003;
const SALT_HEIGHT: u32 = 0x4E16_0004;

/// Biome channels: octaves and world-space cell log2.
const BIOME_OCT: u32 = 2;
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
/// Interpolation lattice points per chunk axis.
const NI: usize = LAT_N - 2 * BOX_R; // 5
/// Box sum × bilinear weight scale of blended params.
const BLEND: i64 = (BOX * BOX) as i64 * 16;

// Lattice trick precondition: every octave's world cell must be ≥ the lattice stride, so the
// lattice-space octave cells `k − LAT` never saturate at 0.
const _: () = assert!(CLIMATE_CELL >= LAT + BIOME_OCT - 1);
const _: () = assert!(RELIEF_CELL >= LAT + BIOME_OCT - 1);
const _: () = assert!(LAT_N * LAT_N == 81 && NI == 5);
const _: () = assert!(MAX_HEIGHT + 6 < CHUNK_H as i32);

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

impl Biome {
    /// Biome from its stored byte; out-of-range bytes map to Plains (fail soft: the byte
    /// array is program-written, so this never happens for a valid chunk).
    #[inline]
    pub fn from_u8(v: u8) -> Biome {
        match v {
            1 => Biome::Forest,
            2 => Biome::Desert,
            3 => Biome::Snowy,
            4 => Biome::Mountains,
            _ => Biome::Plains,
        }
    }
}

/// Per-column results of stage 1, needed by later stages (index `lz * 16 + lx`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stage1Info {
    pub heights: [i32; 256],
    pub biomes: [Biome; 256],
}

impl Stage1Info {
    pub const EMPTY: Stage1Info = Stage1Info {
        heights: [0; 256],
        biomes: [Biome::Plains; 256],
    };
}

/// Non-mountain biome from temperature and moisture.
#[inline(always)]
fn climate(t: i32, m: i32) -> Biome {
    if t < TEMP_SNOWY {
        Biome::Snowy
    } else if t > TEMP_DESERT && m < MOIST_DESERT {
        Biome::Desert
    } else if m > MOIST_FOREST {
        Biome::Forest
    } else {
        Biome::Plains
    }
}

/// Biome from raw channel values (see module docs).
#[inline(always)]
pub fn classify(t: i32, m: i32, r: i32) -> Biome {
    if r > RELIEF_MOUNTAINS {
        Biome::Mountains
    } else {
        climate(t, m)
    }
}

/// Height parameters `(base, amp)` of a biome: `h ≈ base + amp · d/512`.
#[inline(always)]
pub const fn params(b: Biome) -> (i32, i32) {
    match b {
        Biome::Plains => (30, 5),
        Biome::Forest => (32, 6),
        Biome::Desert => (31, 4),
        Biome::Snowy => (30, 5),
        Biome::Mountains => (41, 19),
    }
}

// `height_from` divides unsigned: its numerator is positive because every biome sample has
// `8·base − lowland − 8·amp > 0` (1/8 blocks, worst lowland depth) and `|d| ≤ 512·BLEND`.
const _: () = {
    let all = [
        Biome::Plains,
        Biome::Forest,
        Biome::Desert,
        Biome::Snowy,
        Biome::Mountains,
    ];
    let mut i = 0;
    while i < all.len() {
        let (base, amp) = params(all[i]);
        assert!(base * 8 - LOWLAND_DEPTH * 8 - amp * 8 > 0);
        i += 1;
    }
};

/// Per-lattice-point blend sample `(base in 1/8 blocks, amp, is_mountain)`.
#[inline(always)]
fn sample(b: Biome, r: i32) -> (i32, i32, i32) {
    let (base, amp) = params(b);
    let low = (LOWLAND_R - r).clamp(0, LOWLAND_SPAN) * (LOWLAND_DEPTH * 8) / LOWLAND_SPAN;
    (base * 8 - low, amp, (b == Biome::Mountains) as i32)
}

/// Biome of world column `(x, z)`.
pub fn biome_at(seed: &Seed, x: i32, z: i32) -> Biome {
    classify(
        fbm_2d(seed, x, z, BIOME_OCT, CLIMATE_CELL, SALT_TEMP),
        fbm_2d(seed, x, z, BIOME_OCT, CLIMATE_CELL, SALT_MOIST),
        fbm_2d(seed, x, z, BIOME_OCT, RELIEF_CELL, SALT_RELIEF),
    )
}

/// Biome and relief at lattice point `(i, j)`; equal to the values at world `(4i, 4j)`.
fn lattice_point(seed: &Seed, i: i32, j: i32) -> (Biome, i32) {
    let r = fbm_2d(seed, i, j, BIOME_OCT, RELIEF_CELL - LAT, SALT_RELIEF);
    let t = fbm_2d(seed, i, j, BIOME_OCT, CLIMATE_CELL - LAT, SALT_TEMP);
    let m = fbm_2d(seed, i, j, BIOME_OCT, CLIMATE_CELL - LAT, SALT_MOIST);
    (classify(t, m, r), r)
}

/// [`biome_at`] for all 256 columns of chunk `(cx, cz)` (index `lz * 16 + lx`).
/// Frame ≈ 2.1 KB (two 256 × i32 buffers; relief reuses the first).
#[inline(never)]
pub fn biomes_chunk(seed: &Seed, cx: i32, cz: i32, out: &mut [Biome; 256]) {
    let (ox, oz) = (cx.wrapping_mul(16), cz.wrapping_mul(16));
    let (mut a, mut b) = ([0i32; 256], [0i32; 256]);
    fbm_chunk(seed, ox, oz, BIOME_OCT, CLIMATE_CELL, SALT_TEMP, &mut a);
    fbm_chunk(seed, ox, oz, BIOME_OCT, CLIMATE_CELL, SALT_MOIST, &mut b);
    for i in 0..256 {
        out[i] = climate(a[i], b[i]);
    }
    fbm_chunk(seed, ox, oz, BIOME_OCT, RELIEF_CELL, SALT_RELIEF, &mut a);
    for i in 0..256 {
        if a[i] > RELIEF_MOUNTAINS {
            out[i] = Biome::Mountains;
        }
    }
}

/// Detail noise remapped from the 3-octave percentile band to `-512..=512`.
#[inline(always)]
fn remap_detail(n: i32) -> i32 {
    // (n − lo) · 1024 / (hi − lo) − 512 with the ratio as a 10-bit fixed-point multiplier.
    const MUL: i32 = (1024 << 10) / (SPREAD_3OCT.1 - SPREAD_3OCT.0);
    ((((n - SPREAD_3OCT.0) * MUL) >> 10) - 512).clamp(-512, 512)
}

/// Height from blended sums (each scaled by [`BLEND`]; base also by 8) and raw detail noise.
#[inline(always)]
fn height_from(base: i32, amp: i32, mtn: i32, n: i32) -> i32 {
    let nn = remap_detail(n) as i64;
    let ridge = 384 - 3 * nn.abs() / 2;
    let w = mtn as i64; // 0..=BLEND
    let d = nn * (BLEND - w) + ridge * w; // detail × BLEND, in ±512·BLEND
                                          // h = base/(8·BLEND) + (amp/BLEND)·d/(512·BLEND)
    let den = 8 * BLEND * BLEND * 512;
    let num = base as i64 * BLEND * 512 + amp as i64 * 8 * d;
    // `num > 0`: every sample has `8·base − lowland − 8·amp ≥ 136 > 0` (1/8 blocks; Plains
    // 240 − 40 − 40, Mountains 328 − 40 − 152; const-asserted after `params`) and
    // `|d| ≤ 512·BLEND`, so the blend is positive. Unsigned division (one SBF instruction)
    // then equals `div_euclid`; signed `i64` division is a ~200 CU software routine on SBF.
    debug_assert!(num >= 0);
    (((num + den / 2) as u64 / den as u64) as i32).clamp(MIN_HEIGHT, MAX_HEIGHT)
}

/// Bilinear blend of four box sums with in-cell offsets `fx, fz ∈ 0..4`.
#[inline(always)]
fn bilerp(s00: i32, s10: i32, s01: i32, s11: i32, fx: i32, fz: i32) -> i32 {
    let (gx, gz) = (4 - fx, 4 - fz);
    s00 * gx * gz + s10 * fx * gz + s01 * gx * fz + s11 * fx * fz
}

type Sums = (i32, i32, i32);

#[inline(always)]
fn add(s: &mut Sums, v: Sums) {
    s.0 += v.0;
    s.1 += v.1;
    s.2 += v.2;
}

#[inline(always)]
fn sub(s: &mut Sums, v: Sums) {
    s.0 -= v.0;
    s.1 -= v.1;
    s.2 -= v.2;
}

/// Bilinear blend of the four corner sums.
#[inline(always)]
fn blend(c: [Sums; 4], fx: i32, fz: i32) -> Sums {
    (
        bilerp(c[0].0, c[1].0, c[2].0, c[3].0, fx, fz),
        bilerp(c[0].1, c[1].1, c[2].1, c[3].1, fx, fz),
        bilerp(c[0].2, c[1].2, c[2].2, c[3].2, fx, fz),
    )
}

/// Box sum of samples over the 5×5 lattice neighborhood of lattice point `(i, j)`.
fn box_sums(seed: &Seed, i: i32, j: i32) -> Sums {
    let mut s = (0, 0, 0);
    for dj in -(BOX_R as i32)..=BOX_R as i32 {
        for di in -(BOX_R as i32)..=BOX_R as i32 {
            let (b, r) = lattice_point(seed, i + di, j + dj);
            add(&mut s, sample(b, r));
        }
    }
    s
}

/// Surface height of world column `(x, z)`, in `MIN_HEIGHT..=MAX_HEIGHT`.
/// Reference implementation (≈ 100 lattice evaluations); use [`heights_chunk`] in hot paths.
pub fn height_at(seed: &Seed, x: i32, z: i32) -> i32 {
    let (i, j) = (x >> LAT, z >> LAT);
    let c = [
        box_sums(seed, i, j),
        box_sums(seed, i + 1, j),
        box_sums(seed, i, j + 1),
        box_sums(seed, i + 1, j + 1),
    ];
    let (b, a, w) = blend(c, x & 3, z & 3);
    let n = fbm_2d(seed, x, z, HEIGHT_OCT, HEIGHT_CELL, SALT_HEIGHT);
    height_from(b, a, w, n)
}

/// Largest lattice sub-grid side sampled by [`lattice_sums`] (`WIN_LAT + 2·BOX_R`).
const GRID_MAX: usize = WIN_LAT + 2 * BOX_R; // 11

/// Blended `(base, amp, mountain)` box sums `sums[b][a]` at world lattice points
/// `(li0 + a, lj0 + b)` for `a ∈ a0..a0+na`, `b ∈ b0..b0+nb` (others zero).
///
/// Samples only the `(na + 4) × (nb + 4)` lattice sub-grid those box sums need with one
/// [`fbm_rect`] per channel, and box-sums separably with running sums (exact integers, so
/// equal to the direct 5×5 sums of [`box_sums`]). Frame ≈ 2.5 KB at `S = 7`.
#[inline(never)]
fn lattice_sums<const S: usize>(
    seed: &Seed,
    (li0, lj0): (i32, i32),
    (a0, na): (usize, usize),
    (b0, nb): (usize, usize),
) -> [[Sums; S]; S] {
    const { assert!(S + 2 * BOX_R <= GRID_MAX) };
    assert!(na >= 1 && nb >= 1 && a0 + na <= S && b0 + nb <= S);
    let (gw, gd) = (na + 2 * BOX_R, nb + 2 * BOX_R);
    let li = li0 + a0 as i32 - BOX_R as i32;
    let lj = lj0 + b0 as i32 - BOX_R as i32;
    const G: usize = GRID_MAX * GRID_MAX;
    let (mut t, mut m, mut r) = ([0i32; G], [0i32; G], [0i32; G]);
    let lc = CLIMATE_CELL - LAT;
    let lr = RELIEF_CELL - LAT;
    fbm_rect(seed, li, lj, gw, gd, BIOME_OCT, lc, SALT_TEMP, &mut t);
    fbm_rect(seed, li, lj, gw, gd, BIOME_OCT, lc, SALT_MOIST, &mut m);
    fbm_rect(seed, li, lj, gw, gd, BIOME_OCT, lr, SALT_RELIEF, &mut r);

    // Horizontal box sums: rows[j][a] = Σ sample(j, a..a+5), a in 0..na (running sum).
    let mut rows = [[(0i32, 0i32, 0i32); S]; GRID_MAX];
    let mut p = [(0i32, 0i32, 0i32); GRID_MAX];
    for (j, row) in rows.iter_mut().enumerate().take(gd) {
        let k0 = j * gw;
        for (i, v) in p.iter_mut().enumerate().take(gw) {
            let (t, m, r) = (t[k0 + i], m[k0 + i], r[k0 + i]);
            *v = sample(classify(t, m, r), r);
        }
        let mut s = (0, 0, 0);
        for &v in &p[..BOX] {
            add(&mut s, v);
        }
        row[0] = s;
        for a in 1..na {
            add(&mut s, p[a + BOX - 1]);
            sub(&mut s, p[a - 1]);
            row[a] = s;
        }
    }
    // Vertical box sums: sums[b0 + b][a0 + a] = Σ rows[b..b+5][a] (running sum).
    let mut sums = [[(0i32, 0i32, 0i32); S]; S];
    let mut s = [(0i32, 0i32, 0i32); S];
    for row in &rows[..BOX] {
        for (s, &v) in s.iter_mut().zip(row).take(na) {
            add(s, v);
        }
    }
    sums[b0][a0..a0 + na].copy_from_slice(&s[..na]);
    for b in 1..nb {
        for (a, s) in s.iter_mut().enumerate().take(na) {
            add(s, rows[b + BOX - 1][a]);
            sub(s, rows[b - 1][a]);
        }
        sums[b0 + b][a0..a0 + na].copy_from_slice(&s[..na]);
    }
    sums
}

/// Heights of the `w × d` columns at chunk-local `(x0, z0)` (may be negative / ≥ 16 for
/// window margins) from lattice sums `sums` whose index 0 is chunk lattice point `-off`
/// (`sums[b][a]` = lattice `((x >> 2) + off, …)`), and the raw detail noise `n`
/// (`n[j · w + i]`, overwritten with the heights).
///
/// The bilinear blend is separable: per lattice row `b` the `x` interpolation
/// `s[b][a]·(4 − fx) + s[b][a+1]·fx` is computed once per column, then each column combines
/// two rows along `z`. Exact integer arithmetic, so it equals [`bilerp`] bit for bit.
#[inline(never)]
fn blend_heights<const S: usize>(
    sums: &[[Sums; S]; S],
    off: i32,
    (x0, w): (i32, usize),
    (z0, d): (i32, usize),
    n: &mut [i32],
) {
    // xs[b][i]: lattice row `b` interpolated along x at column `x0 + i` (scaled by 4).
    let lat = |l: i32| ((l >> LAT) + off) as usize;
    let (b0, b1) = (lat(z0), lat(z0 + d as i32 - 1) + 1);
    let mut xs = [[(0i32, 0i32, 0i32); 16]; S];
    for b in b0..=b1 {
        for (i, x) in xs[b].iter_mut().enumerate().take(w) {
            let lx = x0 + i as i32;
            let (a, fx) = (lat(lx), lx & 3);
            let (s0, s1, gx) = (sums[b][a], sums[b][a + 1], 4 - fx);
            *x = (
                s0.0 * gx + s1.0 * fx,
                s0.1 * gx + s1.1 * fx,
                s0.2 * gx + s1.2 * fx,
            );
        }
    }
    for (j, row) in n.chunks_exact_mut(w).take(d).enumerate() {
        let lz = z0 + j as i32;
        let (b, fz) = (lat(lz), lz & 3);
        let gz = 4 - fz;
        for ((o, x0), x1) in row.iter_mut().zip(&xs[b]).zip(&xs[b + 1]) {
            let base = x0.0 * gz + x1.0 * fz;
            let amp = x0.1 * gz + x1.1 * fz;
            let mtn = x0.2 * gz + x1.2 * fz;
            *o = height_from(base, amp, mtn, *o);
        }
    }
}

/// [`height_at`] for all 256 columns of chunk `(cx, cz)` (index `lz * 16 + lx`).
/// Lattice sums on the chunk's 9×9 lattice + one 3-octave [`fbm_rect`] for the detail.
#[inline(never)]
pub fn heights_chunk(seed: &Seed, cx: i32, cz: i32, out: &mut [i32; 256]) {
    heights_cols(seed, cx, cz, 0, 0, 16, 16, out);
}

/// [`height_at`] for the `w × d` columns of chunk `(cx, cz)` starting at local
/// `(lx0, lz0)` (`1 ≤ w`, `1 ≤ d`, `lx0 + w ≤ 16`, `lz0 + d ≤ 16`, `w · d ≤ out.len()`),
/// written to `out[(lz − lz0) · w + (lx − lx0)]`. Bit-exact with [`heights_chunk`]: the
/// lattice box sums are computed only for the interpolation points the columns need (same
/// values), and the detail noise is one [`fbm_rect`] over the `w × d` columns (equal to
/// [`fbm_2d`] per column).
///
/// SBF-measured (`bench/cu`): 2×16 strip ≈ 30k CU, 2×2 corner ≈ 19k, full chunk ≈ 70k.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
pub fn heights_cols(
    seed: &Seed,
    cx: i32,
    cz: i32,
    lx0: usize,
    lz0: usize,
    w: usize,
    d: usize,
    out: &mut [i32],
) {
    assert!(w >= 1 && d >= 1 && lx0 + w <= 16 && lz0 + d <= 16);
    let (ox, oz) = (cx.wrapping_mul(16), cz.wrapping_mul(16));
    // Interpolation lattice points used: `lx >> 2 ..= (lx >> 2) + 1` per column.
    let span = |l0: usize, n: usize| (l0 >> LAT, ((l0 + n - 1) >> LAT) + 2 - (l0 >> LAT));
    let origin = (ox >> LAT, oz >> LAT);
    let sums = lattice_sums::<NI>(seed, origin, span(lx0, w), span(lz0, d));
    let (x, z) = (ox.wrapping_add(lx0 as i32), oz.wrapping_add(lz0 as i32));
    let n = &mut out[..w * d];
    fbm_rect(seed, x, z, w, d, HEIGHT_OCT, HEIGHT_CELL, SALT_HEIGHT, n);
    blend_heights::<NI>(&sums, 0, (lx0 as i32, w), (lz0 as i32, d), n);
}

/// Interpolation lattice points per axis of a chunk's populate height window (local
/// columns `-2..18`: lattice `(lx >> 2) ∈ -1..=4`, plus the `+1` corner → `-1..=5`).
pub const WIN_LAT: usize = 7;

/// Lattice box sums covering the populate height window of chunk `(cx, cz)` (local columns
/// `-2..18` on both axes), shared by all 8 neighbor parts: an 11×11 lattice sub-grid
/// instead of one 6×9 (side) or 6×6 (corner) grid per neighbor. Heights are a pure function
/// of the world column, so [`window_heights`] equals each neighbor's own stage 1 exactly.
///
/// Wrap seam: chunk origins are `cx.wrapping_mul(16)` and window/lattice coordinates use
/// wrapping `i32` arithmetic, exactly as stage 1 and [`heights_cols`] do, so results agree
/// everywhere; like the noise itself they are discontinuous where world `x`/`z` wraps past
/// `i32` (|cx| ≥ 2^27 chunks), which no bounded world reaches. Nothing panics there.
/// SBF-measured ≈ 33k CU; 588 B.
pub struct WindowSums([[Sums; WIN_LAT]; WIN_LAT]);

impl WindowSums {
    #[inline(never)]
    pub fn new(seed: &Seed, cx: i32, cz: i32) -> Self {
        let origin = (
            (cx.wrapping_mul(16) >> LAT) - 1,
            (cz.wrapping_mul(16) >> LAT) - 1,
        );
        let all = (0, WIN_LAT);
        WindowSums(lattice_sums::<WIN_LAT>(seed, origin, all, all))
    }
}

/// Stage-1 heights of the `w × d` window columns at chunk-local `(x0, z0)` of chunk
/// `(cx, cz)` (`-2 ≤ x0`, `x0 + w ≤ 18`, same for z; `1 ≤ w, d ≤ 16`), written to
/// `out[j · w + i]`. `sums` must be [`WindowSums::new`]`(seed, cx, cz)`. Equal to
/// [`heights_cols`] of the chunk owning each column. SBF-measured: 2×16 strip ≈ 6.5k CU,
/// 2×2 corner ≈ 3k.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
pub fn window_heights(
    seed: &Seed,
    sums: &WindowSums,
    cx: i32,
    cz: i32,
    (x0, w): (i32, usize),
    (z0, d): (i32, usize),
    out: &mut [i32],
) {
    assert!((1..=16).contains(&w) && (1..=16).contains(&d));
    assert!(x0 >= -2 && x0 + w as i32 <= 18 && z0 >= -2 && z0 + d as i32 <= 18);
    let x = cx.wrapping_mul(16).wrapping_add(x0);
    let z = cz.wrapping_mul(16).wrapping_add(z0);
    let n = &mut out[..w * d];
    fbm_rect(seed, x, z, w, d, HEIGHT_OCT, HEIGHT_CELL, SALT_HEIGHT, n);
    blend_heights::<WIN_LAT>(&sums.0, 1, (x0, w), (z0, d), n);
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

/// Rebuilds [`Stage1Info`] for `populate_chunk` from a chunk's **stage-1** blocks and the
/// 256 biome bytes the chunk stores (index `lz * 16 + lx`). Each height is the highest
/// `y ∈ MIN_HEIGHT..=MAX_HEIGHT` whose block is not air, water or ice (`MIN_HEIGHT` if
/// none) — exactly the stage-1 surface (stage 1 puts only air above `max(h, SEA_LEVEL)`,
/// water/ice in `h+1..=SEA_LEVEL`, and solid blocks at `0..=h` with `h ≥ MIN_HEIGHT`).
///
/// Stage-1 columns are solid exactly up to `h`, so the predicate is monotone in `y` and a
/// binary search finds `h` in 6 probes (a top-down scan needed up to 57). This relies on the
/// input being genuine stage-1 output: onchain, the stage-unchecked block accessors
/// `magicraft::state::chunk_parts_mut` / `chunk_blocks_mut` are for `grow_chunk` /
/// `populate_chunk` only, and gameplay edits go through `ready_chunk_mut`, which requires
/// `GEN_DONE` — so nothing can modify the blocks between stage 1 and populate. SBF-measured 30-34k CU (fixed). Frame < 0.1 KB.
#[inline(never)]
pub fn stage1_info_from_blocks(
    blocks: &[u8; CHUNK_VOL],
    biomes: &[u8; 256],
    info: &mut Stage1Info,
) {
    for c in 0..256 {
        info.biomes[c] = Biome::from_u8(biomes[c]);
        // Invariant: column solid at `lo` (or `lo == MIN_HEIGHT`), not solid at `hi`.
        let (mut lo, mut hi) = (MIN_HEIGHT as usize, MAX_HEIGHT as usize + 1);
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            let b = blocks[(mid & 63) * 256 + c];
            if b != Block::Air as u8 && !is_fluid_u8(b) && b != Block::Ice as u8 {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        info.heights[c] = lo as i32;
    }
}

/// Stage-1 generation of chunk `(cx, cz)` into `out` (every byte is written; prior content
/// is irrelevant). Fills `info` with per-column heights and biomes for later stages
/// (caller-provided so the 1.25 KB struct never sits in this frame).
#[inline(never)]
pub fn generate_stage1(
    seed: &Seed,
    cx: i32,
    cz: i32,
    out: &mut [u8; CHUNK_VOL],
    info: &mut Stage1Info,
) {
    biomes_chunk(seed, cx, cz, &mut info.biomes);
    heights_chunk(seed, cx, cz, &mut info.heights);

    let hmin = info.heights.iter().fold(MAX_HEIGHT, |m, &h| m.min(h));
    // Per-byte band `lo..=h` per column; everything else is a bulk fill (rows from `lo` up are
    // pre-filled with water up to SEA_LEVEL and air above, then each column writes only its
    // solid part `lo..=h`; ice is patched in).
    let lo = (hmin - 3).max(1) as usize;
    const L: usize = 256;
    let sea = SEA_LEVEL as usize;
    out[..L].fill(Block::Bedrock as u8);
    out[L..lo * L].fill(Block::Stone as u8);
    out[lo * L..(sea.max(lo - 1) + 1) * L].fill(Block::WaterSource as u8);
    out[(sea.max(lo - 1) + 1) * L..].fill(Block::Air as u8);

    for c in 0..256 {
        let (h, b) = (info.heights[c] as usize, info.biomes[c]);
        let (surface, filler) = surface_of(b, h as i32);
        let filler_lo = h.saturating_sub(3).max(lo);
        // Column bytes `lo..=h` (stride L): stone, filler, surface.
        let col = out[lo * L + c..=h * L + c].iter_mut().step_by(L);
        for (y, v) in (lo..).zip(col) {
            *v = if y < filler_lo {
                Block::Stone as u8
            } else if y < h {
                filler as u8
            } else {
                surface as u8
            };
        }
        if b == Biome::Snowy && h < sea {
            out[sea * L + c] = Block::Ice as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blocks::Block;
    use crate::coords::block_index;

    fn gen(s: &Seed, cx: i32, cz: i32, out: &mut [u8; CHUNK_VOL]) -> Stage1Info {
        let mut info = Stage1Info::EMPTY;
        generate_stage1(s, cx, cz, out, &mut info);
        info
    }

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
            let ia = gen(&s, cx, cz, &mut a);
            let ib = gen(&s, cx, cz, &mut b);
            assert!(a == b, "chunk {cx},{cz} differs");
            assert_eq!(ia.heights, ib.heights);
            assert_eq!(ia.biomes, ib.biomes);
        }
        // A different seed gives different terrain.
        let ia = gen(&s, 0, 0, &mut a);
        let ib = gen(&seed(2), 0, 0, &mut b);
        assert!(ia.heights != ib.heights);
    }

    #[test]
    fn bedrock_floor_and_contiguous_columns() {
        let s = seed(3);
        let mut out = [0u8; CHUNK_VOL];
        for &(cx, cz) in &CHUNKS {
            let info = gen(&s, cx, cz, &mut out);
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
            let info = gen(&s, cx, cz, &mut out);
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
    fn heights_cols_match_chunk() {
        let s = seed(9);
        let mut full = [0i32; 256];
        let mut out = [0i32; 64];
        for &(cx, cz) in &CHUNKS {
            heights_chunk(&s, cx, cz, &mut full);
            for (lx0, lz0, w, d) in [
                (14, 0, 2, 16),
                (0, 0, 2, 16),
                (0, 14, 16, 2),
                (0, 0, 2, 2),
                (14, 14, 2, 2),
                (3, 5, 4, 7),
            ] {
                heights_cols(&s, cx, cz, lx0, lz0, w, d, &mut out);
                for lz in lz0..lz0 + d {
                    for lx in lx0..lx0 + w {
                        assert_eq!(out[(lz - lz0) * w + lx - lx0], full[lz * 16 + lx]);
                    }
                }
            }
        }
    }

    #[test]
    fn window_heights_match_neighbor_chunks() {
        let s = seed(12);
        let mut nb = [[0i32; 256]; 9];
        let mut out = [0i32; 32];
        for &(cx, cz) in &CHUNKS {
            for (k, h) in nb.iter_mut().enumerate() {
                heights_chunk(&s, cx + k as i32 % 3 - 1, cz + k as i32 / 3 - 1, h);
            }
            let sums = WindowSums::new(&s, cx, cz);
            // The 8 neighbor parts of the populate window, plus own-chunk strips.
            let spans = [(-2, 2), (0, 16), (16, 2), (5, 3)];
            for &(x0, w) in &spans {
                for &(z0, d) in &spans {
                    if w * d > 32 {
                        continue;
                    }
                    window_heights(&s, &sums, cx, cz, (x0, w), (z0, d), &mut out);
                    for j in 0..d {
                        for i in 0..w {
                            let (lx, lz) = (x0 + i as i32, z0 + j as i32);
                            let k = (lz.div_euclid(16) + 1) * 3 + lx.div_euclid(16) + 1;
                            let c = lz.rem_euclid(16) * 16 + lx.rem_euclid(16);
                            assert_eq!(
                                out[j * w + i],
                                nb[k as usize][c as usize],
                                "chunk {cx},{cz} col {lx},{lz}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn stage1_info_roundtrip_and_wet_predicate() {
        // `stage1_info_from_blocks` reproduces generate_stage1's info, and stage-1 wetness
        // (water or ice) is exactly `h < y <= SEA_LEVEL` — the predicate populate uses for
        // out-of-chunk neighbors (no water/ice above SEA_LEVEL or at/below the surface).
        let s = seed(11);
        let mut out = [0u8; CHUNK_VOL];
        let mut wet_cols = 0;
        for cz in -12..12 {
            for cx in -12..12 {
                let info = gen(&s, cx, cz, &mut out);
                let bytes: [u8; 256] = core::array::from_fn(|i| info.biomes[i] as u8);
                let mut back = Stage1Info::EMPTY;
                stage1_info_from_blocks(&out, &bytes, &mut back);
                assert_eq!(back, info, "chunk {cx},{cz}");
                for c in 0..256 {
                    let h = info.heights[c];
                    wet_cols += (h < SEA_LEVEL) as u32;
                    for y in 0..CHUNK_H as i32 {
                        let b = out[y as usize * 256 + c];
                        let wet = is_fluid_u8(b) || b == Block::Ice as u8;
                        assert_eq!(wet, h < y && y <= SEA_LEVEL, "{cx},{cz} col {c} y {y}");
                    }
                }
            }
        }
        assert!(wet_cols > 0);
    }

    #[test]
    fn lattice_point_matches_world() {
        let s = seed(7);
        for j in -40..40 {
            for i in -40..40 {
                let (b, r) = lattice_point(&s, i, j);
                assert_eq!(b, biome_at(&s, 4 * i, 4 * j), "{i},{j}");
                assert_eq!(
                    r,
                    fbm_2d(&s, 4 * i, 4 * j, BIOME_OCT, RELIEF_CELL, SALT_RELIEF)
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
        // Max |dh| between adjacent columns over a 512x512 sweep per seed (assembled from
        // chunk fns, so chunk seams are included), split by whether either column is
        // Mountains.
        const N: usize = 32 * 16;
        let mut hs = vec![0i32; N * N];
        let mut ms = vec![false; N * N];
        let mut b = [Biome::Plains; 256];
        for s in [seed(5), seed(50), seed(150)] {
            for cz in 0..32 {
                for cx in 0..32 {
                    heights_chunk(&s, cx as i32 - 16, cz as i32 - 16, &mut h0);
                    biomes_chunk(&s, cx as i32 - 16, cz as i32 - 16, &mut b);
                    for c in 0..256 {
                        let k = (cz * 16 + c / 16) * N + cx * 16 + c % 16;
                        hs[k] = h0[c];
                        ms[k] = b[c] == Biome::Mountains;
                    }
                }
            }
            let (mut worst_flat, mut worst_mtn) = (0, 0);
            for z in 0..N {
                for x in 0..N {
                    let k = z * N + x;
                    let mut nbrs = [None, None];
                    if x + 1 < N {
                        nbrs[0] = Some(k + 1);
                    }
                    if z + 1 < N {
                        nbrs[1] = Some(k + N);
                    }
                    for n in nbrs.into_iter().flatten() {
                        let d = (hs[n] - hs[k]).abs();
                        if ms[k] || ms[n] {
                            worst_mtn = worst_mtn.max(d);
                        } else {
                            worst_flat = worst_flat.max(d);
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
        let (mut sea, mut total, mut hmax, mut hmin, mut high) = (0u32, 0u32, 0, 64, 0u32);
        for cz in -32..32 {
            for cx in -32..32 {
                let (x, z) = (cx * 16 + 7, cz * 16 + 7);
                counts[biome_at(&s, x, z) as usize] += 1;
                let h = height_at(&s, x, z);
                sea += (h < SEA_LEVEL) as u32;
                hmax = hmax.max(h);
                hmin = hmin.min(h);
                high += (h >= SNOW_LINE) as u32;
                total += 1;
            }
        }
        println!(
            "biomes {counts:?} sea {sea}/{total} max depth {} >=50 {high}/{total} max h {hmax}",
            SEA_LEVEL - hmin
        );
        for (i, &c) in counts.iter().enumerate() {
            assert!(c > total / 50, "biome {i} too rare: {counts:?}");
        }
        assert!(
            sea > total / 12 && sea < total / 4,
            "sea columns {sea}/{total}"
        );
        assert!(hmax > 52 && high > 0, "no tall mountains: {hmax}");
        assert!(SEA_LEVEL - hmin >= 5, "seas too shallow: min h {hmin}");

        // Surfaces: desert sand, snowy sea ice, sea water up to SEA_LEVEL, mountain snow.
        let mut out = [0u8; CHUNK_VOL];
        let (mut desert_sand, mut snowy_ice, mut grass, mut snow_cap) = (0, 0, 0, 0);
        for cz in -32..32 {
            for cx in -32..32 {
                let info = gen(&s, cx, cz, &mut out);
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
            let info = gen(&s, r % 64 - 32, r / 64 - 16, &mut out);
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
