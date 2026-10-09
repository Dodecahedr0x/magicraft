//! Integer 2D value noise and fractal (fbm) sums. No floats.
//!
//! Cells are powers of two (`cell = 1 << cell_log2`) rather than arbitrary `i32` sizes:
//! lattice index is `x >> cell_log2` (arithmetic shift = floor division, correct for
//! negatives) and the in-cell fraction is a mask, so there is no division per sample.
//! `cell_log2` is clamped to `<= 30`.
//!
//! Wrap seam: world coordinates are plain `i32`; noise is discontinuous where `x` or `z`
//! wraps from `i32::MAX` to `i32::MIN` (never panics; unreachable for a bounded world).
//!
//! For terrain, prefer [`fbm_chunk`]: it hashes each lattice corner once per chunk and
//! precomputes per-axis smoothstep weights, then does only three lerps per column per octave.
//!
//! Output range is `0..=NOISE_MAX` (lattice values are `0..=1023`, a subset).
//!
//! Cost per `value_noise_2d`: 4 × `Seed::h2d` (~15 ops), 2 smoothsteps (~6), 3 lerps (~4)
//! and index/fraction (~8) ≈ 90 SBF ops. `fbm_2d` with `o` octaves ≈ `o × 90 + 10` (one
//! division by the amplitude sum at the end; a single `div` is 1 CU on SBF).

use crate::hash::Seed;

/// Upper bound (inclusive) of noise outputs.
pub const NOISE_MAX: i32 = 1024;

/// Typical 1st..99th percentile of `fbm_2d` with 2 octaves (seed-stable to about ±30;
/// see `fbm_spread`). Extremes over a 1024² sweep reach roughly 10..1010.
pub const SPREAD_2OCT: (i32, i32) = (165, 860);
/// Typical 1st..99th percentile of `fbm_2d` with 3 octaves (seed-stable to about ±30;
/// see `fbm_spread`). Extremes over a 1024² sweep reach roughly 15..1000.
pub const SPREAD_3OCT: (i32, i32) = (205, 820);

/// Largest supported `cell_log2` (larger values are clamped).
pub const MAX_CELL_LOG2: u32 = 30;

/// Fixed-point bits of the in-cell fraction and smoothstep weight (1.0 = 65536).
const FRAC_BITS: u32 = 16;
const ONE: i64 = 1 << FRAC_BITS;

/// Value at lattice point `(ix, iz)`: top 10 bits of the corner hash, `0..=1023`.
#[inline(always)]
pub fn lattice(seed: &Seed, ix: i32, iz: i32, salt: u32) -> i32 {
    (seed.h2d(ix, iz, salt) >> 54) as i32
}

/// In-cell offset `f in 0..cell` scaled to `0..ONE`.
#[inline(always)]
fn frac(f: u32, k: u32) -> i64 {
    if k <= FRAC_BITS {
        (f as i64) << (FRAC_BITS - k)
    } else {
        (f >> (k - FRAC_BITS)) as i64
    }
}

/// Integer smoothstep `3t² − 2t³` for `t in 0..=ONE`, result in `0..=ONE`.
#[inline(always)]
fn smooth(t: i64) -> i64 {
    (t * t * (3 * ONE - 2 * t)) >> (2 * FRAC_BITS)
}

/// `a + (b − a)·s` with `s in 0..=ONE`, floored; result lies between `a` and `b`.
#[inline(always)]
fn lerp(a: i32, b: i32, s: i64) -> i32 {
    a + (((b - a) as i64 * s) >> FRAC_BITS) as i32
}

/// Bilinear value noise with smoothstep weights, cell size `1 << cell_log2`, `0..=NOISE_MAX`.
///
/// At lattice points (`x`, `z` multiples of the cell) it equals [`lattice`] exactly.
///
/// Continuity: smoothstep `s(t) = 3t² − 2t³` has max slope `s'(1/2) = 3/2`, so a unit step in
/// `x` moves the weight by at most `3/(2·cell)` (mean value theorem). Corner values differ by
/// at most 1023 and bilinear blending is a convex combination, so the exact noise changes by
/// at most `1023·3/(2·cell)`. Integer flooring adds ≤ 1 for the smoothstep (×1023/65536 < 1)
/// and ≤ 1 per lerp level, giving `|n(x+1,z) − n(x,z)| ≤ ceil(1023·3/(2·cell)) + 3`
/// (same for `z`). Asserted by the `continuity` test.
pub fn value_noise_2d(seed: &Seed, x: i32, z: i32, cell_log2: u32, salt: u32) -> i32 {
    let k = cell_log2.min(MAX_CELL_LOG2);
    let mask = (1u32 << k) - 1;
    let (ix, iz) = (x >> k, z >> k);
    let sx = smooth(frac(x as u32 & mask, k));
    let sz = smooth(frac(z as u32 & mask, k));
    let (ix1, iz1) = (ix.wrapping_add(1), iz.wrapping_add(1));
    let v00 = lattice(seed, ix, iz, salt);
    let v10 = lattice(seed, ix1, iz, salt);
    let v01 = lattice(seed, ix, iz1, salt);
    let v11 = lattice(seed, ix1, iz1, salt);
    lerp(lerp(v00, v10, sx), lerp(v01, v11, sx), sz)
}

/// Fractal sum of `octaves` value-noise layers, `0..=NOISE_MAX`.
///
/// Octave `i` (0-based) uses cell `1 << (base_cell_log2 − i)` (floored at 1) and weight
/// `2^(octaves−1−i)`; the weighted sum is divided by the weight total, so the result stays
/// in range. Each octave gets a distinct salt. `octaves` is clamped to `1..=16`.
///
/// Actual spread: averaging octaves pulls values toward the middle (≈512). Measured over
/// 1024×1024 sweeps across several seeds (test `fbm_spread`): 98% of 2-octave values fall in
/// [`SPREAD_2OCT`] ≈ 165..860 and of 3-octave values in [`SPREAD_3OCT`] ≈ 205..820, while the
/// extremes are seed-dependent tail events (2 oct ≈ 10..1010, 3 oct ≈ 15..1000). Single-octave
/// value noise covers nearly the full `0..=1023`. Terrain should remap from the percentile band
/// rather than assume `0..=1024`.
pub fn fbm_2d(seed: &Seed, x: i32, z: i32, octaves: u32, base_cell_log2: u32, salt: u32) -> i32 {
    let octaves = octaves.clamp(1, 16);
    let mut sum = 0i64;
    for i in 0..octaves {
        let k = base_cell_log2.saturating_sub(i);
        let s = salt.wrapping_add(i.wrapping_mul(0x9E37_79B9));
        sum += (value_noise_2d(seed, x, z, k, s) as i64) << (octaves - 1 - i);
    }
    (sum / ((1i64 << octaves) - 1)) as i32
}

/// Number of lattice corners a 16-wide axis can touch (16 cells + the `+1` corner).
const MAX_CORNERS: usize = 17;

/// Per-axis precompute for one octave: lattice-row offset of each sample and its weight.
#[inline(always)]
fn axis<const N: usize>(o: i32, k: u32) -> (i32, [u8; N], [i64; N], usize) {
    let mask = (1u32 << k) - 1;
    let i0 = o >> k;
    let mut idx = [0u8; N];
    let mut w = [0i64; N];
    for l in 0..N {
        let x = o + l as i32;
        idx[l] = ((x >> k) - i0) as u8;
        w[l] = smooth(frac(x as u32 & mask, k));
    }
    // Corners spanned: last cell offset + 1 (for the `+1` corner) + 1.
    (i0, idx, w, idx[N - 1] as usize + 2)
}

/// Shared body of [`fbm_chunk`] / [`fbm_grid9`]: `out[lz * N + lx] = fbm_2d(ox + lx, oz + lz)`.
///
/// Stack: corner table 17×17×4 = 1156 B + two axis tables 2×(N + 8N) B ≈ 1.5 KB at N = 16.
#[inline(always)]
fn fbm_grid<const N: usize>(
    seed: &Seed,
    ox: i32,
    oz: i32,
    octaves: u32,
    base_cell_log2: u32,
    salt: u32,
    out: &mut [i32],
) {
    const { assert!(N >= 1 && N < MAX_CORNERS) };
    let out = &mut out[..N * N];
    let last = N as i32 - 1;
    if ox > i32::MAX - last || oz > i32::MAX - last {
        for lz in 0..N {
            for lx in 0..N {
                out[lz * N + lx] = fbm_2d(
                    seed,
                    ox.wrapping_add(lx as i32),
                    oz.wrapping_add(lz as i32),
                    octaves,
                    base_cell_log2,
                    salt,
                );
            }
        }
        return;
    }
    let octaves = octaves.clamp(1, 16);
    out.fill(0);
    let mut corners = [[0i32; MAX_CORNERS]; MAX_CORNERS]; // [z][x]
    for i in 0..octaves {
        let k = base_cell_log2.saturating_sub(i).min(MAX_CELL_LOG2);
        let s = salt.wrapping_add(i.wrapping_mul(0x9E37_79B9));
        let (ix0, xi, xw, nx) = axis::<N>(ox, k);
        let (iz0, zi, zw, nz) = axis::<N>(oz, k);
        for (cz, row) in corners.iter_mut().enumerate().take(nz) {
            let iz = iz0.wrapping_add(cz as i32);
            for (cx, c) in row.iter_mut().enumerate().take(nx) {
                *c = lattice(seed, ix0.wrapping_add(cx as i32), iz, s);
            }
        }
        let shift = octaves - 1 - i;
        for lz in 0..N {
            let (r0, r1) = (&corners[zi[lz] as usize], &corners[zi[lz] as usize + 1]);
            let sz = zw[lz];
            for lx in 0..N {
                let (a, sx) = (xi[lx] as usize, xw[lx]);
                let v = lerp(lerp(r0[a], r0[a + 1], sx), lerp(r1[a], r1[a + 1], sx), sz);
                out[lz * N + lx] += v << shift;
            }
        }
    }
    let total = (1i32 << octaves) - 1;
    for v in out.iter_mut() {
        *v /= total;
    }
}

/// [`fbm_2d`] for a whole 16×16 chunk column grid: `out[lz * 16 + lx] =
/// fbm_2d(seed, ox + lx, oz + lz, ...)` exactly.
///
/// `(ox, oz)` is the chunk's world origin. Per octave it hashes each lattice corner touched
/// once (≤ 9 for cells ≥ 16, ≤ 289 for cell 1) and precomputes the 16 smoothstep weights
/// per axis, so each column costs only 3 lerps + accumulate (~20 ops) per octave instead of
/// ~90. No heap; SBF frame ≈ 1.5 KB (corner table 1156 B + axis tables).
///
/// If `ox` or `oz` exceeds `i32::MAX - 15` (not a chunk origin; the column range would
/// wrap) it falls back to per-column [`fbm_2d`].
#[inline(never)]
pub fn fbm_chunk(
    seed: &Seed,
    ox: i32,
    oz: i32,
    octaves: u32,
    base_cell_log2: u32,
    salt: u32,
    out: &mut [i32; 256],
) {
    fbm_grid::<16>(seed, ox, oz, octaves, base_cell_log2, salt, out);
}

/// [`fbm_chunk`] for a 9×9 grid: `out[j * 9 + i] = fbm_2d(seed, ox + i, oz + j, ...)` exactly.
/// Used for the terrain biome lattice. SBF frame ≈ 1.3 KB.
#[inline(never)]
pub fn fbm_grid9(
    seed: &Seed,
    ox: i32,
    oz: i32,
    octaves: u32,
    base_cell_log2: u32,
    salt: u32,
    out: &mut [i32; 81],
) {
    fbm_grid::<9>(seed, ox, oz, octaves, base_cell_log2, salt, out);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(tag: u8) -> Seed {
        let mut b = [0u8; 32];
        for (i, v) in b.iter_mut().enumerate() {
            *v = (i as u8).wrapping_mul(91).wrapping_add(tag);
        }
        Seed::new(&b)
    }

    #[test]
    fn deterministic_salt_and_seed_sensitive() {
        let (a, b) = (seed(1), seed(2));
        let (mut ds, mut dd, mut fs, mut fd) = (0, 0, 0, 0);
        for x in -64..64 {
            for z in -8..8 {
                let n = value_noise_2d(&a, x, z, 3, 0);
                assert_eq!(n, value_noise_2d(&a, x, z, 3, 0));
                let f = fbm_2d(&a, x, z, 3, 5, 0);
                assert_eq!(f, fbm_2d(&a, x, z, 3, 5, 0));
                ds += (n != value_noise_2d(&a, x, z, 3, 1)) as u32;
                dd += (n != value_noise_2d(&b, x, z, 3, 0)) as u32;
                fs += (f != fbm_2d(&a, x, z, 3, 5, 1)) as u32;
                fd += (f != fbm_2d(&b, x, z, 3, 5, 0)) as u32;
            }
        }
        // 2048 samples; nearly all should differ.
        for d in [ds, dd, fs, fd] {
            assert!(d > 1900, "only {d} of 2048 differ");
        }
    }

    #[test]
    fn range_sweep_with_negatives() {
        let s = seed(5);
        for k in [0u32, 2, 4, 6] {
            let (mut lo, mut hi) = (i32::MAX, i32::MIN);
            for x in -128..128 {
                for z in -128..128 {
                    let n = value_noise_2d(&s, x, z, k, 11);
                    assert!((0..=NOISE_MAX).contains(&n), "vn {n} at {x},{z} k={k}");
                    lo = lo.min(n);
                    hi = hi.max(n);
                }
            }
            // Uses most of the range (not stuck / not compressed).
            assert!(lo < 200 && hi > 824, "k={k}: {lo}..{hi}");
        }
        for (oct, k) in [(1u32, 4u32), (2, 5), (3, 6), (4, 3)] {
            for x in -128..128 {
                for z in -128..128 {
                    let n = fbm_2d(&s, x, z, oct, k, 3);
                    assert!((0..=NOISE_MAX).contains(&n), "fbm {n} at {x},{z}");
                }
            }
        }
    }

    #[test]
    fn extreme_coords_do_not_panic() {
        let s = seed(9);
        for &x in &[i32::MIN, i32::MIN + 1, -1, 0, i32::MAX - 1, i32::MAX] {
            for &z in &[i32::MIN, 0, i32::MAX] {
                let n = value_noise_2d(&s, x, z, 4, 0);
                assert!((0..=NOISE_MAX).contains(&n));
                let f = fbm_2d(&s, x, z, 3, 6, 0);
                assert!((0..=NOISE_MAX).contains(&f));
            }
        }
    }

    #[test]
    fn lattice_points_equal_corner_hash() {
        let s = seed(4);
        for k in [0u32, 1, 3, 5, 8] {
            for ix in -10..10 {
                for iz in -10..10 {
                    let v = value_noise_2d(&s, ix << k, iz << k, k, 7);
                    assert_eq!(v, lattice(&s, ix, iz, 7));
                    assert_eq!(v, (s.h2d(ix, iz, 7) >> 54) as i32);
                }
            }
        }
    }

    /// Continuity bound, see `value_noise_2d` docs:
    /// |n(x+1,z) - n(x,z)| <= ceil(1023 * 3 / (2 * cell)) + 3.
    #[test]
    fn continuity() {
        let s = seed(6);
        for k in 1u32..=7 {
            let cell = 1i32 << k;
            let bound = (1023 * 3 + 2 * cell - 1) / (2 * cell) + 3;
            let mut worst = 0;
            for x in -128..128 {
                for z in -128..128 {
                    let n = value_noise_2d(&s, x, z, k, 0);
                    let dx = (value_noise_2d(&s, x + 1, z, k, 0) - n).abs();
                    let dz = (value_noise_2d(&s, x, z + 1, k, 0) - n).abs();
                    worst = worst.max(dx).max(dz);
                    assert!(
                        dx <= bound && dz <= bound,
                        "k={k} at {x},{z}: {dx},{dz} > {bound}"
                    );
                }
            }
            assert!(worst > 0);
        }
    }

    #[test]
    fn fbm_chunk_matches_fbm_2d() {
        let s = seed(10);
        let origins = [
            (0, 0),
            (16, -16),
            (-16, 32),
            (-1024, -2048),
            (4096, 80),
            (-32, -32),
        ];
        let mut out = [0i32; 256];
        for &(cx, cz) in &origins {
            for (oct, k) in [
                (1u32, 0u32),
                (2, 2),
                (3, 3),
                (3, 4),
                (2, 5),
                (3, 6),
                (4, 7),
                (5, 2),
            ] {
                fbm_chunk(&s, cx, cz, oct, k, 21, &mut out);
                for lz in 0..16 {
                    for lx in 0..16 {
                        assert_eq!(
                            out[lz * 16 + lx],
                            fbm_2d(&s, cx + lx as i32, cz + lz as i32, oct, k, 21),
                            "origin {cx},{cz} oct {oct} k {k} col {lx},{lz}"
                        );
                    }
                }
            }
        }
        // Largest chunk origins and the fallback path.
        for &(ox, oz) in &[(i32::MAX - 15, i32::MIN), (i32::MAX - 3, 0)] {
            fbm_chunk(&s, ox, oz, 3, 5, 1, &mut out);
            for lz in 0..16 {
                for lx in 0..16 {
                    let x = ox.wrapping_add(lx as i32);
                    let z = oz.wrapping_add(lz as i32);
                    assert_eq!(out[lz * 16 + lx], fbm_2d(&s, x, z, 3, 5, 1));
                }
            }
        }
    }

    #[test]
    fn fbm_grid9_matches_fbm_2d() {
        let s = seed(14);
        let mut out = [0i32; 81];
        for &(ox, oz) in &[
            (0, 0),
            (-2, -2),
            (-402, 158),
            (i32::MAX - 8, -7),
            (i32::MAX - 3, 5),
        ] {
            for (oct, k) in [(2u32, 6u32), (2, 5), (3, 2), (1, 0)] {
                fbm_grid9(&s, ox, oz, oct, k, 9, &mut out);
                for j in 0..9 {
                    for i in 0..9 {
                        let (x, z) = (ox.wrapping_add(i), oz.wrapping_add(j));
                        assert_eq!(out[(j * 9 + i) as usize], fbm_2d(&s, x, z, oct, k, 9));
                    }
                }
            }
        }
    }

    /// Documents the real fbm output band (see `fbm_2d` docs and `SPREAD_*`).
    #[test]
    fn fbm_spread() {
        let mut out = [0i32; 256];
        for tag in [12u8, 99] {
            let s = seed(tag);
            for (oct, band, min_le, max_ge) in [
                (1u32, (0, 1023), 20, 1000),
                (2, SPREAD_2OCT, 90, 940),
                (3, SPREAD_3OCT, 130, 890),
            ] {
                let mut hist = [0u32; 1025];
                for cz in -32..32 {
                    for cx in -32..32 {
                        fbm_chunk(&s, cx * 16, cz * 16, oct, 6, 0, &mut out);
                        for &v in &out {
                            hist[v as usize] += 1;
                        }
                    }
                }
                let lo = hist.iter().position(|&c| c > 0).unwrap() as i32;
                let hi = hist.iter().rposition(|&c| c > 0).unwrap() as i32;
                let total: u32 = hist.iter().sum();
                let (mut acc, mut p1, mut p99) = (0u32, None, None);
                for (v, &c) in hist.iter().enumerate() {
                    acc += c;
                    if p1.is_none() && acc >= total / 100 {
                        p1 = Some(v as i32);
                    }
                    if p99.is_none() && acc >= total / 100 * 99 {
                        p99 = Some(v as i32);
                    }
                }
                let (p1, p99) = (p1.unwrap(), p99.unwrap());
                println!("seed {tag} octaves={oct}: min {lo} max {hi} p1 {p1} p99 {p99}");
                assert!(
                    lo <= min_le && hi >= max_ge,
                    "oct {oct}: extremes {lo}..{hi}"
                );
                if oct > 1 {
                    assert!(
                        (p1 - band.0).abs() <= 40 && (p99 - band.1).abs() <= 40,
                        "oct {oct}: p1..p99 {p1}..{p99} vs documented {band:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn huge_cell_log2_is_clamped() {
        let s = seed(13);
        for k in [31u32, 32, 63, u32::MAX] {
            assert_eq!(
                value_noise_2d(&s, 5, -7, k, 0),
                value_noise_2d(&s, 5, -7, 30, 0)
            );
            let f = fbm_2d(&s, 5, -7, 3, k, 0);
            assert!((0..=NOISE_MAX).contains(&f));
            let mut out = [0; 256];
            fbm_chunk(&s, 0, 0, 3, k, 0, &mut out);
            assert_eq!(out[0], fbm_2d(&s, 0, 0, 3, k, 0));
        }
    }

    #[test]
    #[ignore]
    fn bench_fbm_chunk() {
        let s = seed(8);
        const REPS: i32 = 1000;
        let mut out = [0i32; 256];
        let mut acc = 0i64;
        let t = std::time::Instant::now();
        for r in 0..REPS {
            for lz in 0..16 {
                for lx in 0..16 {
                    acc += fbm_2d(&s, lx + r * 16, lz, 3, 6, 0) as i64;
                }
            }
        }
        let per_col = t.elapsed() / REPS as u32;
        let t = std::time::Instant::now();
        for r in 0..REPS {
            fbm_chunk(&s, r * 16, 0, 3, 6, 0, &mut out);
            acc += out[255] as i64;
        }
        let per_chunk = t.elapsed() / REPS as u32;
        println!("256x fbm_2d: {per_col:?}  fbm_chunk: {per_chunk:?}  (acc {acc})");
    }

    #[test]
    #[ignore]
    fn bench_noise() {
        let s = seed(8);
        let t = std::time::Instant::now();
        let mut acc = 0i64;
        const REPS: i32 = 1000;
        for r in 0..REPS {
            for lz in 0..16 {
                for lx in 0..16 {
                    acc += fbm_2d(&s, lx + r * 16, lz, 3, 6, 0) as i64;
                }
            }
        }
        let per = t.elapsed() / REPS as u32;
        println!("256 fbm_2d(3 octaves) calls: {per:?} (acc {acc})");
    }
}
