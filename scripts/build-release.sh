#!/usr/bin/env bash
# Release build for devnet/mainnet deploys: plain `anchor build` (no `localnet` feature),
# then verify the IDL's request_seed oracle_queue is the production ER VRF queue.
# `pnpm test` leaves a `localnet` build (test queue) in target/: never deploy that.
set -euo pipefail
cd "$(dirname "$0")/.."

PROD_QUEUE="5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc" # DEFAULT_EPHEMERAL_QUEUE

anchor build "$@"
node -e '
const idl = require("./target/idl/magicraft.json");
const ix = idl.instructions.find((i) => i.name === "request_seed");
const q = ix && ix.accounts.find((a) => a.name === "oracle_queue");
if (!q || q.address !== process.argv[1]) {
  console.error(`oracle_queue is ${q && q.address}, expected ${process.argv[1]}: not a release build`);
  process.exit(1);
}
console.log(`OK: release build, oracle_queue = ${q.address}`);
' "$PROD_QUEUE"
