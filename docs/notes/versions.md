# Toolchain and dependency versions

Recorded 2026-10-09 when scaffolding the workspace (Task 1). `anchor build` and
`cargo test -p magicraft-core` pass with this set.

## Toolchain

| Tool | Version |
|---|---|
| anchor-cli | 1.0.1 (`[toolchain] anchor_version` in `Anchor.toml`) |
| solana-cli (Agave) | 4.2.1 |
| cargo-build-sbf | 4.1.0, platform-tools v1.54 (rustc 1.89.0 for SBF) |
| host rustc | 1.96 nightly (default toolchain; no `rust-toolchain.toml` needed) |
| pnpm | 10.12.4 |

## Rust crates (resolved in `Cargo.lock`)

| Crate | Requirement | Resolved |
|---|---|---|
| anchor-lang | `=1.0.1` | 1.0.1 (and every `anchor-attribute-*`, `anchor-derive-*`, `anchor-syn` at 1.0.1) |
| ephemeral-rollups-sdk | `0.17`, features `anchor`, `vrf` | 0.17.3 (pulls ephemeral-vrf-sdk 0.17.3) |
| session-keys | `3`, feature `no-entrypoint` | 3.1.1 |
| magicblock-magic-program-api | `0.14` | 0.14.10 |
| bincode | `1` | 1.3.3 |
| bytemuck | `1`, features `derive`, `min_const_generics` (Task 15) | 1.25.2 (+ bytemuck_derive 1.12.1; both were already in the lock via Solana crates, so adding it changed only the magicraft dependency list) |
| solana-sha256-hasher | `3.1` (Task 16: crank task ids, VRF caller seed) | 3.1.0 (already in the lock via Anchor's Solana crates; only the dependency list changed) |
| magicraft-core | path `crates/core` | 0.1.0 |
| wasm-bindgen (`crates/core-wasm` only, Task 25) | `=0.2.129` | 0.2.129 (already in the lock via Solana crates; adding it changed only the new package's entry) |

## npm

| Package | Version |
|---|---|
| @anchor-lang/core | 1.0.1 (Anchor 1.x renamed `@coral-xyz/anchor`) |
| @magicblock-labs/ephemeral-rollups-sdk | 0.17.3 |

## Notes and reasoning

- **No conflict between the MagicBlock crates and Anchor 1.x.** ephemeral-rollups-sdk
  0.17.3's `anchor` feature maps to `anchor-modern`, which depends on
  `anchor-lang = "1.0"` (its `anchor-compat` feature is the `<1.0` path, not used).
  session-keys 3.1.1 accepts `anchor-lang >=0.28, <2.0`. So everything unifies on a
  single anchor-lang.
- **Anchor pinned to exactly 1.0.1 to match the CLI.** A plain `"1.0.1"` requirement
  resolved anchor-lang to 1.2.1. Because anchor-lang 1.0.1 itself depends on its
  macro crates with caret requirements, pinning only anchor-lang left
  `anchor-attribute-*`/`anchor-syn` at 1.2.1 (a mixed set). Fix: `anchor-lang = "=1.0.1"`
  in `programs/magicraft/Cargo.toml` plus `cargo update -p <crate> --precise 1.0.1` for
  each anchor macro crate; the committed `Cargo.lock` keeps them there. If the CLI is
  upgraded, bump all of these together (`cargo update -p anchor-lang` etc.).
  **Never run bare `cargo update`; run `scripts/check-anchor-pin.sh` after dependency
  changes.**
- **Two magicblock-magic-program-api versions in the graph.** ephemeral-rollups-sdk
  0.17.3 depends internally on magicblock-magic-program-api 0.10.1, while the program
  depends directly on 0.14.10 (needed for newer magic-program instructions such as
  ephemeral accounts / crank scheduling). They build side by side, but types from the
  two versions are distinct: do not pass 0.14 types into SDK APIs that expect the
  SDK's re-exported 0.10 types (or vice versa).
- ephemeral-rollups-sdk pulls both solana-program 2.3 and 3.0 (anchor-lang 1.0.1 itself uses the
  modular 3.x crates); this compiles cleanly for SBF.
- The `#[ephemeral]` macro adds a `process_undelegation` instruction to the IDL next to
  `ping`.
- **`magicraft-core` builds without overflow checks in release** (`[profile.release.package.magicraft-core]
  overflow-checks = false`, Task 17): checked `i64` multiplication is a software routine on SBF and
  pushed terrain stage 1 past the 1.4M CU limit (≈ 2.5× slower). Debug/test builds keep the checks;
  the program crate keeps them in release. **Any other build of `magicraft-core` that must match
  onchain results (e.g. the wasm client) must use the same profile setting** (see the crate docs).
- **Client wasm build of the core (Task 25).** `crates/core-wasm` (wasm-bindgen wrapper:
  `check_move`, `move_window`, `block_flags`, …) is built by `pnpm -C app build:wasm`
  (`app/scripts/build-wasm.sh`: wasm-pack 0.15.0, `--release --target web --mode no-install`,
  offline when wasm-pack's cache holds the wasm-bindgen 0.2.129 CLI + binaryen; `wasm-opt -O`)
  into `app/src/wasm/pkg/` (**committed**: dev, test and build need no Rust toolchain; rebuild
  after changing `crates/core` physics/blocks). The release profile builds both
  `magicraft-core` and `magicraft-core-wasm` with `overflow-checks = false` (root
  `Cargo.toml`), like the program. `core_bg.wasm` ≈ 24 KB (≈ 11 KB gzip). The wasm-bindgen
  crate and CLI versions must match exactly; bump both together. Staleness guard:
  `crates/core-wasm/build.rs` hashes `crates/core/Cargo.toml`, `crates/core/src/**` and
  `crates/core-wasm/src/**` (FNV-1a 64, sorted paths) into `core_src_hash()`;
  `app/src/wasm/hash.test.ts` recomputes it and fails with "run `pnpm -C app build:wasm`".
