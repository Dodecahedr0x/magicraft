#!/usr/bin/env bash
# Fails unless every anchor-lang/anchor-syn/anchor-attribute-*/anchor-derive-* in Cargo.lock is 1.0.1.
set -euo pipefail
cd "$(dirname "$0")/.."
pinned=$(grep -A1 -E '^name = "anchor-(lang|syn|attribute-[a-z-]+|derive-[a-z-]+)"$' Cargo.lock \
  | grep -E '^(name|version) = ' | paste - -)
[ -n "$pinned" ] || { echo "No anchor crates found in Cargo.lock" >&2; exit 1; }
bad=$(echo "$pinned" | grep -v 'version = "1.0.1"$' || true)
if [ -n "$bad" ]; then
  echo "Anchor crates not pinned to 1.0.1:" >&2
  echo "$bad" >&2
  exit 1
fi
echo "OK: $(echo "$pinned" | wc -l | tr -d ' ') anchor crates at 1.0.1"
