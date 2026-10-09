# Spikes and environment findings

> **2026-10-09, Task 6:** the spike instructions (`spike.rs`) and spike tests (`01-04-spike-*`) were
> removed; they remain in git history (last at commit `965c661`). `tests/helpers/spike.ts` became
> `tests/helpers/player.ts` (no chunk setup). Decisions below are folded into the design doc and
> implementation plan.

## 2026-10-09: Local ephemeral rollup harness (Task 2)

> **Task 16 update:** the base layer now defaults to **8799/8800** (`BASE_PORT` in
> `scripts/local-er.sh`, exported by `scripts/test.sh` together with `PROVIDER_ENDPOINT` /
> `WS_ENDPOINT`; `tests/helpers/env.ts` defaults to the same), because 8899 is often taken (e.g. by
> an SSH tunnel). Plain `pnpm test` needs no env vars. `scripts/test.sh` builds with
> `anchor build -- --features localnet`, which points `request_seed`'s `oracle_queue` constraint
> (and the IDL address) at `DEFAULT_EPHEMERAL_TEST_QUEUE`; a plain `anchor build` targets
> `DEFAULT_EPHEMERAL_QUEUE` and its VRF requests fail locally with `ConstraintAddress`.

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
| Base | http://127.0.0.1:8799 (8899 before Task 16) | ws://127.0.0.1:8800 | `PROVIDER_ENDPOINT` (falls back to `ANCHOR_PROVIDER_URL`), `WS_ENDPOINT` |
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
- **Verified in Task 5 (see below):** a VRF request made inside the ER is fulfilled end to
  end in ~110 ms. Original note: Task 4/5 must test this first. If it fails, check
  `.localnet/vrf-er.log`, and check whether the oracle needs funds on the ER.
  The docs' sample uses `WEBSOCKET_URL=ws://localhost:8999`, which looks like a
  typo; the base WS is 8900.

### Session keys

The gpl_session program is executable on both layers. Session tokens are exercised
end to end in Task 5 (see below).

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

### Open questions (answered in Task 4 below)

- Top-up path for an already delegated Player: `deposit` needs an undelegated Player. Options are
  commit + undelegate → deposit → re-delegate, or a transfer on the ER side.
- How ER-side lamport changes (rent moved from the Player into the ephemeral vault) settle to base
  on commit/undelegate. Does the base Player balance drop by the rent, and is closing chunks before
  undelegating required to get it back?

## 2026-10-09: Cranks on ephemeral accounts + Player economics (Task 4)

Tests: `tests/02-spike-crank.spec.ts`, `tests/03-spike-economics.spec.ts` (shared setup in
`tests/helpers/spike.ts`). Temporary ixs in `instructions/spike.rs` (remove in Task 6):
`spike_tick`, `spike_schedule(cx, cz, task_id, interval_ms, iterations)`, `spike_cancel(task_id)`,
`spike_commit(undelegate)`, `spike_close(cx, cz)`. `sendEr` now polls `getSignatureStatuses`, so the
InvalidRealloc failure from Task 3 is reported in milliseconds instead of ~30 s.

Sources: docs pages `tools/crank/{introduction,implementation}.md`,
`ephemeral-rollups-ers/introduction/fees-and-commit-economics.md`, quickstart "Top-up delegated
account"; crates `magicblock-magic-program-api 0.14.10` (`instruction.rs`, `args.rs`, `pda.rs`),
`ephemeral-rollups-sdk 0.17.3` (`crank/`); validator source at tag `v0.14.10`
(`programs/magicblock/src/schedule_task/*`, `magicblock-task-scheduler/src/{service,db}.rs`,
`magicblock-config/src/config/scheduler.rs`).

### API (what we call)

- `magicblock_magic_program_api::instruction::MagicBlockInstruction::ScheduleTask(
  magicblock_magic_program_api::args::ScheduleTaskArgs { task_id: i64, execution_interval_millis: i64,
  iterations: i64, instructions: Vec<Instruction> })`, bincode-serialized, CPI to `MAGIC_PROGRAM_ID`.
  Accounts: `[payer (writable, signer), ...accounts the task uses]`. In 0.14.10 only account 0 is read
  (the api doc comment's "task context account" is stale; the validator never looks at it).
- `MagicBlockInstruction::CancelTask { task_id }`, accounts `[task authority (signer)]`.
- The `Instruction` in `ScheduleTaskArgs` is the solana-program 3.x type and is identical to
  `anchor_lang::solana_program::instruction::Instruction`; no conversion needed. We use the 0.14
  api crate directly and did **not** enable the SDK's `crank` feature: it brings `hydra-api`
  (the SDK marks the Magic-program `ScheduleCrankCpi`/`CancelCrankCpi` deprecated in favour of
  `crank::hydra::*`), but the Hydra program (`Hydra17i1...`) is not in the local stack's dumps, so
  it cannot be tested locally. The Magic-program path works on ER 0.14.10. **Re-check Hydra before
  devnet/mainnet.**

### Findings (evidence: `02-spike-crank.spec.ts`)

| Question | Answer |
|---|---|
| Can a crank target an ix on an **ephemeral** account? (tested) | **Yes.** `spike_tick` on the 16 896-byte ephemeral chunk: 100 ms × 10 → counter = 10 after ~915 ms, still 10 one second later. |
| Can the payer be a PDA? (tested; signer check from source) | **Yes.** The delegated Player PDA signs the ScheduleTask/CancelTask CPI via `invoke_signed` with its seeds. The validator only checks that account 0 is a signer. The PDA becomes the task **authority** (only it can cancel/replace). |
| Who pays, how much? (tested: deltas; fee-payer identity from source) | **Nobody, currently.** Player and wallet ER lamport deltas are 0 for scheduling and for all 10 executions. The scheduler sends each execution as a tx **signed and fee-paid by the validator identity** (`ExecuteCrank` + noop), and ER txs cost 0 in this release. No crank price is in the fee docs. |
| Signers inside a cranked ix (source) | Only the crank-signer PDA `find_program_address(["crank-executor", authority], Crank1111...)` may be marked signer (and not writable); the validator authority may not appear. So tick ixs must be **permissionless** or verify that crank PDA as signer. |
| `task_id` scope (tested) | **Global per validator** (SQLite primary key, not per payer). Another authority scheduling the same live id: the tx **succeeds** (`Scheduled task request` is logged in-tx), but the service rejects it later (`UnauthorizedReplacing`, ER log only). Its cancel is ignored too (`Task authority ... does not match`). Test: A's replacement never ran (0 ticks); B kept ticking (10 per second). **Derive ids that cannot collide** (e.g. from a hash of the chunk PDA) and never trust that a schedule tx means the task exists. |
| Re-schedule with the same id, same authority (tested) | **Replaces** the task (`INSERT OR REPLACE`; iterations/interval/ixs reset, queue entry replaced). 100 ms × 1000 then rescheduled × 2 → exactly 2 more ticks. This is the "reschedule" primitive for chunk ticks. |
| Cancel (tested; unknown-id no-op from source) | Works: 100 ms × 1000, cancel after 500 ms → 0 further ticks. Cancelling an unknown id is a silent no-op. |
| Target ix fails (tested; backoff constants from source + debug log; the 35 s drop test runs only with `SLOW_TESTS=1`) | The ER RPC rejects the crank tx (`-32003 transaction verification error`; the failed attempts are still recorded: 5 failed sigs on the chunk in 3 s). The scheduler **retries without consuming an iteration**, with backoff 100, 200, 400 … ms capped at 5 s. If the ix works again within the window the task resumes and **catches up** missed ticks (fixed-rate cadence: 90 ticks in 6 s after a 3 s outage at 100 ms). After 10 retries (~26 s of continuous failure) the task is **dropped** (moved to `failed_tasks`): 0 ticks after a 35 s outage even once the ix worked again. Retries/drops are only visible at `RUST_LOG=magicblock_task_scheduler=debug`. |
| Limits (source) | `iterations >= 1` (i64, no max); `0 < interval < u32::MAX` ms, then clamped up to the validator's `[task-scheduler] min-interval` (default **10 ms**); `instructions` non-empty; privileged Magic ixs rejected. Tasks persist in SQLite across validator restarts. |
| CU (tested) | `spike_schedule` (1 tick ix) 12.6k CU incl. Anchor + bincode; `spike_cancel` 4.5k. |

Design consequences: tick handlers take no user signer (or check the crank PDA of World/Player);
store the task id in the chunk/world account; on neighbour appearance just call ScheduleTask
again with the same id (replace), no cancel needed; long-running ticks need to tolerate (or avoid)
failure, because ~26 s of failures kills the task silently; a watchdog (e.g. the world day crank
or the client) should re-schedule ticks whose `last_tick` stalls.

### Economics (evidence: `03-spike-economics.spec.ts`; Player delegated with 0.05 SOL)

**Settlement is delta-based.** A commit applies the Player's ER-side lamport change *since the
last sync* (delegation or previous commit) to its base balance; it does not overwrite base with the
ER balance.

| Step | ER Player | base Player |
|---|---|---|
| delegated | 51 621 680 | 51 621 680 |
| (ii) plain base `SystemProgram.transfer` 0.01 SOL to the delegated PDA | unchanged (ER never sees it) | +10 000 000 |
| (iii) `lamportsDelegatedTransferIx` 0.02 SOL (one **base** tx) | +20 000 000 after 50-100 ms | unchanged |
| create 2 chunks (rent → ephemeral vault) | −1 085 184 (2 × 542 592) | unchanged |
| `commit` | 70 536 496 | 61 621 680 → 80 536 496 (Δ = ER Δ = +18 914 816; the top-up's lamports PDA on base 20 890 880 → 0) |
| close chunk 0 (refund), then `commit_and_undelegate` | +542 592 | +542 592; owner = magicraft again |
| chunk 1 (still open) after undelegation | stays on the ER (16 896 B, 0 lamports); `spike_close` fails `InvalidWritableAccount` (sponsor not delegated) | — |
| (i) `deposit` 0.01 + `delegate_player` (one base tx) | re-cloned with the base balance | +10 000 000 |
| close the stranded chunk 1 | +542 592 | (settles on next commit) |

Answers:

- **(b) Settlement:** yes, the base balance drops by the rent spent on the ER, at the first
  commit (not only at undelegation). Closing a chunk refunds the rent on the ER and the next commit
  carries the refund to base. An open chunk **survives** its sponsor's undelegation, and its rent is
  stranded until the Player is delegated again (then closing works and refunds). So: close (or
  account for) chunks before undelegating a Player, or re-delegate to reclaim. Note base also keeps
  lamports that only exist on base (the plain transfer was not overwritten).
- **(a)(ii) Plain base transfer to the delegated PDA:** allowed and kept on base across commits,
  but the ER never sees it, so it cannot fund ER rent. **Not a top-up path.**
- **(a)(i) Undelegate → deposit → re-delegate:** works (deposit + delegate in one base tx; the
  ER showed the new balance at the first poll after the base tx confirmed; logged as "ER re-cloned the Player after N ms"). Costs a commit+undelegate round trip, a new
  delegation session (3 000 000-lamport session charge per the fee docs, taken from the delegation
  deposit at undelegation), and the Player is unusable on the ER meanwhile.
- **(a)(iii) `lamportsDelegatedTransferIx`** (`@magicblock-labs/ephemeral-rollups-sdk`, e-SPL
  program `SPLxh1...`): one base tx signed by any wallet; the ER credits the delegated Player in
  ~50-100 ms with **no undelegation**. Cost to the wallet: amount + 300 000 setup charge + base tx
  fee (5 000). It needs a fresh 32-byte salt per call. The e-SPL global rent PDA (`4RvdEG...`,
  seeds `["rent"]`) sponsors the single-use lamports PDA's delegation (its balance fell by a net
  6 764 400 lamports for one top-up locally). It is pre-funded on MagicBlock clusters; locally the test funds it with 1 SOL. On commit,
  the Player's base balance moves by its ER delta (see the accounting below).

**Base-layer accounting of one 0.02 SOL top-up** (tx lamport deltas logged by the test):

| Tx | Deltas |
|---|---|
| top-up (wallet-signed) | wallet −20 305 000 (incl. 5 000 fee); e-SPL rent PDA −6 764 400; lamports PDA +20 890 880; its delegation record +4 078 560, metadata +2 094 960 (sum = −5 000) |
| Player commit (validator-signed) | validator identity −19 039 816; Player +18 914 816 (= +20 000 000 top-up − 1 085 184 rent): **the validator fronts the Player's ER delta** |
| lamports PDA undelegation (validator-signed) | lamports PDA −20 890 880, record −4 078 560, metadata −2 094 960 → e-SPL rent PDA +6 764 400 (made whole), `EpJnX7…` +20 270 000, `7Jrkjm…` +30 000, validator identity −415 000 (fees) |

So the 1 976 064 lamports of the lamports PDA that did not reach the Player (20 890 880 −
18 914 816) are its 890 880 rent-exempt balance (back to the rent PDA) plus the 1 085 184 of
chunk rent spent on the ER. The top-up's 20 000 000 and 270 000 of the 300 000 setup charge go to
`EpJnX7…`, and 30 000 to `7Jrkjm…`. That 90/10 split matches the fee docs' validator / protocol fee
vaults, so `EpJnX7…` is most likely the validator fee vault, which reimburses the validator for
fronting the Player's delta. Rent spent on the ER therefore ends up with the validator side on base.

**Recommendation: (iii) `lamportsDelegatedTransferIx`** as the top-up path (cheapest, no
downtime, works for a delegated PDA, any wallet can pay). Keep `deposit` for the initial funding in
the init+delegate tx. Re-check that the global rent PDA is funded on the target cluster.

### Other notes

- `magicblock-magic-program-api` (0.14) and `bincode` stay as direct dependencies: the real
  chunk-tick and day cranks build `ScheduleTask`/`CancelTask` the same way as `spike_schedule`.
- The ~41 s "dropped after 10 retries" test is skipped unless `SLOW_TESTS=1` (`SLOW_TESTS=1 pnpm test`).
- A commit with only rent spent (no top-up) lowers the base Player by exactly the rent (tested).

- `commit` needs no extra account besides `magic_context`/`magic_program` (SDK
  `ephem::commit_accounts` / `commit_and_undelegate_accounts`, re-exported from the deprecated v0
  module; the newer API is `MagicIntentBundleBuilder`). The first commit to land on base took about
  8 s in one run and < 0.5 s in the next.
- Absolute CU in `01-spike-chunk` was ~3k higher in this run (no-op fill baseline 7.9k vs 4.8k,
  per-byte hash 122.6k vs 119.4k). That matches the run-to-run bump-search variance noted in
  Task 3; deltas between modes are unchanged.

## 2026-10-09: VRF inside the ER + session keys on the ER (Task 5)

Test: `tests/04-spike-vrf-session.spec.ts` (12 tests, all passing in `pnpm test`). Temporary ixs in
`instructions/spike.rs` (remove in Task 6): `spike_vrf(cx, cz, caller_seed, payer_mode)`,
`spike_vrf_callback(randomness)`, `spike_session_ping(cx, cz)`. Spike chunk layout: bytes 0..8 tick
counter (Task 4), 8..16 session ping counter, 16..48 VRF output.

Sources: docs pages `verifiable-randomness-functions-vrfs/how-to-guide/quickstart.md`,
`.../introduction/technical-details.md`, `tools/session-keys/{integrating-sessions-in-your-program,
how-do-session-keys-work,security}.md`, `ephemeral-rollups-ers/introduction/fees-and-commit-economics.md`;
crates `ephemeral-vrf-sdk 0.17.3` (+ `ephemeral-vrf-sdk-vrf-macro`), `session-keys 3.1.1`
(+ macros); GitHub `magicblock-labs/magicblock-engine-examples` (`roll-dice/anchor/programs/roll-dice-delegated`,
`session-keys/anchor`) and `magicblock-labs/ephemeral-vrf` (main, 2026-09-18:
`program/src/{request_randomness,fees}.rs`, `vrf-oracle/src/oracle/processor.rs`, `api/src/error.rs`).

### VRF API as used (0.17.3)

- Request accounts struct: `#[vrf]` above `#[derive(Accounts)]`; it must have an `oracle_queue` field and
  injects `program_identity` (`["identity"]` PDA of our program), `vrf_program`, `slot_hashes`,
  `system_program`, plus a generated `invoke_signed_vrf(&payer, &ix)`.
- Builder: `ephemeral_rollups_sdk::vrf::instructions::create_request_randomness_ix(RequestRandomnessParams { payer,
  oracle_queue, callback_program_id: crate::ID, callback_discriminator: instruction::X::DISCRIMINATOR.to_vec(),
  caller_seed, accounts_metas: Some(vec![chunk writable]), .. })`. In 0.17.3 this **is** the scoped request
  (discriminator 10); `create_request_scoped_randomness_ix`, used by the current examples repo, does not
  exist in 0.17.3. `invoke_signed_vrf` also rewrites any legacy discriminator to the scoped one.
- Callback: `#[vrf_callback]` above `#[derive(Accounts)]` injects
  `#[account(address = scoped_vrf_identity(&crate::ID))] vrf_program_identity: Signer` as the **first**
  account; then the `accounts_metas` follow. The handler gets `randomness: [u8; 32]` as its first arg
  (then any `callback_args` bytes).

### VRF findings (evidence: `04-spike-vrf-session.spec.ts` + ER tx inspection)

| Question | Answer |
|---|---|
| Does an ER request on `DEFAULT_EPHEMERAL_TEST_QUEUE` get fulfilled locally? (tested) | **Yes.** Callback landed **~110 ms** after the request (3 runs: 109-113 ms; one PDA-payer run 208 ms). No script changes were needed: the second oracle (`vrf-er`, RPC 7799/WS 7800) fulfils it. The earlier "no callback observed" was just never having sent a request. |
| Does the callback reach an **ephemeral** account? (tested) | **Yes.** 32 non-zero bytes appear at chunk[16..48] of the 16 896-byte ephemeral chunk. |
| Must the payer be a wallet, or can the delegated Player PDA pay? (tested on ER; base path from source) | **On the local ER test queue the Player PDA works** (tested) (`payer_mode 1`: manual `invoke_signed` with the identity seeds **and** the Player seeds; `invoke_signed_vrf` itself only signs with the identity seed, so it cannot be used for a PDA payer). The VRF program only checks `payer.is_signer()`; ephemeral queues (`DEFAULT_EPHEMERAL_QUEUE`, and the test queue in builds with the `ephemeral-test-queue` feature) are **fee-exempt** (`fees.rs::is_fee_exempt_ephemeral_queue`). **The production `DEFAULT_EPHEMERAL_QUEUE` exemption is source-only** (repo main, not the deployed devnet/mainnet binary): re-check on devnet before relying on a PDA payer; if the deployed program charges the fee there, the PDA cannot pay. Lamport deltas on the ER: wallet 0, Player 0, for both modes. **On a base-layer queue** the program `system_instruction::transfer`s 500 000 lamports (800 000 high priority) from the payer to the queue, which needs a system-owned, data-less payer: a Player PDA (program-owned, with data) could not pay there. |
| Who pays the fulfilment? (tested) | The oracle identity `paywJ…` is the fee payer of the fulfil tx; ER fee 0. It sets a compute limit of 300 000 (regular) / 400 000 (high priority); the callback CPI saw **~262k CU available** (`consumed 3826 of 261651`), the VRF program itself used ~42k in total. **Do not generate terrain in the callback**; store the seed only. |
| CU of the request (tested) | `spike_vrf` 34.5k CU total (VRF program 11.8k); the rest is Anchor + PDA bump searches (`#[vrf]`'s `program_identity` seeds, `invoke_signed_vrf`'s runtime `try_find_program_address`). |
| Forged callback (tested) | Calling `spike_vrf_callback` with a random keypair as `vrf_program_identity` (signed) → `ConstraintAddress` (2012). |
| Local queue noise (observed) | The dumped test queue `Sc9MJ…` arrives with ~53 stale devnet requests (e.g. callback program `AMwxv…`, not deployed locally). The ER oracle retries them and they fail with VRF error 13 (`OracleMustProvideInDifferentSlot`); ~1 000 failed oracle txs on the queue in the first ~270 slots, then it stopped. Harmless locally (fee 0), but don't use `getSignaturesForAddress(queue)` to find our fulfilment. |

Design implication: the World seed request can be made inside the ER with the **Player PDA (or World
PDA) as payer** (tested locally; devnet fee exemption still to confirm), the callback writes the seed into the ephemeral World account in ~100 ms. No base-layer
fallback needed. A base-layer request would need a wallet payer and costs 0.0005 SOL.

### Session keys API as used

- `session_keys::{session_auth_or, Session, SessionError, SessionTokenV2}`; `#[derive(Accounts, Session)]`,
  `#[session(signer = signer, authority = player.authority.key())] session_token: Option<Account<'info, SessionTokenV2>>`,
  `#[session_auth_or(ctx.accounts.player.authority == ctx.accounts.signer.key(), SpikeError::NotPlayerAuthority)]`.
  The macro pastes the expression into the handler body, so it must go through `ctx.accounts.…`
  (`player.authority…` alone does not compile), and `SessionError` must be imported (the macro uses
  it unqualified for `InvalidToken`).
- **V2 tokens** (`SessionTokenV2`, seeds `["session_token_v2", target_program, session_signer, authority]`).
  The derive picks V1/V2 from the field type. We use V2 because the current MagicBlock example does, its
  rent goes back to the recorded `fee_payer`, and `revoke_session_v2` needs the authority's signature
  while the token is still active (**V1 `revoke_session` is callable by anyone**). Both are in the
  local gpl_session dump.
- Validity: `valid_until` (i64 unix seconds) can be anything up to now + 7 days (`ValidityTooLong`);
  past values are accepted at creation. Default (None) is now + 1 h. Checked against the **ER's**
  `Clock` when the ix runs on the ER.
- Error numbers: `SessionError` is compiled into our program with the default offset (6000
  `ValidityTooLong`, 6001 `InvalidToken`, 6002 `NoToken`, 6003 `InvalidAuthority`), so our own
  `#[error_code]` now uses `offset = 6100` (`ForcedFailure` 6100, `NotPlayerAuthority` 6101). Anchor 1.0's
  IDL build allows only **one** `#[error_code]` enum per program ("Multiple error definitions are not
  allowed"), and SessionError is not in our IDL; clients must map 6000-6003 themselves.
- JS client: **no npm dependency added.** `@magicblock-labs/gum-sdk` 3.0.10 pulls `@coral-xyz/anchor`
  0.30 (we use `@anchor-lang/core` 1.0), axios and graphql. The two gpl_session ixs are hand-built in
  the test (`createSessionIx`, `revokeSessionIx`: Anchor discriminator `sha256("global:<name>")[..8]`
  + borsh `Option<bool>`, `Option<i64>`, `Option<u64>`). Account order for `create_session_v2`:
  token (w), session_signer (w, s), fee_payer (w, s), authority (s), target_program, system_program.

### Session findings (evidence: `04-spike-vrf-session.spec.ts`)

| Question | Answer |
|---|---|
| Session key signs a gameplay ix on the ER (tested) | **PASS.** Token created on base (wallet = authority + fee payer, top-up 0.01 SOL, 1 h), session key signs `spike_session_ping` on the ER as signer **and** fee payer; ping counter in the ephemeral chunk increments. |
| Wallet signs without a token (tested) | **PASS** (fallback expression). |
| Random keypair, no token (tested) | Rejected: `NotPlayerAuthority` (6101). |
| Random keypair presenting the real token (tested) | Rejected: `InvalidToken` (6001) (token PDA does not match the signer). |
| Expired token (tested) | Rejected: `InvalidToken` (6001), both for `valid_until` = now − 60 at creation and for a 4 s token that worked once and failed ~2 s later on the ER (`valid_until` was taken from base `getBlockTime`, which lagged wall clock by ~1 s). |
| Is the SessionToken (owned by gpl_session, created on base) cloned into the ER? (tested) | **Yes, on demand**, both when first referenced by an ER tx and on `getAccountInfo`. ER copy: owner gpl_session, 144 B, identical data. It is a non-delegated clone, so read-only on the ER (Task 2 rule; not separately tested). |
| Are base changes to the token followed? (tested) | **Yes.** After `revoke_session_v2` confirmed on base, the very first ER ping (5 ms later) failed with `AccountNotInitialized`: the ER had already dropped the clone. |
| Must the session signer have lamports on the ER / does the ER charge fees? (tested; fee docs) | **No.** A session key created without top-up (0 lamports, account does not exist on base) was the sole signer and fee payer on the ER and the tx succeeded. A topped-up signer's ER balance is unchanged after txs. Fee docs: "Normal ER transactions cost `0` in the current release". The 0.01 SOL top-up is only needed for base-layer txs signed by the session key; **plan for no top-up** (or a small one) and re-check if ER fees are introduced. |
| Can tokens be created/revoked while the Player is delegated? (tested) | **Yes.** Tokens do not reference the Player at all (seeds: program, session signer, wallet), so they are plain base-layer txs at any time; all tokens in the test were created and one revoked while the Player was delegated. |

### Decisions

1. World seed: request VRF inside the ER on `DEFAULT_EPHEMERAL_QUEUE` (local: `DEFAULT_EPHEMERAL_TEST_QUEUE`), payer =
   a delegated PDA via `invoke_signed` with both seed sets; callback (`#[vrf_callback]`) only copies the 32
   bytes into the World account. Constrain `oracle_queue` to the queue constant in the real ix.
2. Gameplay auth: `SessionTokenV2` + `#[session_auth_or]`; the client creates the token on base right after
   (or in the same tx as) Player init/delegation, with `top_up` off or small, and signs ER txs with the session key
   as fee payer.
3. Program errors start at 6100 (`#[error_code(offset = 6100)]`) to stay clear of SessionError.

### Carry over to permanent code (Task 6+)

- **VRF request with a PDA payer:** don't use `invoke_signed_vrf` (it signs with the identity seed only).
  Call `invoke_signed` yourself with account infos in this exact order: `[payer PDA, program_identity,
  oracle_queue, system_program, slot_hashes]`, and **both** seed sets: `["identity", bump]` and the payer
  PDA's seeds + bump. Build the ix with `create_request_randomness_ix` (the scoped request in 0.17.3);
  never the deprecated legacy builders, since `#[vrf_callback]` only accepts the scoped identity and
  the manual path does not get `invoke_signed_vrf`'s discriminator rewrite.
- **Callback target:** a typed, seed-constrained World account (`Account<World>` with `seeds`/`bump`), not
  an `UncheckedAccount` with an owner check, plus a guard that the seed is still unset
  (`require!(!world.seed_set)`), so a second fulfilment cannot re-roll the world.
- **Constrain `oracle_queue`** with `address = DEFAULT_EPHEMERAL_QUEUE` (cfg/feature switch to
  `DEFAULT_EPHEMERAL_TEST_QUEUE` for localnet) instead of accepting any queue as the spike does.
- **`session_auth_or`:** write the fallback through `ctx.accounts.…`
  (`ctx.accounts.player.authority == ctx.accounts.signer.key()`), import `session_keys::SessionError`
  next to `session_auth_or`/`Session`/`SessionTokenV2`, and keep `player` a seeded
  `Account<Player>` (`seeds = [PLAYER_SEED, player.authority.as_ref()], bump = player.bump`) so the
  `authority` used by `#[session(authority = player.authority.key())]` comes from a validated account.
- **Client error mapping:** SessionError is not in our IDL; the client needs its own map
  6000 `ValidityTooLong`, 6001 `InvalidToken`, 6002 `NoToken`, 6003 `InvalidAuthority`
  (see `SESSION_ERRORS` in `tests/helpers/session.ts`).
- Session client helpers (`createSessionIx`, `revokeSessionIx`, `sessionTokenPda`, program ids) live in
  `tests/helpers/session.ts`; port them to the web client.

## 2026-10-09: Ephemeral chunk PDA as crank authority (Task 6 follow-up)

Spike commit `d6dfb8a` (`spike: ephemeral chunk PDA as crank authority`; code and test removed in
the next commit). Ixs: `spike_chunk` (64-byte ephemeral chunk sponsored by the Player),
`spike_tick`, `spike_chunk_schedule(owner, cx, cz, task_id, interval_ms, iterations)` and
`spike_chunk_cancel(owner, cx, cz, task_id)`. The latter two take **any** signer as `caller`; the
`ScheduleTask`/`CancelTask` CPI has the chunk PDA as account 0 (writable, signer via
`invoke_signed` with the chunk seeds). Test: `tests/02-spike-chunk-authority.spec.ts` (3 tests, all
passing).

| Question | Answer (tested) |
|---|---|
| Can an ephemeral, **non-delegated** program PDA with **0 lamports** (the chunk: 64 B, 0 lamports, owner magicraft) be task authority? | **Yes.** `Scheduled task request` logged; 100 ms × 10 → counter exactly 10 within ~1 s and stays 10. Schedule CPI ix: 10.6k CU. |
| Can it later **replace** its task, with the CPI triggered by a different caller? | **Yes.** Task 100 ms × 1000 armed by the owner's wallet; a fresh 0-lamport keypair re-scheduled the same id × 2 → exactly 2 more ticks. The authority is the chunk PDA, not the caller, so re-arming is permissionless. |
| Can it **cancel**, triggered by a different caller? | **Yes.** 100 ms × 1000, cancelled by the stranger after 500 ms → counter frozen. |

### Decision

Chunk tick crank authority = the **Chunk PDA** itself; day crank authority = the **World PDA**
(same kind of account: ephemeral, program-owned, non-delegated). Neither needs a delegated
`Player` in the arming tx, so any player's move/edit (or the watchdog) can re-arm a chunk crank.
The fallback (a program-wide `["crank"]` PDA delegated once) is not needed.

## 2026-10-09: Worlds, VRF seed, day crank (Task 16, permanent code)

Test: `tests/11-world.spec.ts`. Measured on the local stack (CU of the whole ix):

| Ix | CU | Notes |
|---|---|---|
| `create_world` | 14.6k-16.1k | EphemeralAccount create + Borsh write + day-crank `ScheduleTask` CPI (~7k); varies with the World bump search |
| `request_seed` | 30.8k | VRF program ~11.7k; rest is Anchor, `program_identity` bump search, session derive |
| `tick_day` | 4.1k | re-anchor + day advance |
| `schedule_day_crank` | 7.3k | |

- VRF seed fulfilled in 79-94 ms after `request_seed`.
- Re-arming the day crank 3× from 0-lamport strangers: 4 ticks / 4 s before and after (replace, not
  duplicate).
- **Replace restarts the timer and executes at once.** Ungated re-arm every ~500 ms for ~5.5 s on
  the 1 s day crank: **10 ticks** (one per re-arm; the regular 1 s tick never came due). So
  unconditional re-arms let any caller drive (or, slower than the interval, merely shift) the
  tick rate. Fix: `schedule_day_crank` is a no-op unless the crank is stale
  (`World::day_crank_stale`, `CRANK_STALE_MS` = 3 s); gated spam: 5 ticks in ~5.5 s, no-op re-arm
  2.2k CU. The same rule applies to chunk-crank re-arms (Task 20).
- **Read-only signer at `ScheduleTask` account 0 works** (World passed read-only, `AccountMeta`
  signer, not writable): task replaced and kept ticking; 4.9k CU vs 7.3k with the World writable.
  `scheduler::schedule` passes the authority's writability through.
- **Deploy guard:** `pnpm test` leaves a `localnet` build (test VRF queue) in `target/`. For
  devnet/mainnet use `scripts/build-release.sh` (`pnpm build:release`): plain `anchor build`, then
  fails unless the IDL's `request_seed.oracle_queue` is `DEFAULT_EPHEMERAL_QUEUE`. Identical ER txs (same signer, blockhash, data) are rejected as "already processed",
  so repeated re-arms from one signer need distinct txs.
- **VRF queue capacity:** two `request_seed` ixs in one tx, or two concurrent txs, fail the second
  with `AccountDataTooSmall` in the VRF program (`Idx: 9488`): the local test queue arrives full of
  stale devnet requests and has room for about one pending request. So the "second callback hits
  `SeedAlreadySet`" path could not be produced end to end locally; it is covered by the unit test
  `state::tests::set_seed_only_once` and the e2e test tolerates the queue rejection. **Production:**
  a full `DEFAULT_EPHEMERAL_QUEUE` makes `request_seed` fail; the client should retry (the world
  stays usable for re-requests while `seed_set == false`). Any session-authed delegated Player may
  pay `request_seed` (VRF output is unbiasable). While `!seed_set`, `tick_day` only records
  liveness (no re-anchor, `time_of_day` stays 0).

## 2026-10-09: Chunk generation and reclaim (Task 17, permanent code)

Test: `tests/12-chunk.spec.ts` (+ the two chunk tests in `01-player.spec.ts`). Reference bytes
come from `cargo run --release -p magicraft-core --example gen -- <seed_hex> <cx> <cz>`
(`crates/core/examples/gen.rs`); stage-1 blocks, biomes, final blocks, animals and the spawn all
match the onchain result byte for byte, and a closed chunk regenerates identically.

**SBF-measured CU** (local ER, whole ix incl. Anchor; tx = 1.4M ComputeBudget limit):

| Ix / tx | CU |
|---|---|
| `create_chunk` (2 ephemeral creates, 1 bump search each for chunk + presence) | 17.7k-28.2k |
| `grow_chunk` (resize + `generate_stage1`; varies with the seed / terrain) | 584k-604k |
| tx 1: ComputeBudget + `create_chunk` + `grow_chunk` | 604k-632k |
| `populate_chunk` (tx 2; incl. spawn search for (0,0)) | 587k-802k over 50 chunks (2 seeds), typical 620k-700k |
| `close_chunk` (2 ephemeral closes; no crank to cancel yet) | 17.1k |
| `set_spawn` (review follow-up; `spawn_point` scan of (0,0)) | 17.8k |
| `populate_chunk` with no cave worms nearby (no neighbor strips loaded) | ≈ 95k |

Stage-1 split (profiled with `sol_log_compute_units`): `biomes_chunk` 257k, `heights_chunk` 263k,
`generate_stage1` total ≈ 556k. Stage-2 split: `stage1_info_from_blocks` 17k-58k; caves ≈ 535k
of which ≈ 500k is the 4 neighbor height strips (`heights_cols` ≈ 125k each, always loaded) and
≈ 0.88 CU per modeled cave op (cap 380k modeled → ≤ ≈ 335k CU); ores ≈ 4.5k; trees 8k-35k, or
≈ 105k-128k when a diagonal corner is loaded (≈ 100k per corner); cacti + animals < 1k.

**The hand estimates were ~5× low** (stage 1 modeled 100-120k → 556k measured; one side strip
modeled 20-25k → 125k). The value-noise grids (`fbm_grid`, ≈ 165 CU per column per octave) and
`chunk_sums` dominate. And **with overflow checks on, stage 1 did not fit at all**:
`biomes_chunk` 668k + `heights_chunk` > 696k → `grow_chunk` hit the 1.4M limit. Checked `i64`
multiplication on SBF is a software routine. Fix: `[profile.release.package.magicraft-core]
overflow-checks = false` in the workspace `Cargo.toml` (core keeps checks in debug/test builds,
where every overflow would panic; results are identical whenever nothing overflows; the program
crate keeps its checks).

**Worst case populate** (no split needed, but little headroom): modeled per chunk from the
`scan_cave_tail` stats (10^6 chunks) as 100k fixed + 125k × side strips + 110k × corners +
0.9 × cave ops + 34k trees: p50 682k (matches the measured ≈ 650k), p99 843k, p99.999 1.09M,
**max 1.13M** (none > 1.2M). The construction bound (cave cap fully used **and** 4 corners) is
≈ 1.42M, i.e. a chunk could in principle exceed 1.4M and stay at `gen_stage 1`; never observed.
**Open risk (accepted, follow-up task):** populate's theoretical worst case ≈ 1.42M CU. Do not
split populate; the planned fix is optimizing the noise-grid inner loop / neighbor height strips
in core (caves and trees share the neighbor height window, which is the bulk of the cost).

Other findings:
- `AccountInfo::data_len()` borrows the data: calling it while a `RefMut` of the same account is
  alive panics (`solana-account-info` lib.rs:105). Read the length first.
- The ER's `getMinimumBalanceForRentExemption` returns 0; the program's `Rent` sysvar matches the
  base layer (1 621 680 for the 105-byte Player).
- Rent per chunk: (17 152 + 60) × 32 + (48 + 60) × 32 = **554 240** lamports (create 333 056,
  grow +221 184), refunded exactly by `close_chunk`; a chunk closed before growing refunds
  333 056.
- Review follow-ups (same task): `grow_chunk` is permissionless (anti-squatting: the sponsor is
  the chunk's payer Player, validated against `chunk.payer`; the full rent was reserved at
  create); a `create_chunk` neighbor must be `DONE` (`ChunkNotReady`); `close_chunk` ignores
  passive animals (zombies still block; animals are dropped and regenerated by populate);
  `populate_chunk` takes the World read-only and the spawn moved to the permissionless
  `set_spawn` (`SpawnAlreadySet` = 6142).

## 2026-10-09: Terrain generation CU optimization (Task 17b)

Goal: populate's worst case provably < ~1.0M (Task 17: construction bound ≈ 1.42M > 1.4M),
typical populate < 500k, stage 1 < 350k, **byte-identical output**. Verified identical by the
core tests, a 6 912-chunk stage-1 + stage-2 FNV digest and 300 `gen` example outputs (3 seeds)
against the pre-change build, and `pnpm test` (12-chunk spec compares onchain bytes with `gen`).

**Harness:** `bench/cu/run.sh` — a raw-entrypoint SBF program (`bench/cu`, depends only on
magicraft-core, workspace release profile) run in litesvm by a host runner (`bench/cu/runner`);
both are separate cargo workspaces, built `--offline`, outside the program (nothing ships).
Per-instruction profiles: `SBF_TRACE_DIR=<dir>` (litesvm register tracing) + `llvm-objdump` of
`bench/cu/target/sbpf-solana-solana/release/magicraft_cu_bench.so`.

| Component | Task 17 | Task 17b |
|---|---|---|
| `biomes_chunk` | 257k | 51k |
| `heights_chunk` | 263k | 70k |
| `generate_stage1` | 538k-610k | 150k-175k |
| `grow_chunk` ix (local ER) | 584k-604k | 164k-180k |
| neighbor side strip | 125k | 9.6k (+ shared `WindowSums` 38k once) |
| neighbor corner | ≈ 100k | 3k |
| `stage1_info_from_blocks` | 17k-58k | 30k-34k (fixed) |
| `generate_stage2` (768 chunks, 3 seeds) | — | median 175k, max 294k |
| `populate_chunk` ix (local ER) | 587k-802k | 196k-262k (outside core ≈ 4.4k) |
| worst-case bound | ≈ 1.42M (modeled) | **898k** (`STAGE2_CU_BOUND`, calibrated) |

Findings / techniques:
- **Signed `i64` division is a ~200 CU software routine on SBF** (`__divdi3`), even by a
  constant. `fbm_grid` divided every sample by the octave weight total (≈ 51k of each 68k
  `fbm_chunk`), and `height_from` used `div_euclid` per column. All divisions are now unsigned on
  provably non-negative values (one instruction). This alone took stage 1 from 560k to 260k.
- Value-noise grids are separable: each corner row is interpolated along x once per column
  (`rows[cz][lx]` = the inner lerp, independent of `lz`), then one z lerp per sample, in `i64` on
  zero-extended non-negative values (no sign-extension shift pairs). Inner loop 14 instructions
  per sample per octave; ≈ 6.2k per 256-sample octave pass (was 15k + division). Runtime-sized
  `fbm_rect(w, d)` replaces the 16×16 / 9×9 const-generic grids (unrolling bought nothing).
- Lattice box sums: only the lattice sub-grid the requested columns need (6×9 for a strip,
  6×6 for a corner), running box sums, separable bilinear blend (exact integers).
- Populate height window: one 11×11 lattice grid (`WindowSums`) shared by all 8 neighbor parts
  (heights are a pure function of the world column), and the detail noise per part is one
  `fbm_rect` (was a 3-octave `fbm_2d` per column). `col_limits` loads the 4 sides once and reads
  window rows directly (40k → 9.7k).
- `stage1_info_from_blocks`: binary search per column (stage-1 columns are solid exactly up to
  `h`, and blocks are not editable before populate): ≤ 6 probes instead of ≤ 57.
- Stage-1 fill: rows from `min(h) − 3` up are memset to water/air, columns write only their
  solid part. Tree canopies visit only in-chunk cells (an out-of-chunk neighbor tree costed 2k).
- Carving: exclusive ranges, per-row slices (6 CU per voxel test, ≈ 10-13 per hit).
- Also measured: checked `i64` multiply is a software routine (Task 17), `memset`/`memcpy` are
  syscalls (cheap), the SBF loop around a few loads/stores costs ≈ 6-8 CU per byte.

**Bound (`populate::STAGE2_CU_BOUND`, const-asserted ≤ 950k):** loop counts are hard limits;
unit costs are measured maxima rounded up (mostly 10-20%, never below the measurement; the carve
slope 0.9 CU/op is the fit itself, its margin sits in the per-sphere term). Ix overhead 15k
(measured 4.4k on the ER) + Stage1Info 40k + window 122k (`WindowSums` 42k, strips ≤ 12.6k incl.
glue — a z strip measures 10.8k, corners 4.1k, `col_limits` 12k) + worm replay 432 × 300 + 2k
(measured with every sphere touching, i.e. the real replay plus the clip-and-cost path for the
misses: ≤ 0.7k + 300/sphere) + carving 432 × 290 + 0.9 × `CAVE_OPS_CAP` (380k modeled ops; over
26 712 sphere geometries — r 1-3, every chunk-edge clip, deep and above-sea ceilings, worst write
path — carving one sphere costs ≤ 255 + 0.9 × its modeled ops; real chunks ≈ 0.75 CU/op) + trees
117k (54 candidates ≤ 40 each, 48 `biome_at` ≤ 0.67k, 6 own trees ≤ 2.38k, 24 side-neighbor trees
≤ 1.44k, 24 corner ones ≤ 0.64k) + misc 6k = **898k**. The modeled cave weights and cap are
unchanged (they decide which spheres are carved, i.e. the output); only their CU calibration is new.

`bench/cu/run.sh check` re-measures every unit cost except the ix overhead and fails if one
exceeds its constant in `populate.rs`; **re-run it after any terrain/caves/populate change and
after every toolchain upgrade** (platform-tools, rustc, Agave), then raise constants as needed.
Bench hooks (`bench_carve_one`, `bench_replay_touching`, `bench_col_limits`, `bench_write_tree`,
public `Lim`) exist only with core's `bench` feature, which only `bench/cu` enables. A golden test
(`golden_terrain_digest`) pins an FNV digest of stage 1 + stage 2 + spawns over 3 seeds × 36
chunks; its value was confirmed on the pre-17b build (491994e).

Other: the 12-chunk spec's stage-1 regenerate test re-sent a byte-identical create + grow tx
within the same ER blockhash once grow got fast ("already processed"); it now uses a different
ComputeBudget limit.

## 2026-10-09: Join, presence, movement (Task 18, permanent code)

Test: `tests/13-move.spec.ts` (walks a BFS path planned over magicraft-core reference blocks
from the spawn into an edge neighbor chunk, one block per update; the terrain depends on the
per-run VRF seed). Code: `instructions/play.rs`, `presence.rs`.

**SBF-measured CU** (local ER, whole ix):

| Ix | CU |
|---|---|
| `join_world` (EphemeralAccount create 432 B + PDA bump search) | 13.6k-16.6k |
| `move_player`, wallet signer, in-chunk step (no resize) | 14.5k-15.4k |
| `move_player`, first move (presence grow CPI) | 16.0k |
| `move_player`, border crossing (shrink old + grow new) | 20.2k |
| `move_player`, session-key signer (token checks add ~1-6k) | 15.7k-24.4k |

Decisions:
- `join_world`: `MoveState::spawn(spawn_fp, chain_ms)` (`last_ms` = chain reading at join);
  no presence entry at join — the first move adds it (a move re-adds a missing own entry
  anyway, e.g. after pruning). New error `SpawnNotSet` (6143).
- Hot-path identity checks without `create_program_address` (~1.5k CU each): window chunks
  (`state::ready_chunk_blocks_ro`), presence (`presence_of`) and `PlayerState` (stored
  `player`/`world` constraints) are checked by owner + discriminator + stored identity; only
  the program writes those headers, always at the matching PDA.
- Coarse chain time: `chain_ms + 750` is passed to `check_move` (lead 1 000 ms, lag 1 250 ms).
- Presence: one resize CPI at most per list; crossing leaves the old list first (refund),
  then enters the new one, so a crossing nets to exactly 0 lamports (tested). Pruning
  (≤ 4 entries stale > 5 s chain time, never the mover's own) refunds the mover.
- Vitals (`play::apply_vitals`, unit-tested; constants in `play.rs`): exhaustion 16 units per
  block of horizontal travel + 20 per second, 4 000 per food point; every ≥ 4 s of client
  time (one step per move): +1 health if food ≥ 18 (costs 1 500 exhaustion), or −1 health if
  food is 0 (not below 1). Damage = fall + pending (both presence entries when crossing);
  health 0 ⇒ `Dead` on every later move.
- `create_chunk` accepts an optional `player_state`: the player's current chunk is always
  creatable (a player whose chunk was closed while away — entry pruned, payer closed it —
  would otherwise be stuck: missing chunks read as Stone).
- Not e2e-testable yet (unit tests instead): fall damage (no block edits to build a drop),
  `pending_damage` (written by mobs, Task 20), death. Revoked token: `AccountNotInitialized`.
- **Review fix (omitted-chunk exploit):** omitting the mover's own chunk made the previous box
  read Stone, so `check_move` skipped the swept path ("stuck" exemption: ~14-block wall
  phasing) and the old presence (pending-damage escape). Now `move_player` requires every
  window chunk under the previous or new xz footprint (`play::required_slots`,
  `ChunkNotReady`) and `old_presence` on every chunk change (`InvalidPresence`); core limits a
  stuck start to a short step (≤ 1 block horizontally, −1..+1.5 vertically, destination
  clear). Pruning removes entries with `pending_damage > 0` only after 60 s
  (`presence::DAMAGED_STALE_MS`; plain entries 5 s), so pausing doesn't dodge damage and an
  abandoned damaged entry blocks `close_chunk` for at most 60 s. **Task 20:** mobs should
  only damage fresh entries. **Task 19:** `place_block` must reject overlap with the box of
  **any fresh presence entry** (not only the placer's), else a block placed into another
  player traps them (their stuck escape is limited to 1 block).
  Time exhaustion uses the move gap clamped to 10 s (not the 2 s movement cap).

## 2026-10-09: Block edits, crafting, combat, eat, respawn (Task 19, permanent code)

Test: `tests/14-actions.spec.ts`. Code: `instructions/actions.rs` (module docs hold the rules).
The route (an animal, a block next to water, 3 logs, a work spot with stone, soft blocks and two
pillar columns) is planned over magicraft-core reference blocks of the 5×5 chunks around (0,0)
by `tests/helpers/scout.ts`; about 1 world in 3 fits (animals and trees both need Plains/Forest
near the spawn), so the spec retries worlds (scouting is ~0.6 s per world since `referenceChunk`
now runs the built `gen` binary instead of `cargo run`). Only the chunks the route touches are
created.

**SBF-measured CU** (local ER, whole ix):

| Ix | CU |
|---|---|
| `break_block` (log / stone / soft, no water nearby) | 9.7k-10.4k |
| `break_block` next to water (fluid enqueue) | 12.1k-12.3k |
| `place_block` (incl. a border block with a neighbour chunk + presence) | 11.1k-11.2k |
| `place_block`, neighbour via `find_program_address` (first version) | 18.7k-23.2k |
| `attack_mob` | 7.7k-8.3k |
| `craft` (hand / at a table) | 8.5k / 10.6k |
| `select_slot` / `eat` / `respawn` | 3.8k / 5.4k / 6.8k |

Decisions:
- **Break cooldown model:** `now ≥ break_until_ms`, then `break_until_ms = now + break_time`
  (the client animates the mining progress before sending). One block per break time, no
  start/finish handshake. A full inventory loses the drop; the block still breaks.
- **No line-of-sight check** (chunk data is public anyway); reach is eye (feet + 1.62) → block
  center ≤ `params.reach` + 0.5 block slack (the stored position lags the client's), in `u64`
  squares after a per-axis bound (no division, no signed/checked multiply). Mobs: 3 blocks +
  slack to the nearest point of the 2-block column.
- `player` is passed read-only and not PDA-checked (~1.5k CU saved): `player_state.player ==
  player` ties it; only `join_world` writes that field at the matching PDA.
- New ix `select_slot(slot)` sets `held_slot` (the tool for `break_block` / `attack_mob`).
- **Overlap with other players (`place_block`)**: fresh presence entries (≤ 5 s) of the target
  chunk **and** of every neighbour chunk a player box can reach the block from (x / z / diagonal
  for edge blocks) are **required** — as `remaining_accounts` (neighbour chunk read-only +
  presence; or the empty chunk PDA if it does not exist, which costs a `find_program_address`).
  Optional ones would let a placer trap a player across a border. The box is client-sized
  (half-width 78 FP, height 461 FP). Dead or quit players' entries go stale after 5 s and never
  block.
- Face adjacency only counts solid blocks in passed chunks (omitting a chunk can't fake support).
- **Fluid:** an edit enqueues (`fluid::enqueue_neighbors`) only if water can be affected — the
  old block was water, one of the 10 dependent voxels is water, or the block is on a border whose
  neighbour wasn't passed. So ordinary digging doesn't wake the chunk crank. Neighbour queues
  (`chunk_n/s/e/w`, optional, writable) get their pushes only when passed; otherwise the
  center's own voxel is still queued and its tick carries the flow on. Every chunk whose queue
  has work goes through `crank::maybe_arm_chunk` (still a stub until Task 20).
- **Drops nonce** `(mob.id << 32) ^ chain_ms ^ slot`: not retryable in the same slot; the killer
  can still choose the timing of the last blow (it only shifts a 1–3 item roll).
- **Respawn** resets inventory, vitals, cooldowns, `MoveState::spawn(spawn, chain_ms)` and
  `cx/cz`, and records `PlayerState.respawn_ms` (from the reserved bytes, offset 398); the old
  presence entry is left to pruning (stale, so it blocks nothing). `presence::upsert` / `remove`
  drop (not apply) the `pending_damage` of an own entry last seen before `respawn_ms`, so damage
  that hit the dead body never carries into the new life (e.g. walking back into the death
  chunk within 60 s, or respawning into it).
- **Review fix (neighbour aliasing):** a `place_block` neighbour chunk counts as pre-validated
  only if it sits in the `chunk_n/s/e/w` slot of exactly that offset; first version accepted any
  passed slot, so e.g. the east chunk + its (empty) presence could stand in for the west one and
  a player across the west border could be built into. Unit tests cover aliasing, missing/wrong
  `remaining_accounts`, cross-border overlap, the empty-PDA case and cross-border fluid enqueue.
- Fall damage and death are now tested end to end (pillar of 8 → 5-ish damage; pillar to
  `g2 + 24` and step off → dead; `move`/`break`/`select`/`eat` → `Dead`).
- Observed: the route's digging can remove the block under the world spawn (respawned players
  then fall a little); and a block placed into the spawn would put respawned players in a block
  (they can break their way out — breaking needs no movement).

## 2026-10-09: Chunk tick crank (Task 20, permanent code)

Test: `tests/15-crank.spec.ts` (+ unit tests in `instructions/crank.rs`). Code:
`instructions/crank.rs` (module docs hold the rules), `chunk.rs` (neighbor slots), helpers
`tests/helpers/crank.ts`.

Findings (tested on the local ER 0.14.10):

| Question | Answer |
|---|---|
| Can a cranked tx list a **non-existent** account writable (e.g. the PDA of a neighbor chunk not created yet)? | **No.** The program runs, then the tx fails with `Account N: <key> was illegally used as writable` / `InvalidWritableAccount` (the ER checks writable accounts after execution; `create_chunk` works only because the account exists at the end of that tx). So a missing neighbor is a **placeholder**: the center chunk (and the center presence) again. Duplicates in an ix are fine. Read-only non-existent accounts are fine. |
| How is a crank executed? | One tx signed by the validator: a Magic-program ix, then `Crank1111…` (`Executed crank with 1 instructions`) which invokes the scheduled ix at **depth 2** with accounts `[validator, executor, program, ...ix accounts]`; it shows up in `getSignaturesForAddress` of the ix accounts. The tick gets **≈ 400k CU** (`of 399700`). |
| Does a Magic-program CPI work **inside** a cranked tx? | **Yes**, both: `CancelTask` (idle tick cancels its own task: `Successfully added cancel request`, no further executions) and `ScheduleTask` (busy tick renews its own task; the task kept running past 240 iterations: (0,0) reached `tick_count` 170+ with one renewal at 160). The chunk PDA signs via `invoke_signed` as usual. |
| Rate | 250 ms interval: 3.8-4.0 accepted ticks/s, unchanged by 2 `arm_chunk` re-arms or by 16 moves in 3 s (stale gate; no CPI in those txs). |
| Watchdog | `debug_cancel_tick` (localnet-only hook; header untouched) froze `tick_count`; moves did not re-arm until the last tick was > 3 s old, then the next move re-armed (2.85 s after the cancel) and ticks resumed. |
| Neighbor lists | `create_chunk` / `close_chunk` next to an armed chunk re-armed it (`neighbor i crank re-armed`): its next tick listed the new chunk, and after the close the list no longer did; no failed ticks. |

**Measured CU** (whole magicraft ix):

| Ix | CU |
|---|---|
| `tick_chunk`, player present, no mobs / fluid single-hole flow | 6.1k-6.6k / 5.1k-10.0k |
| `tick_chunk`, animals, nobody near | 5.6k-12.1k |
| `tick_chunk`, zombies + player (chase, hits) | 12.5k-20.6k, max 43.6k (spawn attempt with the torch scan) |
| `tick_chunk`, idle → `CancelTask` CPI | 7.8k-8.3k |
| `tick_chunk`, renewal (`ScheduleTask` CPI, list reused) | 23.0k-31k |
| `move_player` that arms (first move: + presence grow) | 32.3k-32.5k; border crossing that arms 39.7k |
| `arm_chunk` (crank alive: no-op) | 3.4k |
| `create_chunk` alone (8 bump searches for the neighbor bumps) | 39k-50k (was 17.7k-28.2k); + re-arming one neighbor 56k-64k |
| `close_chunk` (+ re-arm one neighbor, cancel) | 27.9k |
| `break_block` next to water | 12.3k-13.2k |

The stale check itself costs ≈ 0.45k per move (measured by stubbing it); run-to-run variance of
`move_player` is several k (random keys), so compare within one run.

Decisions:
- Interval `min(fluid_tick_ms, mob_tick_ms)`; a tick is accepted only ≥ half an interval after
  `last_tick_ms` (direct calls can at most double the rate); fluid every accepted tick (when it is
  the interval), mobs when the global `chain_ms / mob_tick_ms` period advanced (`dt` = periods ×
  `mob_tick_ms`, ≤ 1 s). 240 iterations per arm, renew every 160 accepted ticks while there is
  fluid work or fresh presence (center or neighbors); mobs alone let it run out (≤ 60 s); idle
  cancels. Populate arms chunks with animals; moves arm the mover's chunk (read-only); fluid edits
  and neighbor fluid pushes (from inside the tick, untested end to end: same CPI path as the
  renewal) arm the chunks with work; `arm_chunk` is a client watchdog. All gated by
  `crank_stale` (`crank_armed == 0` or `last_tick_ms` > 3 s old; writable arms set
  `last_tick_ms = now`).
- `nbr_mask` + neighbor slots in `create_chunk` / `close_chunk` (each slot = the neighbor PDA,
  writable iff it exists; the client looks the 4 accounts up). A tick whose list doesn't match the
  mask (a neighbor created while this chunk's crank was armed read-only and not yet ticked) is a
  no-op that re-arms itself with the derived list. A neighbor **closed** under such a crank makes
  its ticks fail (non-existent writable) until the scheduler drops it; the next move re-arms
  (`crank_armed` is still 0).
- Tests: `helpers/world.ts` `PARAMS` now default to `zombieCapPerChunk 0` and `mobTickMs 60000`
  (mobs step ≤ once a minute), so specs comparing mob slots or exact health stay deterministic;
  14-actions finds its animal by kind nearest to the scouted spot and walks back into reach if it
  wandered; its water-break check accepts water already flowing in.
- Not covered: a fluid-heavy tick (the scouted breaks fill one hole; core's estimate for the worst
  tick is ≤ ~130k, within the 400k crank budget).

### Hardening (review follow-up)

- Renewals and repairs schedule the **canonical** list (`derive_tick_ix` from the header), never
  the accounts a (permissionless) caller passed; an existing neighbor's presence must be its PDA
  (stored bump; ≈ 1.5k CU per existing neighbor per tick) and a broken one triggers a repair.
- Repairs are throttled to one per 3 s (`ChunkHeader::repair_s`, chain seconds mod 2^16).
- **Task-id squatting:** ids are `sha256(tag ‖ key ‖ epoch u8)`; `ChunkHeader::task_epoch` /
  `World::day_epoch`. A writable stale re-arm of a crank believed armed (`arm_chunk`, edits,
  neighbor changes, `schedule_day_crank`, which now takes the World writable) cancels the old
  id and moves to the next epoch (tested: `arm_chunk` after `debug_cancel_tick` → id of epoch 1,
  ticking again). `move_player` arms read-only and keeps the epoch. Residual risk: ids are
  predictable, so an attacker can squat all 256 epochs of a key (256 live tasks); re-check with
  Hydra (Task 28), whose task ids may be per authority.
- Neighbor arming inside a tick is best effort (errors returned to us are logged); a failure
  inside the Magic program would still abort the tx (Solana CPI semantics).
- `debug_cancel_tick` exists only in `localnet` builds (`#[cfg(feature = "localnet")]`).
- 12-chunk picks a world whose first animal chunk along +x is within 6 chunks (reference
  generator, ≤ 20 worlds) and compares mob kinds per slot, not positions.

## 2026-10-09: End-to-end journey (Task 21)

Test: `tests/99-e2e.spec.ts` (`pnpm test:e2e`, ~90 s of test time). World: 150 s day, zombie cap 4,
mob tick 333 ms; worlds are retried until the scout finds a ≥ 8-chunk tour, a block water flows
into, 3 logs, ≥ 22 soft blocks at a work spot, and a fresh land chunk next to the route for the
night (1-4 worlds). Typical run: tour ~60 steps / 8 chunks (12 s), route done at day ~40 s,
night at 75 s, first zombie hit within ~5-40 s (20 → 17), pillar ~22 blocks → dead, respawn,
close, withdraw; base settled exactly `baseAtSync + (erBeforeWithdraw − erAtSync)` in every
run, and `open_chunks` matched. ~200 session-key ER txs (+ ~8 expected failures), 1 wallet ER
tx (withdraw), 3-4 base txs. Every chunk create / close moved the Player's ER balance by
exactly 554 240.

**Zombies make most visited chunks unreclaimable.** By day, zombies spawn in caves
(non-sky-exposed floors) within 8-24 blocks of a present player in any ticking chunk; they never
burn there and never despawn, and `close_chunk` refuses chunks with zombies. One run: 22 zombies
in 7 of 9 chunks, 18 of them below the surface; close outcomes over 5 runs: 0-2 of 8-9 chunks
reclaimed, `ChunkHasMobs` on 2-8. Cave zombies also fill a chunk's cap (4), so a lingering
player's chunk may get no surface zombie at night (first full-suite run: a zombie 2 blocks away,
underground, no hit in 70 s). The spec therefore idles until night (no heartbeat: the presence
goes stale, cranks idle) and spends the night in a freshly created chunk. Design follow-up:
despawn far / unreachable zombies, or let `close_chunk` drop zombies with no fresh presence
nearby. **Resolved in Task 21b** (below).

**Session-key CU** (whole ix; three runs; one run's numbers sit ~3-5k above another's for the
same ix, from bump searches over the random keys, so compare within a run):

| Ix | CU |
|---|---|
| `create_world` / `request_seed` | 16.7k-22.7k / 32.8k-37.4k |
| `create_chunk` (relinks armed neighbors) / `grow_chunk` / `populate_chunk` | 42k-103k / 161k-169k / 88k-290k |
| `set_spawn` | 17.7k-89k (one 89k sample) |
| `join_world` | 18.8k-21.8k |
| `move_player` (130-165 per run) | 20.6k-53.5k, median 24k-29k |
| `break_block` (log / soft / next to water) | 15.1k-18.8k / 14.1k-23.3k / 19.1k-24.4k |
| `place_block` | 13.9k-20.9k |
| `craft` (hand / table), `select_slot`, `respawn` | 10.9k-15.4k / 12.9k-17.4k, 6.0k-10.5k, 8.9k-13.4k |
| `close_chunk` | 51k-91k |
| `withdraw` (wallet) | 28.1k |
| `tick_chunk` (fluid + mobs / zombie + player) | 12.3k-28.2k / 9.1k-48.0k |

Harness: `scripts/local-er.sh` now waits for base slot ≥ 20 before starting the ER; starting it
in the first slots failed the ER's fee-vault setup tx deterministically on a loaded machine
("Magic fee vault setup failed": `Unsupported program id`).

## 2026-10-09: Zombie despawn, mobs don't block close, deterministic zombie tests (Task 21b)

- **Despawn** (`core::mobs`, "Despawn"): a zombie stepped with no fresh target within 32 blocks
  (3D) accumulates `Mob.alone_ms` (u16 at offset 26; offset 25 is padding, reserved now 4
  bytes); at 15 s it is cleared (`MobEvent::despawned`, tick logs `tick: zombie despawned`).
  15 s rather than 30 s: a chunk with only mobs keeps ticking just for its remaining crank
  iterations (≥ ~20 s after the last renewal at 250 ms), so a 30 s threshold would rarely fire.
  Measured: despawned ~20 s after a debug spawn (5 s until the entry went stale + 15 s);
  despawn tick 13.7k CU. Golden terrain digest unchanged (mobs stepping isn't in it).
- **`close_chunk`** no longer checks mobs (empty presence suffices): zombies and animals are
  dropped. `ChunkHasMobs` (6113) stays in the enum unused so codes don't shift. Close with a
  zombie: 27.6k CU, exact refund. e2e: 5-7 of 9 chunks closed (was 0-2), the rest edited or
  occupied.
- **`debug_spawn_mob(kind, pos)`** (`localnet` builds only, like `debug_cancel_tick`): mob at a
  FP position inside the chunk, first free slot, then arms the crank; kind 0 clears all slots. The e2e and one 15-crank
  test place a zombie 3 blocks from the player at night; one 15-crank test keeps natural spawns
  (bounded to two nights, rotating through fallback chunks). Damage attribution:
  `helpers/zombie.ts` `chaseUntilHurt` waits next to the zombie until the hit shows in the
  presence entry's `pending_damage`, then moves (reading it and moving blindly raced the tick).
- 15-crank idle test: the self-cancel is not always the last execution. Seen in 2 of ~10 runs:
  after `tick: idle, crank cancelled` (`Successfully added cancel request for task <id>`), (0,0)
  kept executing for > 15 s — accepted ticks were further idle cancels of the same id,
  interleaved with executions rejected as too early (< half an interval after the previous one),
  i.e. a second execution stream of that task id that the cancel didn't remove. Likely a
  replace race in the ER scheduler (the chunk is armed read-only by moves, so `crank_armed`
  stays 0 until the first tick and several same-id replaces can land close together); not
  reproduced in 4 dedicated runs. Harmless (no-op ticks) and bounded by the task's iterations
  (≤ 240 × interval). The test now waits for quiescence (the chunk's own `last_tick_ms`
  unchanged for 2 s, ≤ 75 s; its signature history also holds neighbours' ticks, which list it),
  checks the trailing ticks are ok no-ops with `tick_count` frozen, then that no tick is accepted
  for 2 s. An animal from the neighbouring animal chunk can also wander into (0,0) and keep
  it busy; the test clears it first (`debug_spawn_mob` with kind 0). Re-check with Hydra (Task 28).
- e2e: `DAY_SECS` 120, night wait bounded by one day; worlds can't be pre-screened by seed
  (the seed is VRF output, known only after paying for `create_world` + `request_seed`).
- Water scouting (15-crank `findWater`, e2e via `fedByWater`): the water feeding the broken block
  may sit across a chunk border; both specs now create Q's horizontal neighbour chunks (a run
  failed with the feeder in a chunk that existed only in the reference terrain).
- Full suite: 108 passing, two consecutive runs.
