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
