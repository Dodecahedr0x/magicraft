#!/usr/bin/env bash
# Build, start the local stack, run the TS suite, and always tear the stack down.
set -euo pipefail
cd "$(dirname "$0")/.."

# Base RPC defaults to 8799/8800 (8899 is often taken, e.g. by an SSH tunnel); the ER
# stays on 7799/7800. Override with BASE_PORT (+ PROVIDER_ENDPOINT / WS_ENDPOINT).
export BASE_PORT="${BASE_PORT:-8799}"
export PROVIDER_ENDPOINT="${PROVIDER_ENDPOINT:-http://127.0.0.1:$BASE_PORT}"
export WS_ENDPOINT="${WS_ENDPOINT:-ws://127.0.0.1:$((BASE_PORT + 1))}"

# `localnet`: VRF requests use the local stack's DEFAULT_EPHEMERAL_TEST_QUEUE.
anchor build -- --features localnet
trap 'scripts/local-er.sh down' EXIT
trap 'exit 130' INT TERM # exit via the EXIT trap
scripts/local-er.sh up
anchor test --skip-local-validator --skip-build --skip-deploy "$@"
# The browser client's chain layer against the same stack (app/src/chain/live.test.ts).
# Skip with SKIP_APP_LIVE=1.
if [[ -z "${SKIP_APP_LIVE:-}" ]]; then
  LIVE=1 pnpm -C app exec vitest run src/chain/live.test.ts
fi
