#!/usr/bin/env bash
# SBF compute-unit bench for magicraft-core terrain generation (Task 17b).
#
#   bench/cu/run.sh stage1            # biomes / heights / generate_stage1 / strip / corner
#   bench/cu/run.sh stage2 [x z n]    # generate_stage2 over an n×n chunk area (default -8 -8 16)
#   bench/cu/run.sh calibrate         # unit costs behind populate::STAGE2_CU_BOUND
#   bench/cu/run.sh one <kind> <cx> <cz>   # one run with raw logs (kinds: src/lib.rs)
#   SEEDS=1,2,3 bench/cu/run.sh ...   # seed tags (seed byte i = i·37 + tag)
#
# Builds `bench/cu` (a raw-entrypoint SBF program whose only dependency is magicraft-core,
# with the workspace's release profile) and runs it in litesvm via `runner/` (host binary).
# Both are separate cargo workspaces with their own lockfiles; nothing here touches the main
# workspace or the network (`--offline`). Profiling: set SBF_TRACE_DIR=<dir> for register
# traces (litesvm `register-tracing`). CU deltas exclude the 100 CU of each log syscall.
set -euo pipefail
cd "$(dirname "$0")"

cargo-build-sbf --offline --manifest-path Cargo.toml >/dev/null 2>&1 ||
  cargo-build-sbf --offline --manifest-path Cargo.toml
# litesvm's agave deps declare a newer rust-version than some toolchains; they build fine.
cargo build -q --release --offline --ignore-rust-version --manifest-path runner/Cargo.toml

R=runner/target/release/magicraft-cu-runner
SO=target/deploy/magicraft_cu_bench.so
mode="${1:-stage1}"
case "$mode" in
  stage1) "$R" "$SO" stage1 ;;
  stage2) "$R" "$SO" stage2 "${2:--8}" "${3:--8}" "${4:-16}" ;;
  calibrate)
    "$R" "$SO" carvecal
    "$R" "$SO" replay
    "$R" "$SO" fixed
    echo "tree writes (local trunk x z: CU):"
    for x in -2 -1 0 7 15 16 17; do
      for z in -2 -1 0 7 15 16 17; do
        echo "  $x $z: $("$R" "$SO" one 24 "$x" "$z" | tail -1)"
      done
    done
    ;;
  one) "$R" "$SO" one "$2" "$3" "$4" ;;
  *) echo "unknown mode $mode" >&2; exit 2 ;;
esac
