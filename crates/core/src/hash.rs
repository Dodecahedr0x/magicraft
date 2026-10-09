//! Integer hashing and a splitmix64 PRNG.
//!
//! Everything is integer-only and wrapping, so native and SBF builds agree bit for bit
//! (overflow checks stay on in release; all arithmetic here uses explicit `wrapping_*`).
//!
//! Design: the 32-byte VRF world seed is folded once into a [`Seed`] (two `u64` keys) so
//! hot paths never re-read 32 bytes. The fold chains a bijective mixer over the four
//! little-endian seed words, so every seed bit affects both keys; effective world entropy
//! is 64 bits, which is plenty for terrain. [`h64`] is a thin convenience wrapper for
//! one-off calls; hot loops should build a `Seed` once and call [`Seed::h64`] / [`Seed::h2d`].
//!
//! Cost (each op ≈ 1 SBF instruction): `mix` = 2 mul + 3 shift + 3 xor ≈ 8 ops;
//! `Seed::h2d` ≈ 3 mul + 3 add + mix ≈ 15 ops; `Seed::h64` ≈ 2 mixes + 4 mul + 5 add/xor ≈ 26 ops;
//! `next` ≈ 9 ops; `rand_range` ≈ 6 ops.

const P1: u64 = 0x9E37_79B9_7F4A_7C15;
const P2: u64 = 0xC2B2_AE3D_27D4_EB4F;
const P3: u64 = 0x1656_67B1_9E37_79F9;
const P4: u64 = 0xD6E8_FEB8_6659_FD93;
const K1_TWEAK: u64 = 0xD1B5_4A32_D192_ED03;

/// splitmix64 finalizer (Stafford "mix13"): a bijection on `u64` with strong avalanche.
#[inline(always)]
pub fn mix(mut x: u64) -> u64 {
    x ^= x >> 30;
    x = x.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x ^= x >> 27;
    x = x.wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

/// World seed folded into two 64-bit keys. Build once per instruction, then hash cheaply.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Seed {
    k0: u64,
    k1: u64,
}

impl Seed {
    /// Folds the 32-byte seed (read as 4 little-endian `u64`s) into two keys.
    pub fn new(bytes: &[u8; 32]) -> Self {
        let mut s = 0u64;
        for w in bytes.chunks_exact(8) {
            let mut le = [0u8; 8];
            le.copy_from_slice(w);
            s = mix(s ^ u64::from_le_bytes(le)).wrapping_add(P1);
        }
        Seed {
            k0: s,
            k1: mix(s ^ K1_TWEAK),
        }
    }

    /// General hash of three signed coordinates and a salt (trees, ores, mobs, ...).
    #[inline]
    pub fn h64(&self, a: i64, b: i64, c: i64, salt: u32) -> u64 {
        let x = mix(self
            .k0
            .wrapping_add((a as u64).wrapping_mul(P1))
            .wrapping_add((b as u64).wrapping_mul(P2)));
        mix(x ^ self
            .k1
            .wrapping_add((c as u64).wrapping_mul(P3))
            .wrapping_add((salt as u64).wrapping_mul(P4)))
    }

    /// Cheap single-mix 2D lattice hash used by noise (one `mix`, three multiplies).
    /// Keyed by `k1` (while `h64` enters with `k0`), so noise lattices and `h64` draws with
    /// equal inputs are independent.
    ///
    /// Wrap seam: coordinates are hashed as `u32` bit patterns, so `i32::MAX` and `i32::MIN`
    /// are adjacent and nothing panics, but noise built on this has a discontinuity where
    /// `x`/`z` wraps. Unreachable for any bounded world.
    #[inline(always)]
    pub fn h2d(&self, x: i32, z: i32, salt: u32) -> u64 {
        mix(self
            .k1
            .wrapping_add((x as u32 as u64).wrapping_mul(P1))
            .wrapping_add((z as u32 as u64).wrapping_mul(P2))
            .wrapping_add((salt as u64).wrapping_mul(P3)))
    }
}

/// Convenience wrapper: `Seed::new(seed).h64(a, b, c, salt)`. Re-folds the seed every call
/// (~4 extra mixes); prefer a cached [`Seed`] in loops.
pub fn h64(seed: &[u8; 32], a: i64, b: i64, c: i64, salt: u32) -> u64 {
    Seed::new(seed).h64(a, b, c, salt)
}

/// Maps a hash to `lo..=hi` by multiply-shift on its top 32 bits (no modulo, no division).
/// Bias is at most `span / 2^32`, negligible for game ranges. If `lo > hi` the bounds are
/// swapped (never panics).
#[inline]
pub fn rand_range(h: u64, lo: i32, hi: i32) -> i32 {
    let (lo, hi) = if lo <= hi { (lo, hi) } else { (hi, lo) };
    let span = (hi as i64 - lo as i64 + 1) as u64; // 1..=2^32
    (lo as i64 + (((h >> 32) * span) >> 32) as i64) as i32
}

/// splitmix64 step: advances `state` and returns the next pseudo-random `u64`.
/// Seed a stream with e.g. `let mut st = seed.h64(cx, cz, 0, SALT);`.
#[inline]
pub fn splitmix_next(state: &mut u64) -> u64 {
    *state = state.wrapping_add(P1);
    mix(*state)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_bytes(tag: u8) -> [u8; 32] {
        let mut b = [0u8; 32];
        for (i, v) in b.iter_mut().enumerate() {
            *v = (i as u8).wrapping_mul(37).wrapping_add(tag);
        }
        b
    }

    #[test]
    fn h64_deterministic_and_wrapper_matches_seed() {
        let b = seed_bytes(1);
        let s = Seed::new(&b);
        for i in -50i64..50 {
            let h = h64(&b, i, -i * 3, i * 7, 9);
            assert_eq!(h, h64(&b, i, -i * 3, i * 7, 9));
            assert_eq!(h, s.h64(i, -i * 3, i * 7, 9));
        }
        assert_eq!(Seed::new(&b), Seed::new(&b));
    }

    #[test]
    fn salts_and_seeds_differ() {
        let a = Seed::new(&seed_bytes(1));
        let b = Seed::new(&seed_bytes(2));
        // Every seed byte matters.
        for i in 0..32 {
            let mut bb = seed_bytes(1);
            bb[i] ^= 1;
            assert_ne!(Seed::new(&bb), a, "seed byte {i} ignored");
        }
        let mut same_salt = 0;
        let mut same_seed = 0;
        let mut same_h2d = 0;
        for i in 0..1000i64 {
            if a.h64(i, 2, 3, 0) == a.h64(i, 2, 3, 1) {
                same_salt += 1;
            }
            if a.h64(i, 2, 3, 0) == b.h64(i, 2, 3, 0) {
                same_seed += 1;
            }
            if a.h2d(i as i32, 5, 0) == a.h2d(i as i32, 5, 1) {
                same_h2d += 1;
            }
        }
        assert_eq!((same_salt, same_seed, same_h2d), (0, 0, 0));
        // h2d is keyed separately from h64.
        let cross = (0..1000)
            .filter(|&i| a.h2d(i, 0, 0) == a.h64(i as i64, 0, 0, 0))
            .count();
        assert_eq!(cross, 0);
    }

    /// Flip one input bit -> on average about half (32) of the output bits flip.
    #[test]
    fn h64_avalanche() {
        let s = Seed::new(&seed_bytes(7));
        let mut st = 0x1234_5678u64;
        const N: u32 = 400;
        // inputs: 0=a, 1=b, 2=c (64 bits each), 3=salt (32 bits)
        for input in 0..4 {
            let bits = if input == 3 { 32 } else { 64 };
            for bit in 0..bits {
                let mut total = 0u32;
                for _ in 0..N {
                    let mut v = [
                        splitmix_next(&mut st) as i64,
                        splitmix_next(&mut st) as i64,
                        splitmix_next(&mut st) as i64,
                    ];
                    let salt = splitmix_next(&mut st) as u32;
                    let h0 = s.h64(v[0], v[1], v[2], salt);
                    let h1 = if input == 3 {
                        s.h64(v[0], v[1], v[2], salt ^ (1 << bit))
                    } else {
                        v[input] ^= 1i64 << bit;
                        s.h64(v[0], v[1], v[2], salt)
                    };
                    total += (h0 ^ h1).count_ones();
                }
                let avg = total as f64 / N as f64;
                assert!(
                    (24.0..=40.0).contains(&avg),
                    "input {input} bit {bit}: avg {avg}"
                );
            }
        }
        // Lattice hash: flipping any coordinate/salt bit.
        for bit in 0..32 {
            let mut total = 0u32;
            for _ in 0..N {
                let x = splitmix_next(&mut st) as i32;
                let z = splitmix_next(&mut st) as i32;
                let salt = splitmix_next(&mut st) as u32;
                let h0 = s.h2d(x, z, salt);
                total += (h0 ^ s.h2d(x ^ (1 << bit), z, salt)).count_ones();
                total += (h0 ^ s.h2d(x, z ^ (1 << bit), salt)).count_ones();
                total += (h0 ^ s.h2d(x, z, salt ^ (1 << bit))).count_ones();
            }
            let avg = total as f64 / (3 * N) as f64;
            assert!((24.0..=40.0).contains(&avg), "h2d bit {bit}: avg {avg}");
        }
    }

    #[test]
    fn rand_range_bounds() {
        let mut st = 1u64;
        for _ in 0..10_000 {
            let h = splitmix_next(&mut st);
            let r = rand_range(h, -5, 5);
            assert!((-5..=5).contains(&r));
        }
        assert_eq!(rand_range(0, 3, 9), 3);
        assert_eq!(rand_range(u64::MAX, 3, 9), 9);
        assert_eq!(rand_range(12345, 4, 4), 4);
        // Swapped bounds are tolerated.
        assert_eq!(rand_range(0, 9, 3), 3);
        assert_eq!(rand_range(u64::MAX, 9, 3), 9);
        assert_eq!(rand_range(0, i32::MIN, i32::MAX), i32::MIN);
        assert_eq!(rand_range(u64::MAX, i32::MIN, i32::MAX), i32::MAX);
    }

    /// Chi-square over 16 buckets, 100k draws. df=15; p=0.999 critical value ≈ 37.7.
    #[test]
    fn rand_range_uniform() {
        let s = Seed::new(&seed_bytes(3));
        let mut st = 42u64;
        const N: usize = 100_000;
        let mut seq = [0u32; 16];
        let mut hashed = [0u32; 16];
        for i in 0..N {
            seq[rand_range(splitmix_next(&mut st), 0, 15) as usize] += 1;
            hashed[rand_range(s.h64(i as i64, 0, 0, 0), 0, 15) as usize] += 1;
        }
        for counts in [seq, hashed] {
            let e = N as f64 / 16.0;
            let chi: f64 = counts.iter().map(|&c| (c as f64 - e).powi(2) / e).sum();
            assert!(chi < 37.7, "chi-square {chi}, counts {counts:?}");
        }
    }

    #[test]
    fn splitmix_next_reference() {
        // Reference splitmix64 outputs for state 0.
        let mut st = 0u64;
        assert_eq!(splitmix_next(&mut st), 0xe220_a839_7b1d_cdaf);
        assert_eq!(splitmix_next(&mut st), 0x6e78_9e6a_a1b9_65f4);
        assert_eq!(splitmix_next(&mut st), 0x06c4_5d18_8009_454f);
    }
}
