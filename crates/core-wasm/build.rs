//! Source hash for staleness checks: FNV-1a 64 over every input file of this build
//! (`crates/core/Cargo.toml`, `crates/core/src/**`, `crates/core-wasm/src/**`), sorted by
//! path relative to `crates/`, each fed as `path \0 bytes \0`. Exported by
//! `core_src_hash()`; `app/src/wasm/hash.test.ts` recomputes it from the sources so a
//! committed `app/src/wasm/pkg` older than the core fails the app tests.
use std::fs;
use std::path::{Path, PathBuf};

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out);
        } else {
            out.push(p);
        }
    }
}

fn main() {
    let here = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let crates = here.parent().unwrap().to_path_buf();
    let mut files = vec![crates.join("core/Cargo.toml")];
    walk(&crates.join("core/src"), &mut files);
    walk(&here.join("src"), &mut files);
    let mut rel: Vec<(String, PathBuf)> = files
        .into_iter()
        .map(|p| {
            let r = p
                .strip_prefix(&crates)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            (r, p)
        })
        .collect();
    rel.sort();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |b: &[u8]| {
        for &x in b {
            h ^= x as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    };
    for (r, p) in &rel {
        feed(r.as_bytes());
        feed(&[0]);
        feed(&fs::read(p).unwrap());
        feed(&[0]);
    }
    println!("cargo:rustc-env=CORE_SRC_HASH={h:016x}");
    println!("cargo:rerun-if-changed=../core/Cargo.toml");
    println!("cargo:rerun-if-changed=../core/src");
    println!("cargo:rerun-if-changed=src");
}
