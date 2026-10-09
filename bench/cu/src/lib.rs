//! Raw SBF entrypoint that runs one terrain component and logs its CU with
//! `sol_log_compute_units` (the runner subtracts the 100 CU each log costs).
//!
//! Instruction data: `kind: u8, cx: i32 LE, cz: i32 LE, seed: [u8; 32]` (+ kind-specific
//! bytes), no accounts. Kinds: 1 `biomes_chunk`, 2 `heights_chunk`, 3 `generate_stage1`,
//! 4 side strip `heights_cols(14, 0, 2, 16)`, 5 corner `heights_cols(14, 14, 2, 2)`,
//! 6 `generate_stage1` then `generate_stage2_stats` (logs sides, corners, cave ops, cave
//! demand, animals), 7-9 `fbm_chunk` (1/2/3 octaves), 10 `fbm_grid9`, 11-12 small
//! `fbm_rect`s, 13 empty (log overhead), 14 `WindowSums::new`, 15/16 `WindowSums::new` then
//! a window side strip / corner, 17 `generate_stage1` then `stage1_info_from_blocks`,
//! 20 one carved sphere (`bench_carve_one`; centre i32 ×3, r, lo, top), 21 worm replay
//! (plain iteration, `carve_caves_capped` with cap 0, then `bench_replay_touching`), 22
//! `col_limits`, 18 `WindowSums::new` then a z side strip, 26 54 tree candidates, 23 48 × `biome_at`, 24 one tree write at local `(cx, cz)`, 25 ores + cacti +
//! animals.
//! Scratch buffers live in the 32 KB SBF heap region (no allocator is used).

use magicraft_core::caves::{
    bench_carve_one, bench_col_limits, bench_replay_touching, carve_caves_capped, worms_for_chunk,
    Lim,
};
use magicraft_core::consts::CHUNK_VOL;
use magicraft_core::hash::Seed;
use magicraft_core::noise::{fbm_chunk, fbm_grid9, fbm_rect};
use magicraft_core::populate::{
    bench_write_tree, generate_stage2_stats, place_cacti, place_ores, spawn_animals, HeightWindow,
    MobSpawn, MAX_SPAWNS,
};
use magicraft_core::populate::{tree_candidate, TREE_CANDIDATES};
use magicraft_core::terrain::{
    biome_at, biomes_chunk, generate_stage1, heights_chunk, heights_cols, stage1_info_from_blocks,
    window_heights, Stage1Info, WindowSums,
};

extern "C" {
    fn sol_log_compute_units_();
    fn sol_log_64_(a: u64, b: u64, c: u64, d: u64, e: u64);
}

const HEAP: usize = 0x3_0000_0000;

/// # Safety
/// Called by the SBF loader with a serialized input of zero accounts.
#[no_mangle]
pub unsafe extern "C" fn entrypoint(input: *mut u8) -> u64 {
    let n_acc = *(input as *const u64);
    if n_acc != 0 {
        return 1;
    }
    let len = *(input.add(8) as *const u64) as usize;
    let d = core::slice::from_raw_parts(input.add(16), len);
    if len < 41 {
        return 2;
    }
    let kind = d[0];
    let cx = i32::from_le_bytes([d[1], d[2], d[3], d[4]]);
    let cz = i32::from_le_bytes([d[5], d[6], d[7], d[8]]);
    let mut sb = [0u8; 32];
    sb.copy_from_slice(&d[9..41]);
    let seed = Seed::new(&sb);
    let blocks = &mut *(HEAP as *mut [u8; CHUNK_VOL]);
    let info = &mut *((HEAP + CHUNK_VOL) as *mut Stage1Info);
    let mobs = &mut *((HEAP + CHUNK_VOL + 2048) as *mut [MobSpawn; MAX_SPAWNS]);
    let h = &mut *((HEAP + CHUNK_VOL + 4096) as *mut [i32; 256]);
    let acc: u64;
    match kind {
        1 => {
            sol_log_compute_units_();
            biomes_chunk(&seed, cx, cz, &mut info.biomes);
            sol_log_compute_units_();
            acc = info.biomes[3] as u64;
        }
        2 => {
            sol_log_compute_units_();
            heights_chunk(&seed, cx, cz, h);
            sol_log_compute_units_();
            acc = h[3] as u64;
        }
        3 => {
            sol_log_compute_units_();
            generate_stage1(&seed, cx, cz, blocks, info);
            sol_log_compute_units_();
            acc = blocks[5000] as u64;
        }
        4 => {
            sol_log_compute_units_();
            heights_cols(&seed, cx, cz, 14, 0, 2, 16, &mut h[..]);
            sol_log_compute_units_();
            acc = h[3] as u64;
        }
        5 => {
            sol_log_compute_units_();
            heights_cols(&seed, cx, cz, 14, 14, 2, 2, &mut h[..]);
            sol_log_compute_units_();
            acc = h[3] as u64;
        }
        6 => {
            generate_stage1(&seed, cx, cz, blocks, info);
            sol_log_compute_units_();
            let (n, st) = generate_stage2_stats(&seed, cx, cz, blocks, info, mobs);
            sol_log_compute_units_();
            sol_log_64_(
                st.sides_loaded as u64,
                st.corners_loaded as u64,
                st.caves.ops as u64,
                st.caves.demand as u64,
                n as u64,
            );
            acc = blocks[5000] as u64;
        }
        7..=9 => {
            sol_log_compute_units_();
            let (o, k) = [(1, 8), (2, 8), (3, 5)][(kind - 7) as usize];
            fbm_chunk(&seed, cx * 16, cz * 16, o, k, 5, h);
            sol_log_compute_units_();
            acc = h[3] as u64;
        }
        10 => {
            sol_log_compute_units_();
            fbm_grid9(
                &seed,
                cx * 4,
                cz * 4,
                2,
                6,
                5,
                (&mut h[..81]).try_into().unwrap(),
            );
            sol_log_compute_units_();
            acc = h[3] as u64;
        }
        11 => {
            sol_log_compute_units_();
            fbm_rect(&seed, cx * 4, cz * 4, 6, 6, 2, 4, 5, &mut h[..]);
            sol_log_compute_units_();
            acc = h[3] as u64;
        }
        12 => {
            sol_log_compute_units_();
            fbm_rect(&seed, cx * 16, cz * 16, 2, 2, 3, 5, 5, &mut h[..]);
            sol_log_compute_units_();
            acc = h[3] as u64;
        }
        13 => {
            sol_log_compute_units_();
            sol_log_compute_units_();
            acc = 0;
        }
        18 => {
            let sums = WindowSums::new(&seed, cx, cz);
            sol_log_compute_units_();
            window_heights(&seed, &sums, cx, cz, (0, 16), (16, 2), &mut h[..]);
            sol_log_compute_units_();
            acc = h[3] as u64;
        }
        26 => {
            sol_log_compute_units_();
            let mut a = 0u64;
            for dz in -1..=1 {
                for dx in -1..=1 {
                    for i in 0..TREE_CANDIDATES {
                        let (tx, tz, roll, t) = tree_candidate(&seed, cx + dx, cz + dz, i);
                        let (lx, lz) = (tx + dx * 16, tz + dz * 16);
                        if (-2..18).contains(&lx) && (-2..18).contains(&lz) {
                            a += roll as u64 + t as u64;
                        }
                    }
                }
            }
            sol_log_compute_units_();
            acc = a;
        }
        14..=16 => {
            sol_log_compute_units_();
            let sums = WindowSums::new(&seed, cx, cz);
            sol_log_compute_units_();
            let (xs, zs) = if kind == 15 {
                ((16, 2), (0, 16))
            } else {
                ((-2, 2), (-2, 2))
            };
            if kind > 14 {
                window_heights(&seed, &sums, cx, cz, xs, zs, &mut h[..]);
            }
            sol_log_compute_units_();
            acc = h[3] as u64;
        }
        17 => {
            generate_stage1(&seed, cx, cz, blocks, info);
            let bytes = &mut *((HEAP + CHUNK_VOL + 6144) as *mut [u8; 256]);
            for (b, v) in bytes.iter_mut().zip(info.biomes.iter()) {
                *b = *v as u8;
            }
            sol_log_compute_units_();
            stage1_info_from_blocks(blocks, bytes, info);
            sol_log_compute_units_();
            acc = info.heights[7] as u64;
        }
        20 => {
            // One sphere: centre (i32 LE ×3, chunk-local fixed point), r, lo, top.
            if len < 56 {
                return 2;
            }
            let rd = |o: usize| i32::from_le_bytes([d[o], d[o + 1], d[o + 2], d[o + 3]]) as i64;
            let c = (rd(41), rd(45), rd(49));
            let lim = &mut *((HEAP + CHUNK_VOL + 8192) as *mut Lim);
            lim.lo.fill(d[54]);
            lim.top.fill(d[55]);
            sol_log_compute_units_();
            let ops = bench_carve_one(blocks, lim, c, d[53] as i32);
            sol_log_compute_units_();
            acc = ops as u64;
        }
        21 => {
            // Worm replay: plain iteration of the 9 chunks' worms, then carve_caves with cap 0
            // (replay + clip + ops bound per sphere, nothing carved).
            let mut n = 0u64;
            sol_log_compute_units_();
            for dz in -1..=1 {
                for dx in -1..=1 {
                    for s in worms_for_chunk(&seed, cx + dx, cz + dz) {
                        n += s.r as u64;
                    }
                }
            }
            sol_log_compute_units_();
            let mut win = HeightWindow::new(&seed, cx, cz, h);
            let st = carve_caves_capped(&seed, cx, cz, blocks, &info.biomes, &mut win, 0);
            sol_log_compute_units_();
            let all = bench_replay_touching(&seed, cx, cz);
            sol_log_compute_units_();
            let mut cnt = 0u64;
            for dz in -1..=1 {
                for dx in -1..=1 {
                    cnt += worms_for_chunk(&seed, cx + dx, cz + dz).count() as u64;
                }
            }
            sol_log_64_(
                cnt,
                st.skipped as u64,
                st.demand as u64,
                n,
                all.skipped as u64,
            );
            acc = 0;
        }
        22 => {
            generate_stage1(&seed, cx, cz, blocks, info);
            let mut win = HeightWindow::new(&seed, cx, cz, &info.heights);
            for (x, z) in [(-1, 0), (16, 0), (0, -1), (0, 16)] {
                win.get(x, z);
            }
            let lim = &mut *((HEAP + CHUNK_VOL + 8192) as *mut [Lim; 2]);
            sol_log_compute_units_();
            bench_col_limits(&mut win, &info.biomes, lim);
            sol_log_compute_units_();
            acc = lim[0].lo[9] as u64;
        }
        25 => {
            generate_stage1(&seed, cx, cz, blocks, info);
            sol_log_compute_units_();
            place_ores(&seed, cx, cz, blocks);
            place_cacti(&seed, cx, cz, blocks, info);
            let n = spawn_animals(&seed, cx, cz, blocks, info, mobs);
            sol_log_compute_units_();
            acc = n as u64;
        }
        23 => {
            sol_log_compute_units_();
            let mut a = 0u64;
            for i in 0..48 {
                a += biome_at(&seed, cx * 16 + i * 5, cz * 16 - i * 3) as u64;
            }
            sol_log_compute_units_();
            acc = a;
        }
        24 => {
            // One tree at local (cx, cz) (may be outside 0..16), surface 30, trunk 6, into air
            // above a zero-height window (every in-chunk voxel is written).
            blocks.fill(0);
            h.fill(0);
            let win = HeightWindow::new(&seed, 0, 0, h);
            sol_log_compute_units_();
            bench_write_tree(blocks, &win, cx, 30, cz, 6);
            sol_log_compute_units_();
            acc = blocks[30 * 256 + 5] as u64;
        }
        _ => return 3,
    }
    sol_log_64_(acc, 0, 0, 0, 0);
    0
}
