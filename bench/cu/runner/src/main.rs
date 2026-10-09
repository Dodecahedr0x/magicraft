//! Runs the SBF CU bench program (`../src/lib.rs`) in litesvm and prints CU per component.
//!
//! `magicraft-cu-runner <bench.so> <mode> [seeds] [n]`
//! - `stage1`: per chunk, `biomes_chunk`, `heights_chunk`, `generate_stage1`, side strip,
//!   corner.
//! - `stage2 <x0> <z0> <n>`: `generate_stage2` for the `n×n` chunks at `(x0, z0)`, with
//!   strips/corners loaded and cave ops; prints mean / max and the costliest chunks.
//! - `one <kind> <cx> <cz>`: a single run (prints the raw logs).
//! - `carvecal`, `replay`, `fixed`: calibration of the unit costs behind
//!   `magicraft_core::populate::STAGE2_CU_BOUND` (see `../run.sh calibrate`).
//! Seeds: `SEEDS` env = comma-separated tags (default `1,2`); seed bytes = `i·37 + tag`.

use litesvm::LiteSVM;
use solana_compute_budget::compute_budget::ComputeBudget;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

struct Bench {
    svm: LiteSVM,
    payer: Keypair,
    prog: solana_pubkey::Pubkey,
    nonce: u64,
}

fn seed_bytes(tag: u8) -> [u8; 32] {
    core::array::from_fn(|i| (i as u8).wrapping_mul(37).wrapping_add(tag))
}

impl Bench {
    fn new(so: &str) -> Self {
        let mut cb = ComputeBudget::new_with_defaults(false);
        cb.compute_unit_limit = 20_000_000;
        let mut svm = LiteSVM::new().with_compute_budget(cb);
        let prog = Keypair::new().pubkey();
        svm.add_program_from_file(prog, so).expect("load program");
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
        Bench {
            svm,
            payer,
            prog,
            nonce: 0,
        }
    }

    /// Like `run` with extra instruction data after the 41-byte header (cx = cz = 0).
    fn run_extra(&mut self, kind: u8, seed: &[u8; 32], extra: &[u8]) -> (Vec<u64>, Vec<Vec<u64>>) {
        let mut data = vec![kind];
        data.extend_from_slice(&[0u8; 8]);
        data.extend_from_slice(seed);
        data.extend_from_slice(extra);
        self.send(data)
    }

    fn send(&mut self, mut data: Vec<u8>) -> (Vec<u64>, Vec<Vec<u64>>) {
        self.nonce += 1;
        data.extend_from_slice(&self.nonce.to_le_bytes());
        let ix = Instruction {
            program_id: self.prog,
            accounts: vec![],
            data,
        };
        let msg = Message::new(&[ix], Some(&self.payer.pubkey()));
        let tx = Transaction::new(&[&self.payer], msg, self.svm.latest_blockhash());
        let logs = match self.svm.send_transaction(tx) {
            Ok(m) => m.logs,
            Err(e) => panic!("{:?}\n{:#?}", e.err, e.meta.logs),
        };
        parse(&logs)
    }

    /// Returns (logged CU deltas, sol_log_64 values).
    fn run(
        &mut self,
        kind: u8,
        cx: i32,
        cz: i32,
        seed: &[u8; 32],
    ) -> (Vec<u64>, Vec<Vec<u64>>, Vec<String>) {
        let mut data = vec![kind];
        data.extend_from_slice(&cx.to_le_bytes());
        data.extend_from_slice(&cz.to_le_bytes());
        data.extend_from_slice(seed);
        // Unique tx per call (nonce in trailing bytes, ignored by the program).
        self.nonce += 1;
        data.extend_from_slice(&self.nonce.to_le_bytes());
        let ix = Instruction {
            program_id: self.prog,
            accounts: vec![],
            data,
        };
        let msg = Message::new(&[ix], Some(&self.payer.pubkey()));
        let tx = Transaction::new(&[&self.payer], msg, self.svm.latest_blockhash());
        let logs = match self.svm.send_transaction(tx) {
            Ok(m) => m.logs,
            Err(e) => panic!(
                "kind {kind} chunk {cx},{cz}: {:?}\n{:#?}",
                e.err, e.meta.logs
            ),
        };
        let (deltas, vals) = parse(&logs);
        (deltas, vals, logs)
    }
}

/// (CU deltas between `sol_log_compute_units` calls, minus their 100 CU; `sol_log_64` values)
fn parse(logs: &[String]) -> (Vec<u64>, Vec<Vec<u64>>) {
    let mut rem = vec![];
    let mut vals = vec![];
    for l in logs {
        if let Some(r) = l.strip_prefix("Program consumption: ") {
            rem.push(r.split(' ').next().unwrap().parse::<u64>().unwrap());
        } else if let Some(r) = l.strip_prefix("Program log: ") {
            let v: Vec<u64> = r
                .split(", ")
                .filter_map(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).ok())
                .collect();
            if v.len() == 5 {
                vals.push(v);
            }
        }
    }
    // Each sol_log_compute_units costs 100 CU (charged before it logs).
    let deltas = rem.windows(2).map(|w| w[0] - w[1] - 100).collect();
    (deltas, vals)
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let mut b = Bench::new(&a[1]);
    let tags: Vec<u8> = std::env::var("SEEDS")
        .unwrap_or_else(|_| "1,2".into())
        .split(',')
        .map(|s| s.parse().unwrap())
        .collect();
    match a[2].as_str() {
        "one" => {
            let (k, cx, cz): (u8, i32, i32) = (
                a[3].parse().unwrap(),
                a[4].parse().unwrap(),
                a[5].parse().unwrap(),
            );
            let (d, v, logs) = b.run(k, cx, cz, &seed_bytes(tags[0]));
            println!("{logs:#?}\nCU {d:?} vals {v:?}");
        }
        "stage1" => {
            let chunks = [
                (0, 0),
                (1, 0),
                (-1, -1),
                (3, -7),
                (-12, 5),
                (40, 40),
                (-100, 63),
                (7, 7),
            ];
            println!("seed chunk        biomes  heights  stage1   strip   corner");
            let mut mx = [0u64; 5];
            for &t in &tags {
                for &(cx, cz) in &chunks {
                    let s = seed_bytes(t);
                    let r: Vec<u64> = (1..=5).map(|k| b.run(k, cx, cz, &s).0[0]).collect();
                    for i in 0..5 {
                        mx[i] = mx[i].max(r[i]);
                    }
                    println!(
                        "{t:>4} {:>12} {:>7} {:>8} {:>7} {:>7} {:>7}",
                        format!("{cx},{cz}"),
                        r[0],
                        r[1],
                        r[2],
                        r[3],
                        r[4]
                    );
                }
            }
            println!(
                "max  {:>12} {:>7} {:>8} {:>7} {:>7} {:>7}",
                "", mx[0], mx[1], mx[2], mx[3], mx[4]
            );
        }
        "stage2" => {
            let (x0, z0, n): (i32, i32, i32) = (
                a[3].parse().unwrap(),
                a[4].parse().unwrap(),
                a[5].parse().unwrap(),
            );
            let mut all = vec![];
            for &t in &tags {
                let s = seed_bytes(t);
                for cz in z0..z0 + n {
                    for cx in x0..x0 + n {
                        let (d, v, _) = b.run(6, cx, cz, &s);
                        all.push((d[0], t, cx, cz, v[0].clone()));
                    }
                }
            }
            all.sort();
            let mean = all.iter().map(|r| r.0).sum::<u64>() / all.len() as u64;
            println!(
                "stage2 over {} chunks: min {} median {} mean {} max {}",
                all.len(),
                all[0].0,
                all[all.len() / 2].0,
                mean,
                all[all.len() - 1].0
            );
            for r in all.iter().rev().take(5) {
                println!(
                    "  {} CU seed {} chunk {},{} sides {} corners {} cave ops {} demand {}",
                    r.0, r.1, r.2, r.3, r.4[0], r.4[1], r.4[2], r.4[3]
                );
            }
        }
        "fixed" => {
            // Max over chunks of the data-dependent-but-bounded parts.
            let mut mx = [0u64; 5];
            for &t in &tags {
                let s = seed_bytes(t);
                for cz in -10..10 {
                    for cx in -10..10 {
                        let a = b.run(15, cx, cz, &s).0;
                        let c = b.run(16, cx, cz, &s).0;
                        let i = b.run(17, cx, cz, &s).0;
                        for (m, v) in
                            mx.iter_mut()
                                .zip([a[0], a[1], c[1], i[0], b.run(23, cx, cz, &s).0[0]])
                        {
                            *m = (*m).max(v);
                        }
                    }
                }
            }
            println!(
                "max: WindowSums {}  side strip {}  corner {}  stage1_info {}  48 biome_at {}",
                mx[0], mx[1], mx[2], mx[3], mx[4]
            );
        }
        "replay" => {
            // Fit replay+clip cost B ≤ a + b·spheres over many chunks (b = max marginal).
            let mut pts = vec![];
            for &t in &tags {
                let s = seed_bytes(t);
                for cz in -12..12 {
                    for cx in -12..12 {
                        let (d, v, _) = b.run(21, cx, cz, &s);
                        pts.push((v[0][0], d[1]));
                    }
                }
            }
            for bslope in [200u64, 220, 240, 260, 280] {
                let a = pts
                    .iter()
                    .map(|&(n, c)| c as i64 - (bslope * n) as i64)
                    .max()
                    .unwrap();
                println!("replay: slope {bslope} CU/sphere -> intercept {a}");
            }
            let mx = pts.iter().max_by_key(|p| p.1).unwrap();
            println!(
                "max replay {} CU at {} spheres; max spheres {}",
                mx.1,
                mx.0,
                pts.iter().map(|p| p.0).max().unwrap()
            );
        }
        "carvecal" => {
            // Per-sphere carve cost over enumerated geometries; fit cu ≤ c0 + c1·ops.
            let s = seed_bytes(1);
            let mut pts = vec![];
            let ints: Vec<i32> = vec![-3, -2, -1, 0, 1, 2, 7, 13, 14, 15, 16, 17, 18];
            let fr = [0, 1, 64, 128, 192, 255];
            for r in 1..=3u8 {
                for &(y, lo, top) in &[
                    (45 * 256 + 128, 0u8, 63u8),
                    (12 * 256 + 64, 63, 63),
                    (2 * 256, 63, 63),
                    (33 * 256, 0, 63),
                ] {
                    for &xi in &ints {
                        for &xf in &fr {
                            for &zi in &ints {
                                for &zf in &[0, 128, 255] {
                                    let (x, z) = (xi * 256 + xf, zi * 256 + zf);
                                    let mut data = vec![];
                                    for v in [x, y, z] {
                                        data.extend_from_slice(&v.to_le_bytes());
                                    }
                                    data.extend_from_slice(&[r, lo, top]);
                                    let (d, v) = b.run_extra(20, &s, &data);
                                    if v[0][0] > 0 {
                                        pts.push((d[0], v[0][0], r, x, y, z));
                                    }
                                }
                            }
                        }
                    }
                }
            }
            println!("{} geometries", pts.len());
            for c1 in [0.6f64, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3] {
                let w = pts
                    .iter()
                    .max_by(|a, b| {
                        (a.0 as f64 - c1 * a.1 as f64).total_cmp(&(b.0 as f64 - c1 * b.1 as f64))
                    })
                    .unwrap();
                println!(
                    "c1 {c1:.1}: c0 = {:.0} (cu {} ops {} r {} at {},{},{})",
                    w.0 as f64 - c1 * w.1 as f64,
                    w.0,
                    w.1,
                    w.2,
                    w.3,
                    w.4,
                    w.5
                );
            }
            let w = pts
                .iter()
                .max_by(|a, b| (a.0 as f64 / a.1 as f64).total_cmp(&(b.0 as f64 / b.1 as f64)))
                .unwrap();
            println!(
                "max ratio {:.3} (cu {} ops {})",
                w.0 as f64 / w.1 as f64,
                w.0,
                w.1
            );
            let big: Vec<_> = pts.iter().filter(|p| p.1 >= 2000).collect();
            let w = big
                .iter()
                .max_by(|a, b| (a.0 as f64 / a.1 as f64).total_cmp(&(b.0 as f64 / b.1 as f64)))
                .unwrap();
            println!(
                "max ratio for ops >= 2000: {:.3} (cu {} ops {})",
                w.0 as f64 / w.1 as f64,
                w.0,
                w.1
            );
        }
        m => panic!("mode {m}"),
    }
}
