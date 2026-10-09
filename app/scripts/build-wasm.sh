#!/usr/bin/env bash
# Builds crates/core-wasm into app/src/wasm/pkg (committed, so dev/test/build need no Rust
# toolchain). Release profile: magicraft-core without overflow checks, like the program.
# Needs wasm-pack 0.15 + the wasm32-unknown-unknown target; offline when wasm-pack's cache
# already holds wasm-bindgen 0.2.129 (the version pinned in crates/core-wasm) and binaryen.
set -euo pipefail
cd "$(dirname "$0")/../.."
CARGO_NET_OFFLINE="${CARGO_NET_OFFLINE:-true}" wasm-pack build crates/core-wasm \
  --release --target web --mode no-install --no-pack \
  --out-dir ../../app/src/wasm/pkg --out-name core
rm -f app/src/wasm/pkg/.gitignore
ls -l app/src/wasm/pkg
