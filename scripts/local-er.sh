#!/usr/bin/env bash
# Local MagicBlock stack for tests: base validator + ephemeral validator + VRF oracle.
#
#   scripts/local-er.sh up     # (re)start everything from a fresh ledger
#   scripts/local-er.sh down   # stop everything
#
# Requires `npm i -g @magicblock-labs/ephemeral-validator` (provides
# mb-test-validator, ephemeral-validator, vrf-oracle) and `anchor build` output in
# target/deploy. Logs and ledgers go to .localnet/. See docs/notes/spikes.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/.localnet"
PROGRAM_ID="4GTybm3WD66wUnTgS8UcB9H947uAY7BAqivp8HfbSsW9"
PROGRAM_SO="$ROOT/target/deploy/magicraft.so"
WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
BASE_RPC="http://127.0.0.1:8899"
ER_RPC="http://127.0.0.1:7799"
SERVICES=(base er vrf vrf-er)
ER_VRF_QUEUE="Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT" # DEFAULT_EPHEMERAL_TEST_QUEUE

rpc() { # url method [params-json]
  curl -sf -m 2 -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":${3:-[]}}" "$1"
}

account_exists() { # url pubkey
  rpc "$1" getAccountInfo "[\"$2\",{\"encoding\":\"base64\"}]" | grep -q '"owner"'
}

wait_ready() { # service url check-cmd... ; gives up early if the service died
  for _ in $(seq 1 120); do
    if "${@:3}" >/dev/null 2>&1; then echo "$1 ready at $2"; return 0; fi
    kill -0 "$(cat "$DIR/$1.pid")" 2>/dev/null || break
    sleep 1
  done
  echo "$1 not ready at $2; see $DIR/$1.log" >&2
  return 1
}

start() { # name cmd... ; runs in its own process group so `down` can kill the whole tree
  nohup perl -e 'setpgrp(0, 0); exec @ARGV or die "exec: $!"' "${@:2}" \
    >"$DIR/$1.log" 2>&1 </dev/null &
  echo $! >"$DIR/$1.pid"
}

down() {
  for name in "${SERVICES[@]}"; do
    pidfile="$DIR/$name.pid"
    [[ -f "$pidfile" ]] || continue
    pid="$(cat "$pidfile")"
    kill -TERM -- "-$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 -- "-$pid" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$pid" 2>/dev/null || true
    rm -f "$pidfile"
    echo "stopped $name"
  done
}

up() {
  [[ -f "$PROGRAM_SO" ]] || { echo "missing $PROGRAM_SO; run anchor build" >&2; exit 1; }
  down
  trap 'echo "local-er up failed; stopping (logs stay in $DIR)" >&2; down' ERR
  mkdir -p "$DIR"
  rm -rf "$DIR/test-ledger" "$DIR/er-storage"

  # Base layer: mb-test-validator = solana-test-validator preloaded with the
  # delegation, VRF, session-keys and other MagicBlock programs/accounts. Magicraft
  # is loaded at genesis as an upgradeable program owned by the local wallet.
  # Faucet/gossip/dynamic ports moved off the defaults (9900, 8000-10000) so another
  # local validator (e.g. a second project's stack) can run alongside.
  start base mb-test-validator --reset --ledger "$DIR/test-ledger" \
    --faucet-port 9909 --gossip-port 8100 --dynamic-port-range 8101-8200 \
    --upgradeable-program "$PROGRAM_ID" "$PROGRAM_SO" "$(solana-keygen pubkey "$WALLET")"
  # getHealth can answer before genesis programs are queryable; wait for ours too.
  wait_ready base "$BASE_RPC" account_exists "$BASE_RPC" "$PROGRAM_ID"

  RUST_LOG="${RUST_LOG:-info}" start er ephemeral-validator --no-tui --lifecycle ephemeral --reset \
    --storage "$DIR/er-storage" --listen 127.0.0.1:7799 \
    --remotes "$BASE_RPC" --remotes ws://127.0.0.1:8900
  wait_ready er "$ER_RPC" rpc "$ER_RPC" getSlot

  # VRF oracles (identity paywJ..., preloaded by mb-test-validator). One serves the
  # base-layer queue; the other watches the ER, where the delegated ephemeral queue
  # lives. The ER only lists the queue once it has been cloned, so touch it first.
  VRF_ORACLE_SKIP_PREFLIGHT=true RPC_URL="$BASE_RPC" WEBSOCKET_URL=ws://127.0.0.1:8900 \
    RUST_LOG="${RUST_LOG:-info}" start vrf vrf-oracle
  wait_ready er "$ER_RPC (VRF queue cloned)" account_exists "$ER_RPC" "$ER_VRF_QUEUE"
  VRF_ORACLE_SKIP_PREFLIGHT=true RPC_URL="$ER_RPC" WEBSOCKET_URL=ws://127.0.0.1:7800 \
    RUST_LOG="${RUST_LOG:-info}" start vrf-er vrf-oracle
  sleep 2
  for name in vrf vrf-er; do
    kill -0 "$(cat "$DIR/$name.pid")" 2>/dev/null || { echo "$name exited; see $DIR/$name.log" >&2; exit 1; }
    echo "$name oracle running (log: $DIR/$name.log)"
  done
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
