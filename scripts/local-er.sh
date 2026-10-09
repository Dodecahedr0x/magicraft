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
# Faucet/gossip/dynamic ports are moved off the solana-test-validator defaults
# (9900, 8000-10000) so another local validator (e.g. a second project's stack) can
# run alongside.
# BASE_PORT / BASE_WS_PORT default to 8799/8800 (8899 is often taken, e.g. by an SSH
# tunnel); tests/helpers/env.ts defaults to the same, PROVIDER_ENDPOINT / WS_ENDPOINT override.
BASE_PORT="${BASE_PORT:-8799}" BASE_WS_PORT="${BASE_WS_PORT:-$((BASE_PORT + 1))}"
ER_PORT=7799 ER_WS_PORT=7800
FAUCET_PORT=9909 GOSSIP_PORT=8100 DYNAMIC_PORTS=8101-8200
BASE_RPC="http://127.0.0.1:$BASE_PORT" BASE_WS="ws://127.0.0.1:$BASE_WS_PORT"
ER_RPC="http://127.0.0.1:$ER_PORT" ER_WS="ws://127.0.0.1:$ER_WS_PORT"
SERVICES=(base er vrf vrf-er)
ER_VRF_QUEUE="Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT" # DEFAULT_EPHEMERAL_TEST_QUEUE

rpc() { # url method [params-json]
  curl -sf -m 2 -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":${3:-[]}}" "$1"
}

slot_at_least() { # url slot
  local s
  s="$(rpc "$1" getSlot | grep -o '"result":[0-9]*' | cut -d: -f2)"
  [[ -n "$s" && "$s" -ge "$2" ]]
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
  [[ -f "$PROGRAM_SO" ]] || { echo "missing $PROGRAM_SO; run anchor build" >&2; return 1; }
  down
  trap 'echo "local-er up failed; stopping (logs stay in $DIR)" >&2; down' ERR
  mkdir -p "$DIR"
  rm -rf "$DIR/test-ledger" "$DIR/er-storage"

  # Base layer: mb-test-validator = solana-test-validator preloaded with the
  # delegation, VRF, session-keys and other MagicBlock programs/accounts. Magicraft
  # is loaded at genesis as an upgradeable program owned by the local wallet.
  start base mb-test-validator --reset --ledger "$DIR/test-ledger" --rpc-port "$BASE_PORT" \
    --faucet-port "$FAUCET_PORT" --gossip-port "$GOSSIP_PORT" --dynamic-port-range "$DYNAMIC_PORTS" \
    --upgradeable-program "$PROGRAM_ID" "$PROGRAM_SO" "$(solana-keygen pubkey "$WALLET")"
  # getHealth can answer before genesis programs are queryable; wait for ours too.
  wait_ready base "$BASE_RPC" account_exists "$BASE_RPC" "$PROGRAM_ID"
  # Starting the ER in the first base slots fails its fee-vault setup tx with
  # "Unsupported program id" ("Magic fee vault setup failed"; deterministic on a loaded
  # machine), so give the base a few slots first.
  wait_ready base "$BASE_RPC (slot >= 20)" slot_at_least "$BASE_RPC" 20

  RUST_LOG="${RUST_LOG:-info}" start er ephemeral-validator --no-tui --lifecycle ephemeral --reset \
    --storage "$DIR/er-storage" --listen "127.0.0.1:$ER_PORT" \
    --remotes "$BASE_RPC" --remotes "$BASE_WS"
  wait_ready er "$ER_RPC" rpc "$ER_RPC" getSlot

  # VRF oracles (identity paywJ..., preloaded by mb-test-validator). One serves the
  # base-layer queue; the other watches the ER, where the delegated ephemeral queue
  # lives. The ER only lists the queue once it has been cloned, so touch it first.
  VRF_ORACLE_SKIP_PREFLIGHT=true RPC_URL="$BASE_RPC" WEBSOCKET_URL="$BASE_WS" \
    RUST_LOG="${RUST_LOG:-info}" start vrf vrf-oracle
  wait_ready er "$ER_RPC (VRF queue cloned)" account_exists "$ER_RPC" "$ER_VRF_QUEUE"
  VRF_ORACLE_SKIP_PREFLIGHT=true RPC_URL="$ER_RPC" WEBSOCKET_URL="$ER_WS" \
    RUST_LOG="${RUST_LOG:-info}" start vrf-er vrf-oracle
  wait_ready vrf "$BASE_RPC (oracle)" grep -q "Processing queue" "$DIR/vrf.log"
  wait_ready vrf-er "$ER_RPC (oracle)" grep -q "Processing queue: $ER_VRF_QUEUE" "$DIR/vrf-er.log"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
