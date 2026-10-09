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

- **Only `pnpm test` (`scripts/test.sh`) is supported.** It runs `anchor build`,
  `local-er.sh up`, `anchor test --skip-local-validator --skip-build --skip-deploy`,
  and always runs `local-er.sh down` (EXIT trap, including Ctrl-C). A bare
  `anchor test` would start its own plain solana-test-validator without the
  MagicBlock programs and with no ER.
- Magicraft is loaded **at genesis** (upgradeable, authority = local wallet), so a
  running stack keeps the build it was started with. To hot-swap a
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
- Readiness: oracles count as ready when their log shows `Processing queue`
  (the ER oracle must list `Sc9MJ...`). Base waits for the magicraft program account (not just `getHealth`,
  which answers before genesis accounts are queryable). One early run saw the
  ER exit right after "Ready for connections!", most likely because it started
  before the base layer was really ready; not reproduced after this change
  (several consecutive `up`s were clean).

### Endpoints

| Layer | RPC | WS | env override (tests/helpers/env.ts) |
|---|---|---|---|
| Base | http://127.0.0.1:8899 | ws://127.0.0.1:8900 | `PROVIDER_ENDPOINT` (falls back to `ANCHOR_PROVIDER_URL`), `WS_ENDPOINT` |
| ER | http://127.0.0.1:7799 | ws://127.0.0.1:7800 | `EPHEMERAL_PROVIDER_ENDPOINT`, `EPHEMERAL_WS_ENDPOINT` |

`airdrop()` works on the base layer only (the ER has no faucet). ER fee payers
come from cloning or delegation: the ER clones a base account on first use. In
the harness test, the base-funded, non-delegated local wallet paid for an ER
transaction and it executed (it failed only with the expected program error).
Fee/delegation rules for real gameplay accounts still need checking in Task 4.

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

## 2026-10-09: Player sponsor + 16.8 KB ephemeral chunk (Task 3)

Test: `tests/01-spike-chunk.spec.ts`. Spike code: `programs/magicraft/src/instructions/spike.rs`
(`spike_chunk`, `spike_resize`, `spike_fill`; temporary, remove in Task 6). Kept code:
`state.rs` (`Player { authority, bump }`, seeds `["player", authority]`) and
`instructions/player.rs` (`init_player`, `deposit`, `delegate_player`).

### Player: init + fund + delegate in one base tx: works

`init_player` + `deposit(0.05 SOL)` + `delegate_player(mAGicPQ...)` as three ixs in **one**
base-layer tx succeeds. Afterwards the Player's base owner is the delegation program and its lamports
are rent-exempt minimum + deposit. The ER clones it right away (owner = magicraft on the ER).
`delegate_player` uses `#[delegate]` with `#[account(mut, del, seeds, bump)] player: UncheckedAccount`
(the macro rejects typed `Account<>` for `del` fields). `deposit` is a plain system transfer
wallet → PDA, valid only before delegation (it takes `Account<Player>`).

### Ephemeral chunk creation

| Tried | Result |
|---|---|
| `#[ephemeral_accounts]` with eph seeds `[b"chunk", player, cx.to_le_bytes(), cz.to_le_bytes()]` | **Does not compile** (E0425 `cx` not in scope). The macro re-derives the seeds inside the generated `impl Struct { fn create_ephemeral_chunk(&self, ..) }`, where `#[instruction(..)]` args don't exist. It also calls `find_program_address` at runtime for both sponsor and eph. |
| SDK builder directly: `EphemeralAccount::new(player, chunk, vault).with_signer_seeds(&[player_seeds, chunk_seeds]).create(16_896)`, with `vault` (`address = EPHEMERAL_VAULT_ID`) and `magic_program: Program<MagicProgram>` declared by hand | **Fails**: the Magic program logs `Created ephemeral: 16896 bytes, 542592 rent`, then the SVM rejects with `Account data size realloc limited to 10240 in inner instructions` → `InvalidRealloc`. The 10 KiB CPI growth cap (MAX_PERMITTED_DATA_INCREASE) applies even though the Magic program is native. |
| `spike_chunk(len = 10_240)` then `spike_resize(16_896)` as **two ixs in one ER tx** | **Works.** Chunk exists only on the ER: 16 896 bytes, owner magicraft, absent on base. |

Rent: Player lamports on the ER dropped by exactly **542 592** = (16 896 + 60) × 32
(create 10 240 → 329 600, resize +6 656 → 212 992). The fee payer is the authority wallet, so the
Player pays only rent.

CU: create 8 415, resize 8 416 (each including Anchor overhead and an on-chain `find_program_address`
for the chunk bump).

### Writing 16 384 block bytes in one ix (ER, default 200k limit)

Absolute CU varies by ~3 000 between runs: `find_program_address` bump search depends on the
random authority key, so the number of tries changes. Only the deltas between modes within one run
are meaningful.

| Mode | CU consumed (whole ix) |
|---|---|
| no write (baseline: Anchor + 2 PDA checks) | 4 751 |
| `for b in blocks { *b = v }` | 4 823 (LLVM lowers it to memset) |
| `blocks.fill(v)` | 4 824 |
| `copy_from_slice` from a 16 KB `vec!` | 4 920 |
| per-byte computed value (`(i*0x9E3779B1 ^ v) >> 29`) | 119 443 (≈ 7 CU/byte above baseline) |

Bulk copies/fills of the whole block array are nearly free. Anything computed per block costs
about 7 CU per byte at minimum, so terrain generation with real noise will not fit in one 200k ix;
plan for 1.4M or staged generation (`gen_stage`).

### ER compute limits

- Default: 200 000 per ix; the tx budget is 200k × (number of ixs). A 2-ix tx showed `of 400000`
  for the first ix and the remainder for the second.
- `ComputeBudgetProgram.setComputeUnitLimit(1_400_000)` is honoured on the ER: the program sees
  1 399 850 (the ComputeBudget ix itself is charged 150).

### Other findings

- The ER confirms a tx that fails with `InvalidRealloc` only after about **29.5 s**: web3.js
  `confirmTransaction` waits until blockhash expiry. A program-error failure (`Custom(101)`)
  confirms in about 2 ms. `sendEr` still reports the error and logs correctly. If this matters,
  make `sendEr` poll `getSignatureStatuses`.

### Decisions

1. Chunk accounts are created in **two top-level instructions**: create at ≤ 10 240 bytes, then
   `resize` to the full size (they can go in the same tx). Alternatively, make a chunk ≤ 10 240
   bytes.
2. Don't use the generated `create_ephemeral_*` / `resize_ephemeral_*` methods when the eph seeds
   depend on ix args. Call `ephemeral_rollups_sdk::ephemeral_accounts::EphemeralAccount` directly
   with Anchor's bumps (`ctx.bumps.chunk`, `player.bump`), and declare `vault` and `magic_program`
   yourself. This also avoids the macro's extra runtime `find_program_address` calls.
3. Player = sponsor works as `Account<Player>` with `mut, seeds, bump = player.bump, has_one = authority`.

### Open questions

- Top-up path for an already delegated Player: `deposit` needs an undelegated Player. Options are
  commit + undelegate → deposit → re-delegate, or a transfer on the ER side.
- How ER-side lamport changes (rent moved from the Player into the ephemeral vault) settle to base
  on commit/undelegate. Does the base Player balance drop by the rent, and is closing chunks before
  undelegating required to get it back?
