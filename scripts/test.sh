#!/usr/bin/env bash
# Build, start the local stack, run the TS suite, and always tear the stack down.
set -euo pipefail
cd "$(dirname "$0")/.."

anchor build
trap 'scripts/local-er.sh down' EXIT
trap 'exit 130' INT TERM # exit via the EXIT trap
scripts/local-er.sh up
anchor test --skip-local-validator --skip-build --skip-deploy "$@"
