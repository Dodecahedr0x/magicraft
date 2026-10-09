//! Cave worms: per-chunk hash-seeded tunnels, replayed from the 3×3 chunk neighborhood.
//! Integer-only, no heap.
//!
//! # Worms
//! Chunk `(cx, cz)` owns 0–2 worms ([`MAX_WORMS`]), drawn from one splitmix stream seeded by
//! `seed.h64(cx, cz, 0, SALT_WORM)`. A worm starts at a random block inside its chunk at
//! `y ∈ WORM_Y` and runs [`SEGS`] = 12–24 segments (fewer than the design's 20–40 but with
//! longer steps, so tunnels stay ≈ as long while the per-chunk work tail halves). Positions
//! are world fixed point (1/[`FP`] block, `i64`, so any `i32` chunk coordinate is safe).
//! Direction is a yaw on a 256-step circle (quarter sine table, ×256) plus a vertical step
//! `dy`; each segment the yaw drifts by ±12 steps and `dy` by ±24 (clamped to ±80, ≤ 0.31
//! block/segment). The step is `r` blocks, so consecutive spheres always overlap. Radius
//! is the worm's base radius (1–3) ±1, clamped to 1..=3. One worm in [`ENTRANCE_ONE_IN`] is
//! an *entrance* worm (a draw from the worm's own stream).
//!
//! Containment: sphere centres stay within `[origin − 13, origin + 29]` blocks (x and z,
//! `origin` = the worm's chunk origin; the yaw mirrors off a wall) and `y ∈ 4..=52`. With
//! `r ≤ 3` no carved voxel lies outside the worm's own 3×3 chunk neighborhood
//! (const-asserted), so replaying a chunk's 3×3 neighborhood finds **every** sphere that can
//! touch it and per-chunk carving equals a single-buffer carve of the world (tested).
//! (Narrower bounds would concentrate worms in fewer chunks and raise the per-chunk tail.)
//!
//! # Carving rule ([`carve_caves`])
//! A voxel is inside a sphere when its centre is within `r` blocks of the sphere centre
//! (`dx² + dy² + dz² ≤ (r·FP)²`). It becomes air iff `1 ≤ y ≤ top(column)` and no 6-neighbor
//! is *wet* in stage 1 (water of any level, **or ice** — ice only caps sea water, so it is
//! treated as water). `top = h − 1` (the surface and everything above stay), except for an
//! entrance worm's spheres in **its own chunk's** columns that are not Plains/Forest and
//! have `h ≥ SEA_LEVEL`, where `top = h` (the surface may open; nothing wet is above it).
//! Trees and animals need Plains/Forest grass and cacti check the live Sand block, so
//! nothing ever stands on an opened surface, and tree placement stays a pure function of
//! stage-1 data.
//!
//! Stage-1 wetness is columnar: column `n` is wet at `y` iff `h(n) < y ≤ SEA_LEVEL`
//! (tested in `terrain`). For `y ≤ top ≤ h` the voxel itself and the ones above/below are
//! never wet, so the rule reduces to per-column ceilings: carvable iff
//! `y ≤ min(top, h of the 4 lateral neighbors)` or `SEA_LEVEL < y ≤ top`. Out-of-chunk
//! neighbor heights come from [`HeightWindow`] (2-column side strips, exact stage-1
//! heights), loaded once the first sphere touches the chunk. So the rule is exact on both
//! sides of every border.
//!
//! # Cost (modeled ops) and the hard cap
//! Each sphere's work is bounded before carving by [`BBox::ops_bound`]: bbox rows ×
//! [`OPS_ROW`] + bbox voxels × [`OPS_TEST`] + min(voxels, [`MAX_HITS`]`[r]`) × [`OPS_HIT`]
//! (`MAX_HITS` = 8/40/136 is exact, asserted exhaustively). Spheres are replayed in a fixed
//! order and one whose bound would push the chunk's total past [`CAVE_OPS_CAP`] (380k) is
//! skipped, so carving work is ≤ 380k modeled ops **by construction**; skipping is
//! deterministic and order-independent (a skipped sphere would only leave a seam).
//! Unconstrained, the worst case would be 9 chunks × 2 worms × 24 spheres of r=3 all inside
//! one chunk ≈ 3M ops. Measured over 10^6 chunks (4 seeds × 500², `scan_cave_tail`):
//! demand mean 55k, p99 163k, p99.999 288k, max 340k — the cap never triggered.
//!
//! The modeled weights define the cap (and so the output) and stay fixed; real SBF CU are
//! calibrated against them (`bench/cu`, Task 17b): carving a sphere costs ≤ 290 CU + 0.9 CU
//! per modeled op over 26 712 measured geometries (≈ 0.75 CU/op on real chunks), replaying
//! one sphere ≤ 290 CU. See [`crate::populate::STAGE2_CU_BOUND`].
//!
//! # SBF stack
//! [`carve_caves`] frame ≈ 1.2 KB (the two 512 B ceiling tables in an `Option`, a [`Worms`]
//! iterator ≈ 100 B); `col_limits` and [`HeightWindow`]'s loader have their own
//! `#[inline(never)]` frames.

use crate::blocks::{is_fluid_u8, Block};
use crate::consts::{CHUNK_H, CHUNK_VOL, FP, SEA_LEVEL};
use crate::hash::{rand_range, splitmix_next, Seed};
use crate::populate::HeightWindow;
use crate::terrain::Biome;

pub const SALT_WORM: u32 = 0xCA7E_0010;
/// Worms per chunk: `0..=MAX_WORMS`.
pub const MAX_WORMS: i32 = 2;
/// Segments per worm (inclusive).
pub const SEGS: (i32, i32) = (12, 24);
/// Sphere radius in blocks (inclusive).
pub const RADIUS: (i32, i32) = (1, 3);
/// One in this many worms is an entrance worm.
pub const ENTRANCE_ONE_IN: i32 = 4;
/// Hard cap on modeled carve ops per chunk (see module docs, "Cost").
pub const CAVE_OPS_CAP: u32 = 380_000;
/// Modeled SBF ops per bbox row, per bbox voxel test, and extra per in-sphere voxel.
pub const OPS_ROW: u32 = 12;
pub const OPS_TEST: u32 = 8;
pub const OPS_HIT: u32 = 16;
/// Exact maximum number of voxel centres inside a radius-`r` sphere over all fixed-point
/// centre offsets (asserted exhaustively by `max_hits_exact`); index = radius.
pub const MAX_HITS: [u32; 4] = [0, 8, 40, 136];
/// Worm start height (inclusive).
pub const WORM_Y: (i32, i32) = (8, 48);
/// Sphere centre height bounds (inclusive, blocks).
const Y_BOUNDS: (i64, i64) = (4, 52);
/// Horizontal centre bounds relative to the worm's chunk origin (blocks, inclusive).
const XZ_BOUNDS: (i64, i64) = (-13, 29);

const FPL: i64 = FP as i64;

// Containment proof (see module docs): voxel `v` has its centre at `v + 0.5`; a centre in
// XZ_BOUNDS reaches voxel centres in `[lo − R, hi + R]`, i.e. voxels `lo − R ..= hi + R − 1`,
// which must stay inside the 3×3 neighborhood `-16..=31` relative to the origin chunk.
const _: () = assert!(XZ_BOUNDS.0 - RADIUS.1 as i64 >= -16 && XZ_BOUNDS.1 + RADIUS.1 as i64 <= 32);
const _: () = assert!(Y_BOUNDS.0 - RADIUS.1 as i64 >= 1 && Y_BOUNDS.1 + (RADIUS.1 as i64) < 64);

/// sin(k·2π/256)·256 for k in 0..=64.
const SIN_Q: [i16; 65] = [
    0, 6, 13, 19, 25, 31, 38, 44, 50, 56, 62, 68, 74, 80, 86, 92, 98, 104, 109, 115, 121, 126, 132,
    137, 142, 147, 152, 157, 162, 167, 172, 177, 181, 185, 190, 194, 198, 202, 206, 209, 213, 216,
    220, 223, 226, 229, 231, 234, 237, 239, 241, 243, 245, 247, 248, 250, 251, 252, 253, 254, 255,
    255, 256, 256, 256,
];

/// sin(k·2π/256)·256 for k in 0..256, unfolded from [`SIN_Q`] at compile time.
const SIN_FULL: [i16; 256] = {
    let mut t = [0i16; 256];
    let mut a = 0;
    while a < 256 {
        t[a] = match a {
            0..=64 => SIN_Q[a],
            65..=128 => SIN_Q[128 - a],
            129..=192 => -SIN_Q[a - 128],
            _ => -SIN_Q[256 - a],
        };
        a += 1;
    }
    t
};

/// sin of a 256-step angle, ×256.
#[inline(always)]
fn sin256(a: i32) -> i64 {
    SIN_FULL[(a & 255) as usize] as i64
}

#[inline(always)]
fn cos256(a: i32) -> i64 {
    sin256(a + 64)
}

/// One worm segment: a sphere with world fixed-point centre (1/[`FP`] block) and radius in
/// blocks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sphere {
    pub x: i64,
    pub y: i64,
    pub z: i64,
    pub r: i32,
    /// The worm is an entrance worm (may carve surface blocks of its own chunk).
    pub entrance: bool,
}

/// Heap-free iterator over all spheres of all worms of one chunk (see module docs).
#[derive(Clone, Debug)]
pub struct Worms {
    rng: u64,
    worms_left: i32,
    segs_left: i32,
    lo: (i64, i64),
    hi: (i64, i64),
    x: i64,
    y: i64,
    z: i64,
    yaw: i32,
    dy: i32,
    base_r: i32,
    entrance: bool,
}

#[inline(always)]
fn draw(rng: &mut u64, lo: i32, hi: i32) -> i32 {
    rand_range(splitmix_next(rng), lo, hi)
}

/// Worms owned by chunk `(cx, cz)`, as a sphere iterator.
pub fn worms_for_chunk(seed: &Seed, cx: i32, cz: i32) -> Worms {
    let mut rng = seed.h64(cx as i64, cz as i64, 0, SALT_WORM);
    let worms_left = draw(&mut rng, 0, MAX_WORMS);
    let (ox, oz) = (cx as i64 * 16, cz as i64 * 16);
    Worms {
        rng,
        worms_left,
        segs_left: 0,
        lo: ((ox + XZ_BOUNDS.0) * FPL, (oz + XZ_BOUNDS.0) * FPL),
        hi: ((ox + XZ_BOUNDS.1) * FPL, (oz + XZ_BOUNDS.1) * FPL),
        x: ox * FPL,
        y: 0,
        z: oz * FPL,
        yaw: 0,
        dy: 0,
        base_r: 1,
        entrance: false,
    }
}

impl Iterator for Worms {
    type Item = Sphere;

    fn next(&mut self) -> Option<Sphere> {
        let rng = &mut self.rng;
        if self.segs_left == 0 {
            if self.worms_left == 0 {
                return None;
            }
            self.worms_left -= 1;
            // Start anywhere in the chunk (lo + 13 blocks = chunk origin).
            self.x = self.lo.0 - XZ_BOUNDS.0 * FPL + draw(rng, 0, 16 * FP - 1) as i64;
            self.z = self.lo.1 - XZ_BOUNDS.0 * FPL + draw(rng, 0, 16 * FP - 1) as i64;
            self.y = draw(rng, WORM_Y.0 * FP, WORM_Y.1 * FP) as i64;
            self.yaw = draw(rng, 0, 255);
            self.dy = draw(rng, -48, 48);
            self.base_r = draw(rng, RADIUS.0, RADIUS.1);
            self.segs_left = draw(rng, SEGS.0, SEGS.1);
            self.entrance = draw(rng, 0, ENTRANCE_ONE_IN - 1) == 0;
        }
        self.segs_left -= 1;
        let r = (self.base_r + draw(rng, -1, 1)).clamp(RADIUS.0, RADIUS.1);
        let s = Sphere {
            x: self.x,
            y: self.y,
            z: self.z,
            r,
            entrance: self.entrance,
        };
        // Advance: step r blocks along the yaw, plus dy.
        let step = r as i64 * FPL;
        self.x += cos256(self.yaw) * step / 256;
        self.z += sin256(self.yaw) * step / 256;
        self.y += self.dy as i64;
        self.yaw = (self.yaw + draw(rng, -12, 12)) & 255;
        self.dy = (self.dy + draw(rng, -24, 24)).clamp(-80, 80);
        // Walls: clamp and mirror the direction component.
        if self.x < self.lo.0 || self.x > self.hi.0 {
            self.x = self.x.clamp(self.lo.0, self.hi.0);
            self.yaw = (128 - self.yaw) & 255;
        }
        if self.z < self.lo.1 || self.z > self.hi.1 {
            self.z = self.z.clamp(self.lo.1, self.hi.1);
            self.yaw = (256 - self.yaw) & 255;
        }
        let (ylo, yhi) = (Y_BOUNDS.0 * FPL, Y_BOUNDS.1 * FPL);
        if self.y < ylo || self.y > yhi {
            self.y = self.y.clamp(ylo, yhi);
            self.dy = -self.dy;
        }
        Some(s)
    }
}

/// Wet in stage 1: water (any level) or ice.
#[inline(always)]
pub fn is_wet_u8(b: u8) -> bool {
    is_fluid_u8(b) || b == Block::Ice as u8
}

/// Work counters of one [`carve_caves`] call, in modeled SBF ops (see module docs).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CaveStats {
    /// Modeled ops of the spheres carved (≤ [`CAVE_OPS_CAP`]).
    pub ops: u32,
    /// Modeled ops demanded by all spheres touching the chunk, including skipped ones.
    pub demand: u32,
    /// Spheres skipped because they would exceed [`CAVE_OPS_CAP`].
    pub skipped: u32,
}

/// Per-column carve ceilings: `y` is carvable iff `y ≤ lo[c] || (SEA_LEVEL < y ≤ top[c])`
/// (`1 ≤ y` is guaranteed by the bbox clip).
#[doc(hidden)]
pub struct Lim {
    pub lo: [u8; 256],
    pub top: [u8; 256],
}

/// Ceilings for normal and entrance spheres (see module docs). Loads the 4 side strips,
/// then reads the window rows directly (≈ 9.7k CU, data-independent).
#[inline(never)]
fn col_limits(win: &mut HeightWindow, biomes: &[Biome; 256], out: &mut [Lim; 2]) {
    win.load_sides();
    for z in 0..16i32 {
        // Window rows z-1, z, z+1 (columns -2..18; own column x is at index x + 2).
        let (up, mid, down) = (win.row(z - 1), win.row(z), win.row(z + 1));
        for x in 0..16usize {
            let c = z as usize * 16 + x;
            let h = mid[x + 2];
            let nmin = h
                .min(mid[x + 1])
                .min(mid[x + 3])
                .min(up[x + 2])
                .min(down[x + 2]) as i32;
            let h = h as i32;
            let grassy = matches!(biomes[c], Biome::Plains | Biome::Forest);
            let top_e = if !grassy && h >= SEA_LEVEL { h } else { h - 1 };
            for (l, top) in out.iter_mut().zip([h - 1, top_e]) {
                l.top[c] = top as u8;
                l.lo[c] = top.min(nmin) as u8;
            }
        }
    }
}

/// Carves caves into chunk `(cx, cz)` (stage-1 blocks in `blocks`, stage-1 biomes in
/// `biomes`) from the worms of its 3×3 neighborhood, following the rule in the module
/// docs. `win` supplies neighbor column heights (the 4 side strips are loaded once the
/// first sphere touches the chunk).
#[inline(never)]
pub fn carve_caves(
    seed: &Seed,
    cx: i32,
    cz: i32,
    blocks: &mut [u8; CHUNK_VOL],
    biomes: &[Biome; 256],
    win: &mut HeightWindow,
) -> CaveStats {
    carve_caves_capped(seed, cx, cz, blocks, biomes, win, CAVE_OPS_CAP)
}

/// [`carve_caves`] with an explicit ops cap (tests).
#[allow(clippy::too_many_arguments)]
#[inline(always)]
pub fn carve_caves_capped(
    seed: &Seed,
    cx: i32,
    cz: i32,
    blocks: &mut [u8; CHUNK_VOL],
    biomes: &[Biome; 256],
    win: &mut HeightWindow,
    cap: u32,
) -> CaveStats {
    let mut lim: Option<[Lim; 2]> = None;
    let mut st = CaveStats::default();
    let (ox, oz) = (cx as i64 * 16 * FPL, cz as i64 * 16 * FPL);
    for dz in -1..=1 {
        for dx in -1..=1 {
            let own = dx == 0 && dz == 0;
            let worms = worms_for_chunk(seed, cx.wrapping_add(dx), cz.wrapping_add(dz));
            for s in worms {
                let Some(bb) = clip_bbox(s.x - ox, s.y, s.z - oz, s.r) else {
                    continue;
                };
                let w = bb.ops_bound(s.r);
                st.demand += w;
                if st.ops + w > cap {
                    st.skipped += 1;
                    continue;
                }
                st.ops += w;
                let lim = lim.get_or_insert_with(|| {
                    let mut l = [EMPTY_LIM, EMPTY_LIM];
                    col_limits(win, biomes, &mut l);
                    l
                });
                let ctx = Carve {
                    lx: s.x - ox,
                    ly: s.y,
                    lz: s.z - oz,
                    r2: (s.r as i64 * FPL).pow(2),
                };
                carve_sphere(blocks, &lim[(own && s.entrance) as usize], &ctx, &bb);
            }
        }
    }
    st
}

/// SBF CU calibration hook (`bench/cu`; not part of the API): the per-sphere work of
/// [`carve_caves`] for one radius-`r` sphere with chunk-local fixed-point centre — clip,
/// [`BBox::ops_bound`] and the carve under ceilings `lim` — returning the modeled ops (0 if
/// the sphere misses the chunk).
#[doc(hidden)]
#[inline(never)]
pub fn bench_carve_one(blocks: &mut [u8; CHUNK_VOL], lim: &Lim, c: (i64, i64, i64), r: i32) -> u32 {
    let Some(bb) = clip_bbox(c.0, c.1, c.2, r) else {
        return 0;
    };
    let ctx = Carve {
        lx: c.0,
        ly: c.1,
        lz: c.2,
        r2: (r as i64 * FPL).pow(2),
    };
    carve_sphere(blocks, lim, &ctx, &bb);
    bb.ops_bound(r)
}

const EMPTY_LIM: Lim = Lim {
    lo: [0; 256],
    top: [0; 256],
};

/// Sphere bbox clipped to the chunk and `y ∈ 1..=62` (voxel indices, inclusive).
#[derive(Clone, Copy, Debug)]
pub struct BBox {
    x0: i64,
    x1: i64,
    y0: i64,
    y1: i64,
    z0: i64,
    z1: i64,
}

impl BBox {
    #[inline(always)]
    pub fn volume(&self) -> u32 {
        self.rows() * (self.x1 - self.x0 + 1) as u32
    }

    /// `(y, z)` rows of the bbox.
    #[inline(always)]
    pub fn rows(&self) -> u32 {
        ((self.y1 - self.y0 + 1) * (self.z1 - self.z0 + 1)) as u32
    }

    /// Upper bound on the modeled ops of carving a radius-`r` sphere in this bbox:
    /// rows · [`OPS_ROW`] + voxels · [`OPS_TEST`] + min(voxels, [`MAX_HITS`]`[r]`) ·
    /// [`OPS_HIT`]. (Every row runs once, every bbox voxel is tested once, and only voxels
    /// whose centre is inside the sphere run the carve path.)
    #[inline(always)]
    pub fn ops_bound(&self, r: i32) -> u32 {
        let v = self.volume();
        self.rows() * OPS_ROW + v * OPS_TEST + v.min(MAX_HITS[r as usize]) * OPS_HIT
    }
}

/// Clipped bbox of a sphere with chunk-local fixed-point centre: `floor((c ± r) / FP)`
/// covers every voxel whose centre (`v·FP + FP/2`) can be within `r`. At most `(2r+1)³`.
#[inline(always)]
pub fn clip_bbox(lx: i64, ly: i64, lz: i64, r: i32) -> Option<BBox> {
    let rf = r as i64 * FPL;
    let b = BBox {
        x0: ((lx - rf) >> 8).max(0),
        x1: ((lx + rf) >> 8).min(15),
        y0: ((ly - rf) >> 8).max(1),
        y1: ((ly + rf) >> 8).min(CHUNK_H as i64 - 2),
        z0: ((lz - rf) >> 8).max(0),
        z1: ((lz + rf) >> 8).min(15),
    };
    (b.x0 <= b.x1 && b.z0 <= b.z1 && b.y0 <= b.y1).then_some(b)
}

struct Carve {
    lx: i64,
    ly: i64,
    lz: i64,
    r2: i64,
}

#[inline(always)]
fn carve_sphere(blocks: &mut [u8; CHUNK_VOL], lim: &Lim, k: &Carve, bb: &BBox) {
    // Exclusive bounds; the clip guarantees `0 ≤ x, z ≤ 15` and `1 ≤ y ≤ 62`.
    let (x0, x1) = (bb.x0, bb.x1 + 1);
    let ddx0 = x0 * FPL + FPL / 2 - k.lx;
    for y in bb.y0..bb.y1 + 1 {
        let ddy = y * FPL + FPL / 2 - k.ly;
        let ry = k.r2 - ddy * ddy;
        if ry < 0 {
            continue;
        }
        let (yy, above_sea) = (y as u8, y > SEA_LEVEL as i64);
        let layer = &mut blocks[(y as usize & 63) * 256..][..256];
        for z in bb.z0..bb.z1 + 1 {
            let ddz = z * FPL + FPL / 2 - k.lz;
            let rz = ry - ddz * ddz;
            if rz < 0 {
                continue;
            }
            let r0 = (z as usize & 15) * 16;
            let (lo, top) = (&lim.lo[r0..r0 + 16], &lim.top[r0..r0 + 16]);
            let cells = &mut layer[r0..r0 + 16];
            let mut ddx = ddx0;
            for x in x0..x1 {
                if ddx * ddx <= rz {
                    let c = x as usize & 15;
                    if yy <= lo[c] || (above_sea && yy <= top[c]) {
                        cells[c] = Block::Air as u8;
                    }
                }
                ddx += FPL;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(tag: u8) -> Seed {
        let mut b = [0u8; 32];
        for (i, v) in b.iter_mut().enumerate() {
            *v = (i as u8).wrapping_mul(53).wrapping_add(tag);
        }
        Seed::new(&b)
    }

    /// MAX_HITS is the exact max of voxel centres within `r` of an integer fixed-point
    /// centre (offsets 0..=128 per axis suffice by mirror symmetry, sorted by permutation
    /// symmetry).
    #[test]
    fn max_hits_exact() {
        for r in 1..=3i64 {
            let r2 = (r * FPL).pow(2);
            let axis = |o: i64| -> Vec<i64> {
                (-r - 1..=r + 1)
                    .map(|i| (i * FPL + FPL / 2 - o).pow(2))
                    .collect()
            };
            let axes: Vec<Vec<i64>> = (0..=128).map(axis).collect();
            let mut best = 0;
            for a in 0..=128usize {
                for b in a..=128 {
                    for c in b..=128 {
                        let mut n = 0;
                        for &dx in &axes[a] {
                            for &dy in &axes[b] {
                                if dx + dy > r2 {
                                    continue;
                                }
                                for &dz in &axes[c] {
                                    n += (dx + dy + dz <= r2) as u32;
                                }
                            }
                        }
                        best = best.max(n);
                    }
                }
            }
            println!("r={r}: max hits {best}");
            assert_eq!(best, MAX_HITS[r as usize], "r={r}");
        }
    }

    #[test]
    fn trig_table() {
        for a in 0..256 {
            let (s, c) = (sin256(a), cos256(a));
            let n = s * s + c * c;
            assert!((65536 - 1100..=65536 + 1100).contains(&n), "{a}: {s},{c}");
        }
        assert_eq!(
            (sin256(0), sin256(64), sin256(128), sin256(192)),
            (0, 256, 0, -256)
        );
    }

    #[test]
    fn worms_deterministic_bounded_and_counted() {
        let s = seed(1);
        let (mut total_worms, mut chunks_with) = (0, 0);
        for cz in -20..20 {
            for cx in -20..20 {
                let a: Vec<Sphere> = worms_for_chunk(&s, cx, cz).collect();
                let b: Vec<Sphere> = worms_for_chunk(&s, cx, cz).collect();
                assert_eq!(a, b);
                assert!(a.len() <= (MAX_WORMS * SEGS.1) as usize);
                let w = worms_for_chunk(&s, cx, cz).worms_left;
                assert!((0..=MAX_WORMS).contains(&w));
                total_worms += w;
                chunks_with += (w > 0) as i32;
                if w > 0 {
                    assert!(a.len() >= (w * SEGS.0) as usize);
                }
                let (ox, oz) = (cx as i64 * 16, cz as i64 * 16);
                for sp in &a {
                    assert!((RADIUS.0..=RADIUS.1).contains(&sp.r));
                    let (bx, by, bz) = (sp.x.div_euclid(FPL), sp.y / FPL, sp.z.div_euclid(FPL));
                    assert!((ox - 13..=ox + 29).contains(&bx), "{bx}");
                    assert!((oz - 13..=oz + 29).contains(&bz), "{bz}");
                    assert!((4..=52).contains(&by));
                }
                // Consecutive spheres of a worm overlap: the only gaps are worm starts.
                let mut gaps = 0;
                for p in a.windows(2) {
                    let d2 = (p[0].x - p[1].x).pow(2)
                        + (p[0].y - p[1].y).pow(2)
                        + (p[0].z - p[1].z).pow(2);
                    let rr = (p[0].r + p[1].r) as i64 * FPL;
                    gaps += (d2 > rr * rr) as i32;
                }
                assert!(gaps <= (w - 1).max(0), "gap");
            }
        }
        // ≈ 1 worm per chunk on average.
        assert!(total_worms > 1300 && total_worms < 1900, "{total_worms}");
        assert!(chunks_with > 800, "{chunks_with}");
        // Seed sensitivity.
        let a: Vec<Sphere> = (0..8).flat_map(|c| worms_for_chunk(&s, c, 0)).collect();
        let b: Vec<Sphere> = (0..8)
            .flat_map(|c| worms_for_chunk(&seed(2), c, 0))
            .collect();
        assert_ne!(a, b);
    }
}
