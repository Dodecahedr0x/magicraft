//! Reference generation for tests: `cargo run --release -p magicraft-core --example gen --
//! <seed_hex (64 chars)> <cx> <cz>`.
//!
//! Writes to stdout (binary, 16 384 + 256 + 16 384 + 1 + 4·3 + 3 = 33 040 bytes):
//! 1. stage-1 blocks (16 384, index `y * 256 + z * 16 + x`, as `grow_chunk` leaves them),
//! 2. biomes (256, index `lz * 16 + lx`, the `Chunk` header's `biomes`),
//! 3. final blocks after stage 2 (16 384, as `populate_chunk` leaves them),
//! 4. the animal count `n` (1 byte) and `MAX_SPAWNS` (3) spawns as `kind, x, y, z`
//!    (unused slots zero),
//! 5. `populate::spawn_point` of the final blocks (`lx, y, lz`, 3 bytes; only meaningful
//!    for chunk (0,0)).

use std::io::Write;

use magicraft_core::consts::CHUNK_VOL;
use magicraft_core::hash::Seed;
use magicraft_core::populate::{generate_stage2, spawn_point, MobSpawn, MAX_SPAWNS};
use magicraft_core::terrain::{generate_stage1, Stage1Info};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 || args[1].len() != 64 {
        eprintln!("usage: gen <seed_hex (32 bytes)> <cx> <cz>");
        std::process::exit(2);
    }
    let mut seed = [0u8; 32];
    for (i, b) in seed.iter_mut().enumerate() {
        *b = u8::from_str_radix(&args[1][2 * i..2 * i + 2], 16).expect("seed hex");
    }
    let cx: i32 = args[2].parse().expect("cx");
    let cz: i32 = args[3].parse().expect("cz");
    let s = Seed::new(&seed);

    let mut blocks = vec![0u8; CHUNK_VOL];
    let blocks: &mut [u8; CHUNK_VOL] = blocks.as_mut_slice().try_into().unwrap();
    let mut info = Box::new(Stage1Info::EMPTY);
    generate_stage1(&s, cx, cz, blocks, &mut info);
    let stage1 = blocks.to_vec();
    let biomes: Vec<u8> = info.biomes.iter().map(|b| *b as u8).collect();

    let mut mobs = [MobSpawn::default(); MAX_SPAWNS];
    let n = generate_stage2(&s, cx, cz, blocks, &info, &mut mobs);
    let (sx, sy, sz) = spawn_point(blocks);

    let mut out = Vec::with_capacity(2 * CHUNK_VOL + 256 + 16);
    out.extend_from_slice(&stage1);
    out.extend_from_slice(&biomes);
    out.extend_from_slice(blocks);
    out.push(n as u8);
    for m in &mobs {
        out.extend_from_slice(&[m.kind, m.x, m.y, m.z]);
    }
    out.extend_from_slice(&[sx, sy, sz]);
    std::io::stdout().write_all(&out).unwrap();
}
