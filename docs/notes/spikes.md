# Spikes and environment findings

## 2026-10-09: Local ephemeral rollup harness (Task 2)

Source: MagicBlock "Local development" guide
(https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/local-development.md)
plus the launcher scripts shipped in the npm package.

### Tooling (macOS arm64, all from one npm package)

`npm i -g @magicblock-labs/ephemeral-validator` (0.14.10) installs:

| Binary | Version | What it is |
|---|---|---|
| `mb-test-validator` | wraps solana-test-validator 4.2.1 | `solana-test-validator` + `--bpf-program`/`--account` for MagicBlock programs, loaded from `.so`/`.json` dumps bundled in the package (`bin/local-dumps/`). Extra args pass through. |
| `ephemeral-validator` | 0.14.10 (git ee62453) | The ER validator (darwin-arm64 binary in an optional dep). |
| `vrf-oracle` | 0.4.1 | Local VRF oracle (darwin-arm64 binary). |
| `mb-stack` | 0.14.10 | All-in-one supervisor (base + ER + query-filtering-service on 6699). Not used: it runs in the foreground, has no oracle, and uses default ports. |

No devnet cloning is needed: the package bundles the program dumps, so the
harness works offline.

### What `scripts/local-er.sh up` runs

```bash
mb-test-validator --reset --ledger .localnet/test-ledger \
  --faucet-port 9909 --gossip-port 8100 --dynamic-port-range 8101-8200 \
  --upgradeable-program 4GTybm3WD66wUnTgS8UcB9H947uAY7BAqivp8HfbSsW9 target/deploy/magicraft.so <wallet pubkey>
RUST_LOG=info ephemeral-validator --no-tui --lifecycle ephemeral --reset \
  --storage .localnet/er-storage --listen 127.0.0.1:7799 \
  --remotes http://127.0.0.1:8899 --remotes ws://127.0.0.1:8900
VRF_ORACLE_SKIP_PREFLIGHT=true RPC_URL=http://127.0.0.1:8899 WEBSOCKET_URL=ws://127.0.0.1:8900 vrf-oracle   # base queue
VRF_ORACLE_SKIP_PREFLIGHT=true RPC_URL=http://127.0.0.1:7799 WEBSOCKET_URL=ws://127.0.0.1:7800 vrf-oracle   # ER queue
```

- Magicraft is loaded **at genesis** (upgradeable, authority = local wallet), so
  tests run with `anchor test --skip-local-validator --skip-build --skip-deploy`.
  Rebuild before `up` (`pnpm test` does `anchor build` first). To hot-swap a
  build into a running stack, `anchor deploy` also works because the wallet is
  the upgrade authority.
- Every `up` resets both ledgers. `down` kills each service's process group.
  Logs: `.localnet/{base,er,vrf,vrf-er}.log` (base validator's detailed log is
  `.localnet/test-ledger/validator.log`).
- The docs' older ER flags (`--remote-url`, `--rpc-port`) no longer exist in 0.14.10;
  use `--remotes` (repeatable, http + ws) and `--listen`/`-l`. `--no-tui` is
  required when stdout is not a TTY.
- Non-default faucet/gossip/dynamic ports: another project's MagicBlock stack
  (RPC 9199, ER 9299) was running on this machine and holding 9900 and
  8000-8018. ER metrics on 9000 also collided; that is only a logged error
  (`--metrics` takes a config struct, not an address, so it was left alone).
- Readiness: base waits for the magicraft program account (not just `getHealth`,
  which answers before genesis accounts are queryable). One early run saw the
  ER exit right after "Ready for connections!", most likely because it started
  before the base layer was really ready; not reproduced after this change
  (several consecutive `up`s were clean).

### Endpoints

| Layer | RPC | WS | env override (tests/helpers/env.ts) |
|---|---|---|---|
| Base | http://127.0.0.1:8899 | ws://127.0.0.1:8900 | `PROVIDER_ENDPOINT` (falls back to `ANCHOR_PROVIDER_URL`), `WS_ENDPOINT` |
| ER | http://127.0.0.1:7799 | ws://127.0.0.1:7800 | `EPHEMERAL_PROVIDER_ENDPOINT`, `EPHEMERAL_WS_ENDPOINT` |

Local ER validator identity: `mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev`
(pass this as the validator when delegating locally).

### Programs available locally (checked with `solana account`)

| Program | Base (8899) | ER (7799) |
|---|---|---|
| magicraft `4GTy...SsW9` | yes (genesis) | yes (cloned on demand) |
| Delegation `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` | yes | yes |
| VRF `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz` | yes | yes |
| gpl_session `KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5` | yes | yes |
| Magic program `Magic11111111111111111111111111111111111111` | no (ER only) | yes (native) |
| Also bundled: noop, ACL/permission `ACLseo...`, `SPLxh1...`, `Enhkom...`, `DmnRGf...` | yes | n/a |

### VRF (input for Tasks 4-5)

- Oracle identity `paywJiVATrVDLYLmowJqzG6MsaCt77L8WyTnBb2754t` is preloaded
  (funded) by mb-test-validator; no keypair setup needed.
- `DEFAULT_EPHEMERAL_TEST_QUEUE` `Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT` is
  preloaded **already delegated** (base owner = delegation program; ER owner =
  VRF program). The base-layer queue is `GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb`.
- The docs only start one oracle against the base layer, and that oracle never
  sees the ephemeral queue. An oracle pointed at the ER lists `Sc9MJ...` only
  after the ER has cloned it, so the script fetches the account on the ER first,
  then starts a second oracle on 7799/7800. Its log shows
  `Processing queue: Sc9MJ...`.
- **Not yet verified:** a VRF request made inside the ER being fulfilled end to
  end (the callback landing). Task 4/5 must test this first. If it fails, check
  `.localnet/vrf-er.log`, and check whether the oracle needs funds on the ER.
  The docs' sample uses `WEBSOCKET_URL=ws://localhost:8999`, which looks like a
  typo; the base WS is 8900.

### Session keys

The gpl_session program is executable on both layers. Creating a session token
locally has not been exercised yet (Task 4/5).

### Node 25 + ts-mocha

Node 25 strips TS types natively and loaded the `.spec.ts` files itself
(bypassing ts-node/tsconfig, with a `MODULE_TYPELESS_PACKAGE_JSON` warning).
The Anchor.toml test script sets `NODE_OPTIONS=--no-experimental-strip-types`
so ts-mocha's ts-node path is used.
