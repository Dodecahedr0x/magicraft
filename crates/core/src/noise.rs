//! Integer 2D value noise and fractal (fbm) sums. No floats.
//!
//! Cells are powers of two (`cell = 1 << cell_log2`) rather than arbitrary `i32` sizes:
//! lattice index is `x >> cell_log2` (arithmetic shift = floor division, correct for
//! negatives) and the in-cell fraction is a mask, so there is no division per sample.
//! `cell_log2` must be `<= 30`.
//!
//! Output range is `0..=NOISE_MAX` (lattice values are `0..=1023`, a subset).
//!
//! Cost per `value_noise_2d`: 4 × `Seed::h2` (~15 ops), 2 smoothsteps (~6), 3 lerps (~4)
//! and index/fraction (~8) ≈ 90 SBF ops. `fbm_2d` with `o` octaves ≈ `o × 90 + 10` (one
//! division by the amplitude sum at the end; a single `div` is 1 CU on SBF).

use crate::hash::Seed;

/// Upper bound (inclusive) of noise outputs.
pub const NOISE_MAX: i32 = 1024;

/// Fixed-point bits of the in-cell fraction and smoothstep weight (1.0 = 65536).
const FRAC_BITS: u32 = 16;
const ONE: i64 = 1 << FRAC_BITS;

/// Value at lattice point `(ix, iz)`: top 10 bits of the corner hash, `0..=1023`.
#[inline(always)]
pub fn lattice(seed: &Seed, ix: i32, iz: i32, salt: u32) -> i32 {
    (seed.h2(ix, iz, salt) >> 54) as i32
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
    debug_assert!(cell_log2 <= 30);
    let k = cell_log2;
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
                    assert_eq!(v, (s.h2(ix, iz, 7) >> 54) as i32);
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
