//! Cave worms: per-chunk hash-seeded tunnels, replayed from the 3×3 chunk neighborhood.
//! Integer-only, no heap.
//!
//! # Worms
//! Chunk `(cx, cz)` owns 0–2 worms ([`MAX_WORMS`]), drawn from one splitmix stream seeded by
//! `seed.h64(cx, cz, 0, SALT_WORM)`. A worm starts at a random block inside its chunk at
//! `y ∈ WORM_Y` and runs 20–40 segments. Positions are world fixed point (1/[`FP`] block,
//! `i64`, so any `i32` chunk coordinate is safe). Direction is a yaw angle on a 256-step
//! circle (quarter sine table, ×256) plus a vertical step `dy`; each segment the yaw drifts
//! by ±12 steps and `dy` by ±24 (clamped to ±80, i.e. ≤ 0.31 block/segment). The step length
//! is `(r + 1)/2` blocks, so consecutive spheres always overlap. Per-segment radius is the
//! worm's base radius (1–3) ±1, clamped to 1..=3.
//!
//! Containment: sphere centres are kept within `[origin − 13, origin + 29]` blocks (x and z,
//! `origin` = the worm's chunk origin; the yaw mirrors off a wall) and `y ∈ 4..=52`. With
//! `r ≤ 3`, no voxel whose centre is inside a sphere lies outside the worm's own 3×3 chunk
//! neighborhood, so replaying the 3×3 neighborhood of a chunk finds **every** sphere that can
//! touch it. That makes per-chunk carving equal to a single-buffer carve of the whole world.
//!
//! # Carving rule ([`carve_caves`])
//! A voxel is inside a sphere when its centre is within `r` blocks of the sphere centre
//! (`dx² + dy² + dz² ≤ (r·FP)²` in fixed point). It is turned into air iff
//! - `1 ≤ y < h(column)` — never bedrock, never the surface block or anything above it
//!   (so caves never open to the sky: trees, cacti and animals always keep the stage-1
//!   surface under them, and tree placement stays a pure function of stage-1 data), and
//! - none of its 6 neighbors is *wet* in stage 1. Wet = water (any level) **or ice**: ice
//!   only ever caps sea water at `SEA_LEVEL`, and carving next to it would expose a cave
//!   wall to a frozen sea that a later melt / break would flood, so it is treated as water.
//!
//! Wetness of in-chunk neighbors is read from the buffer (carving only ever writes air,
//! never touches a wet voxel, so the buffer's wet set equals stage 1's). Out-of-chunk
//! neighbors use the exact stage-1 rule: column `n` is wet at `y` iff
//! `h(n) < y ≤ SEA_LEVEL` (water fills `h+1..=SEA_LEVEL`, ice at `SEA_LEVEL` only where
//! `h < SEA_LEVEL`). The neighbor height comes from [`HeightWindow`], which runs
//! [`heights_chunk`](crate::terrain::heights_chunk) for a neighbor chunk lazily, only the
//! first time an edge voxel needs it. So the rule is exact on both sides of every border:
//! no carved voxel anywhere is adjacent to water or ice.
//!
//! # Cost (SBF ops ≈ CU)
//! Replaying 9 chunks ≈ 9 worms × 30 segments × ~60 ops (draws + step + bbox reject) ≈ 16k.
//! Spheres that hit the chunk: ≈ 3 worms × 30 = 90 × bbox (r=2: 125 voxels) × ~8 ops for
//! the row-pruned distance test ≈ 90k, plus ≈ 30 ops of rule checks per first-time carve.
//! Lazy neighbor heights: ≈ 35k per side loaded (0–4 typically).
//!
//! # SBF stack
//! [`carve_caves`] frame ≈ 0.2 KB (a [`Worms`] iterator, 100 B); neighbor heights are loaded
//! in [`HeightWindow`]'s own `#[inline(never)]` frame.

use crate::blocks::{is_fluid_u8, Block};
use crate::consts::{CHUNK_H, CHUNK_VOL, FP, SEA_LEVEL};
use crate::coords::block_index;
use crate::hash::{rand_range, splitmix_next, Seed};
use crate::populate::HeightWindow;

pub const SALT_WORM: u32 = 0xCA7E_0010;
/// Worms per chunk: `0..=MAX_WORMS`.
pub const MAX_WORMS: i32 = 2;
/// Segments per worm (inclusive).
pub const SEGS: (i32, i32) = (20, 40);
/// Sphere radius in blocks (inclusive).
pub const RADIUS: (i32, i32) = (1, 3);
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

/// sin of a 256-step angle, ×256.
#[inline(always)]
fn sin256(a: i32) -> i64 {
    let a = (a & 255) as usize;
    let v = match a {
        0..=64 => SIN_Q[a],
        65..=128 => SIN_Q[128 - a],
        129..=192 => -SIN_Q[a - 128],
        _ => -SIN_Q[256 - a],
    };
    v as i64
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
        }
        self.segs_left -= 1;
        let r = (self.base_r + draw(rng, -1, 1)).clamp(RADIUS.0, RADIUS.1);
        let s = Sphere {
            x: self.x,
            y: self.y,
            z: self.z,
            r,
        };
        // Advance: step (r + 1)/2 blocks along the yaw, plus dy.
        let step = (r as i64 + 1) * FPL / 2;
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

/// Carves caves into chunk `(cx, cz)` (stage-1 blocks in `blocks`) from the worms of its
/// 3×3 neighborhood, following the rule in the module docs. `win` supplies (and lazily
/// loads) neighbor column heights.
#[inline(never)]
pub fn carve_caves(
    seed: &Seed,
    cx: i32,
    cz: i32,
    blocks: &mut [u8; CHUNK_VOL],
    win: &mut HeightWindow,
) {
    let (ox, oz) = (cx as i64 * 16 * FPL, cz as i64 * 16 * FPL);
    for dz in -1..=1 {
        for dx in -1..=1 {
            for s in worms_for_chunk(seed, cx + dx, cz + dz) {
                carve_sphere(blocks, win, s.x - ox, s.y, s.z - oz, s.r);
            }
        }
    }
}

/// Carves one sphere given chunk-local fixed-point centre.
#[inline(always)]
fn carve_sphere(
    blocks: &mut [u8; CHUNK_VOL],
    win: &mut HeightWindow,
    lx: i64,
    ly: i64,
    lz: i64,
    r: i32,
) {
    let rf = r as i64 * FPL;
    // Bounding box (voxel centres at v·FP + FP/2): floor((c ± r) / FP) covers every voxel
    // whose centre can be within r.
    let x0 = ((lx - rf) >> 8).max(0);
    let x1 = ((lx + rf) >> 8).min(15);
    let z0 = ((lz - rf) >> 8).max(0);
    let z1 = ((lz + rf) >> 8).min(15);
    if x0 > x1 || z0 > z1 {
        return;
    }
    let y0 = ((ly - rf) >> 8).max(1);
    let y1 = ((ly + rf) >> 8).min(CHUNK_H as i64 - 2);
    let r2 = rf * rf;
    for y in y0..=y1 {
        let ddy = y * FPL + FPL / 2 - ly;
        let ry = r2 - ddy * ddy;
        if ry < 0 {
            continue;
        }
        for z in z0..=z1 {
            let ddz = z * FPL + FPL / 2 - lz;
            let rz = ry - ddz * ddz;
            if rz < 0 {
                continue;
            }
            for x in x0..=x1 {
                let ddx = x * FPL + FPL / 2 - lx;
                if ddx * ddx <= rz {
                    carve_voxel(blocks, win, x as i32, y as i32, z as i32);
                }
            }
        }
    }
}

#[inline(always)]
fn carve_voxel(blocks: &mut [u8; CHUNK_VOL], win: &mut HeightWindow, x: i32, y: i32, z: i32) {
    let i = block_index(x as usize, y as usize, z as usize);
    // y < h implies stage-1 solid (never water/ice/air); air here means already carved.
    if blocks[i] == Block::Air as u8 || y >= win.own(x as usize, z as usize) {
        return;
    }
    if is_wet_u8(blocks[i + 256]) || is_wet_u8(blocks[i - 256]) {
        return;
    }
    const NB: [(i32, i32); 4] = [(-1, 0), (1, 0), (0, -1), (0, 1)];
    for (nx, nz) in NB {
        let (nx, nz) = (x + nx, z + nz);
        let wet = if (0..16).contains(&nx) && (0..16).contains(&nz) {
            is_wet_u8(blocks[block_index(nx as usize, y as usize, nz as usize)])
        } else {
            y <= SEA_LEVEL && y > win.get(nx, nz)
        };
        if wet {
            return;
        }
    }
    blocks[i] = Block::Air as u8;
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
