# Devnet deployment (Task 28)

Deployed and smoke-tested 2026-10-10. **Status: deployed and passing.** The first deploy found
one program issue (the World chain clock assumed 50 ms ER slots; devnet ER slots are ~10 ms);
it was fixed (`us_per_slot_hint`, µs rate, backward steps until the first join), the program
upgraded in place, and the full smoke passes, moves right after world creation included
([Clock fix](#clock-fix-and-upgrade)).

## Endpoints and ids

| What | Value | Source |
|---|---|---|
| Program (devnet) | `4GTybm3WD66wUnTgS8UcB9H947uAY7BAqivp8HfbSsW9` (`target/deploy/magicraft-keypair.json`) | deploy |
| ProgramData | `9NDxTc8LBXrobxJ2Vm5YS7n6EkVEHkATpVe65MBmuZzu` | `solana program show` |
| Upgrade authority | `5Hs51hUxpr9cBz8gwbsFNVcJqdtPeJR8MoUNxoUSGP8a` (default CLI keypair) | deploy |
| Base RPC | `https://api.devnet.solana.com` | |
| ER, EU (used) | `https://devnet-eu.magicblock.app`, validator `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e` | `getIdentity`, router |
| ER, US | `https://devnet-us.magicblock.app`, `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd` | `getIdentity`, router |
| ER, Asia | `https://devnet-as.magicblock.app`, `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` | `getIdentity`, router |
| ER, TEE (private ER, auth tokens; not supported) | `https://devnet-tee.magicblock.app`, `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` | router |
| ER websockets | same host, `wss://` (the client derives them) | |
| VRF queue | `DEFAULT_EPHEMERAL_QUEUE` `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc` (on the ER, owned by the VRF program) | account query |
| VRF program | `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz` (base + ER) | account query |
| Session program (gpl_session) | `KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5` (base + ER) | account query |
| Delegation program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` | |
| e-SPL program | `SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2` (base + ER) | account query |
| e-SPL global rent PDA | `4RvdEGaUyChj3AketeBZoY1EotNtPveMFUXL8DVetrAp`: **14.73 SOL** on devnet | smoke |
| Hydra | `Hydra17i1feui9deaxu6d1TzSQMRNHeBRkDR1Awy7zea`, `eHyd5BU8QffvHi4GnXwxrK4WpS7pM2x9UGKHBWii7mf`: deployed on base and ER (not used) | account query |

ER validators report `magicblock-core 1.0.0` (git `cc32775`, solana-core 4.0.0); the local
stack is 0.14.10. `devnet-router.magicblock.app` `getRoutes` lists all four with `baseFee: 0`,
`blockTimeMs: 50`, but **the measured ER slot rate is ~100 slots/s (~10 ms per slot)**.

Sources: `https://docs.magicblock.gg/llms.txt`;
`pages/ephemeral-rollups-ers/api-reference/rpc/introduction.md` (devnet/mainnet endpoints);
quickstart (validator identities per region);
`pages/ephemeral-rollups-ers/introduction/fees-and-commit-economics.md` (checked against source
2026-08-20: normal ER tx `0`, session 3 000 000, commits after the first 1 000 000 each from the
delegation deposit, 10-commit cap without a delegated fee payer, top-up 300 000 setup);
`pages/tools/crank/implementation.md` (still documents the Magic-program `ScheduleTask` CPI);
live RPC queries (`getIdentity`, `getVersion`, `getRoutes`, `getAccountInfo`) on 2026-10-10.

Latency from the deploy machine (Europe): TLS + request 67 ms EU, 290 ms US, 710 ms Asia;
keep-alive `getSlot` to EU median 22 ms. Pick the region closest to the players; the
validator identity must match the endpoint (it is pinned in `delegate_player`).

## Deploy

```sh
pnpm build:release          # plain anchor build + guards: DEFAULT_EPHEMERAL_QUEUE, no debug_ ixs
solana program deploy -u devnet --keypair ~/.config/solana/id.json \
  --upgrade-authority ~/.config/solana/id.json \
  --program-id target/deploy/magicraft-keypair.json \
  --with-compute-unit-price 20000 --max-sign-attempts 100 target/deploy/magicraft.so
```

- `.so`: 892 640 bytes, sha256 `a2ec6dcc5b3a5ba57d239e5849edfd493ae4ce89d02159dcb2cc451c7e04437e`;
  the dumped onchain program matches byte for byte. Slot 509 431 948, signature
  `5RL8CxENDZnXt4ZMWtgGiA1RctQRojVRDxUCpv1YFQHy9QXD4Ax2rZFFDBoEw9L5tGiCVM5w2quTL3WkFJ1FNUa`.
- Cost: **4.5410 SOL** (ProgramData rent 4.5355 + ~0.0055 fees/priority). A first attempt with
  `--use-rpc` failed ("Data writes to account failed: Max retries exceeded"); its buffer was closed
  (`solana program close <buffer>`, rent refunded). The default TPU path then worked.
- Upgrades: same command (the program id keypair is only needed for the first deploy). The IDL
  was not uploaded onchain (the client bundles it). **The ER picks an upgrade up with a delay**
  (observed ~1-2 min): a world created right after the upgrade still ran the old binary.
- `pnpm build:release` leaves the release IDL in `target/`; `pnpm test` rebuilds with
  `localnet`. The client IDL in `app/src/idl` is not cluster-specific (`idlFor` rewrites the
  program id and VRF queue from the config), so it was not re-synced.

## Clock fix and upgrade

Fix (commit `fix(program,app): World clock rate from a measured µs-per-slot hint, …`):
`TimeAnchor` stores `us_per_slot` / `base_us_per_slot` (µs, 1 000–1 000 000; same offsets);
`create_world(…, us_per_slot_hint)` takes the client's measurement (`measureUsPerSlot`: two
`getSlot` readings ~2 s apart; 0 = 50 ms default); every re-anchor before 30 s checks the rate
against the observed span (±1 s) and replaces it only if inconsistent; until the first
`join_world` (`World.first_join_ms`, @248) the clock steps to wall time in either direction,
and the first join re-anchors once more before it stamps; afterwards monotonic as before.
`waitClientMs` / test helpers got the coarse fallback (`chainEstimate`, now in `layout.ts`).
Unit sims: 10 / 9.75 / 50 / 100 ms slots × hints {0, exact, 50 ms, 10 ms, 100 ms, 1, u32::MAX}
× first join {never, 0.3, 0.9, 1.5, 6, 12 s}: error < 1 s from 10 s on, never back after the
join, base rate within 5 %. Local suite green (109 Anchor specs, app 222 + live 6).

Upgrade: `pnpm build:release` (900 208 bytes, sha256
`2279ac140f3dd6d5c9d6a9cd70236997ba9add73a000d4bf83977348b4e24da3`, byte-identical onchain),
same deploy command, signature
`4iLypcYYujt7Uhnoj9GWXuBygnsNAVb85tEgANC363p2Anp3W2cCDW7E41UoxDRQ9X7Q5WXSK8NXX3umRnPRKcbR`,
slot 509 441 716, cost **0.0568 SOL** (ProgramData extended to 902 880 bytes + fees). No failed
buffer this time. (Two older buffers owned by the same key, `BBfDYjxC…` 3.41 SOL and
`CmDaZa7N…` 3.56 SOL, predate this task and were left alone.)

Smoke after the upgrade (new throwaway wallet, 0.2 SOL, returned): **all 20 steps pass.**
Hint measured 10 023 µs/slot; at join the anchor was 0.3 s off the local clock; **30 moves
right after creation, 0 `TimeSkew`**, all fine-mode, confirm min 93 / median 98 / p90 102 /
max 128 ms (first move waited 0.7 s for `last_ms`); clock probe over 60 s: worst |estimate −
local clock| **351 ms**, always fine, rate 10 000-10 023 µs; chunk cranks ticked (+19 each in
6 s while the player's presence was fresh, then idle-cancelled as designed); day crank +6 in
6 s; break/place 13.7k/15.9k CU; top-up credited 242 ms after base confirm; **`close_chunk`
refunded the full 554 240 lamports** (29.9k CU); withdraw back on base in 1.26 s;
`withdraw_base` ok. World `AhLPxi9f6E9Jw6w1BkLtvM271ReBnuRjSbisySr8ZYRt`.

## Smoke test, first deploy (`scripts/devnet-smoke.ts`)

`SMOKE_WALLET=<throwaway keypair> pnpm smoke:devnet` runs the app chain layer (`app/src/chain`)
against devnet through Vite's SSR module runner (`scripts/run-smoke.mjs`; no extra deps). The
throwaway wallet was funded with 0.2 devnet SOL from the deployer (`solana transfer`) and
emptied back afterwards; its key stayed in the session scratchpad. Two runs (same wallet; the
second resumed with the delegated Player and created a second world), results below.
Worlds `4ty519uqBcyd5MUSSbKsaGDR9A8oc4LBz63vgFQgCaBt` and
`GdgcuNraWLvY5ZNfsYhqdB4ZnN4wRiyHjyxY1duRdwFL` ("devnet smoke") remain on the EU ER.

| Step / risk | Result |
|---|---|
| Onboarding: `init_player` + `deposit` 0.05 + `delegate_player(MEUGG…)` (1 base tx) | **Works.** Base confirm 2.8 s; the ER had cloned the Player 66 ms later. |
| Session: `create_session_v2`, no top-up | **Works.** Session key has 0 lamports on base and on the ER after every gameplay tx. |
| ER fees | **Still 0.** All gameplay txs were signed and fee-paid by the 0-lamport session key; router `baseFee: 0`. |
| `create_world` | Works: 19.7-21.2k CU, 163-234 ms confirm; Player −10 400 (World storage). |
| `request_seed`, Player PDA payer, `DEFAULT_EPHEMERAL_QUEUE` | **Works, fee-exempt:** Player ER delta 0, queue delta 0 (33.9k CU). The seed landed **46-49 ms** after the request confirmed. No wallet-payer fallback needed. |
| Chunk (0,0) `create_chunk`+`grow_chunk` / `populate_chunk` | Works: 215-219k / 227-242k CU (limit 1.4M), ~190-270 / 97 ms; Player −554 240 rent. |
| `set_spawn`, `join_world` | Work: 17-22k / 17-20k CU, ~200 ms. |
| Moves right after world creation | **FAIL: `TimeSkew`** (see Known issues). Run 1 used the test helper clock (`waitClientMs`, fine estimate only); run 2 the game client's estimate (`chainEstimate`, coarse fallback); in both, the walk was rejected with `TimeSkew` within its first second (after at most a few accepted moves). |
| Moves 11 min later (World clock still in coarse mode) | **Work.** 20 moves, one in flight at a time: confirm **min 92 / median 96 / p90 98 / max 98 ms**; CU 26k (55.9k for the move that arms a chunk crank). The first move had to wait 6.7 s for chain time to pass the `last_ms` stamped at join. |
| Day crank (`ScheduleTask` CPI to the Magic program) | **Works on ER 1.0.0**: `day_ticks` +1 per second (858 ticks over 14.3 min on world 1), task id from `scheduler::task_id`. No Hydra migration needed now. |
| Chunk crank | **Works:** both chunks armed, `tick_count` +6-7 in 6 s, an animal moved. Fluid not exercised (no water next to the route); the same `tick_chunk` path runs it. |
| `break_block` / `place_block` | Work: 16.5k / 18.8k CU, ~98 ms. |
| Top-up: `lamportsDelegatedTransferIx` 0.01 SOL | **Works.** Rent PDA funded (14.73 SOL); base confirm 774 ms, ER credit +10 000 000 242 ms later. |
| `close_chunk` | Not exercised (the walk found its crossing in the first neighbor, so only (0,0) and (1,0) exist, both in use). |
| `withdraw` (wallet-signed ER tx: commit + undelegate) | **Works.** Player owned by magicraft on base **1.1 s** after the ER tx; base 51 183 640 → 58 910 808 = the ER balance (settlement by the ER delta incl. the top-up and rent spent); `open_chunks` 4. |
| `withdraw_base` (all but rent-exempt) | Works: 57 727 168 to the wallet; 1 183 640 stays in the Player. |
| Cost | ~0.01 SOL of the 0.2 (2 × 2 chunks of locked rent ≈ 0.0022, worlds/PlayerStates ≈ 0.0001, top-up setup 0.0003, delegation/commit deposit, tx fees). |

Signatures. Devnet base: onboarding
`4J2jqNWWaHW8ZEsuj2vynhB7gvTFPQtGxysyU5rPcA3MAtjXh7kXeZ2AqNcngA4KJsM1xX4e3vYXBPzgCfxWUf2N`,
top-up `2QUZSvz7igxtHffCAi4GiGhTs9ZaJtzyAvKpDvLbJQtA1bTemmW9ShpkLExaHK2oWxN2TtKbrfBDsREZhBACBXLi`,
withdraw_base `2fhneqfkgkRVzfTJCkv3exNQvExcpQ2SwNGfo851LPYTj1QTdMXuwPUGmZGccYgVAsFpLn6e1XEEgDGe2TDLEqjF`.
EU ER: request_seed
`4VFo5SDWzPtxqaM8ia3qJZ6mkxgNLuvqiuGq1wjr9jSRgaXQevRorKecSjKgi1y19AqXLmQzQ2qmcRbxrBbFBXYL`,
withdraw `3LWhwuSYGhBNsFzwwFJUPVwazDPPrh89HLPvSnmxfxwd2coeTo56Tvffyijzed24eFiRVqyKR4VCxx4Z1TW7sE7`.
The full per-step output (`SMOKE_OUT`) is not committed.

### Move latency → pipelining

With the EU ER and one move in flight, confirm latency is ~96 ms, so the move lane sustains
~10 Hz, above the ~8 Hz the client aims for. **Pipelining was not implemented.** Players far from
their ER (US/Asia from Europe: 3-10× the RTT) would be capped at 2-5 Hz; implement the Task 22
pipelining (send before confirmation, `prev` = last sent position, snap back + drop the
in-flight chain on any rejection) before targeting them, or pick the closest region.

## Browser smoke

`pnpm -C app build --mode devnet` (reads `app/.env.devnet`), served with `vite preview` on
port 4173 and opened in the Browser pane:

- The landing page renders ("Connect a wallet"), says no Solana wallet is detected (the pane
  has no extension), and **offers no burner** (non-local RPC, `VITE_BURNER` unset).
- The bundle contains the devnet endpoints; the page makes no RPC call before a wallet
  connects.
- The world list only renders after onboarding (needs a wallet), so it was checked from the
  page context with the same `getProgramAccounts` query as `fetchWorlds` (`dataSize` 265) to
  `devnet-eu`: **CORS ok, both smoke worlds listed** (seed + spawn set).
- The `app-preview` launch config (`pnpm -C app exec vite preview`) hung in "starting" in the
  desktop app; running `node node_modules/vite/bin/vite.js preview` in `app/` works. Server
  torn down afterwards.

## Known issues

1. **Fixed (see [Clock fix](#clock-fix-and-upgrade)); kept for the record.** World chain clock
   on ~10 ms ER slots (blocked play for ~15-20 min after a world was created). `TimeAnchor::new` starts at `DEFAULT_MS_PER_SLOT = 50`
   (`programs/magicraft/src/state.rs`), the local ER's slot time. Devnet ER slots are ~10 ms, so
   the estimate runs ~4.4× fast until the first rate measurement (`RATE_SPAN_MS` = 30 s) and
   ends ~100 s ahead of the validator's wall clock. `reanchor` is monotonic (slew only, 1/8 of
   the rate), so it takes ~17 min to come back (samples: +100 s at 30 s, +38 s at 11 min,
   +17 s at 14 min). While the estimate is > 10 s off, `TimeAnchor::read` falls back to coarse
   wall time (1 s resolution) for every reader. Effects measured:
   - The first seconds: `join_world` stamps `last_ms` with the fine estimate (up to 10 s
     ahead); readers then switch to coarse → every move fails `TimeSkew` until wall time
     passes `last_ms` (≤ 10 s), and the fine/coarse flip itself races the client's estimate.
     The game client snaps back and recalibrates, so it recovers, but the player is stuck
     for several seconds.
   - Coarse mode: moves work (above) but with 1 s clock resolution; day/night ran 4.4× fast for
     the first 30 s; `World.last_tick_ms` is written from the (ahead) estimate while
     `dayCrankStale` / `schedule_day_crank` compare it with coarse time, so the day-crank
     watchdog cannot detect a dropped crank until the clock converges.
   - After convergence, `ms_per_slot` is an integer: at ~9.7-10 ms per slot one step is
     ~10 %, so the rate alternates between 9 and 10 (8 with slew) and the estimate wobbles
     inside the ±500 ms deadband.
   Fix direction (not implemented, needs a decision): measure the slot rate from the ER
   instead of assuming 50 ms (e.g. first measurement after ~2-5 s, or set it from the slot
   delta between `create_world` and the first `tick_day`), store the rate in µs per slot (or
   a fixed-point) for 10 ms slots, and allow a one-time backward re-anchor before the world
   is seeded / before anyone joined. `scripts/devnet-clock-probe.ts` prints a World's
   anchor vs the validator clock.
2. Fixed: `waitClientMs` and the test helpers' `chainMs` now use the coarse fallback too.
3. **Pre-upgrade worlds must not be used** (`4ty519uq…`, `GdgcuNra…`, `4dAJFaQg…`, all
   "devnet smoke"): their stored ms-based rates are now read as µs, and their `first_join_ms`
   bytes (formerly `_reserved`) decode as 0 even though players joined, so backward steps stay
   enabled forever: every re-anchor may step the clock back under existing `PlayerState`
   stamps, giving recurring short `TimeSkew` stalls. **Future World layout changes should add a
   layout-version byte** so old accounts are detected instead of silently reinterpreted.
4. Commit cap: without a delegated fee payer an account can commit 10 times per delegation
   (fee docs). The Player commits only on `withdraw` (commit + undelegate), so this is not hit.
5. Fluid ticks and zombies were not exercised on devnet (covered locally).

## Playing on devnet with Phantom / Backpack / Solflare

1. Set the wallet to **devnet** and fund it (≥ ~0.06 SOL: the Player deposit + fees;
   `solana airdrop -u devnet 1 <address>` or https://faucet.solana.com).
2. `pnpm install`, then `pnpm dev:devnet` (uses `app/.env.devnet`: base
   devnet, EU ER + its validator as the default region, program id,
   `DEFAULT_EPHEMERAL_QUEUE`); open the printed URL. Pick Europe / US / Asia in the top bar
   ([Regions](#er-regions)).
3. Connect → create / fund / delegate the Player (1 approval) → session (1 approval) → pick
   or create a world (creation measures the ER slot rate for ~2 s first).
4. Withdraw from the HUD (ER commit + undelegate, then `withdraw_base`).

Production build: `pnpm -C app build --mode devnet` (the build requires the `PROD_REQUIRED`
vars, or `VITE_ER_REGIONS` in place of `VITE_ER_RPC` + `VITE_ER_VALIDATOR`; `.env.devnet` sets
them).

## ER regions

The top bar has a region picker. Region list (`app/src/chain/config.ts`): `VITE_ER_REGIONS`
(JSON `[{"id","label","rpc","ws"?,"validator"}]`) if set; else, with the base RPC on
`api.devnet.solana.com`, the built-in `DEVNET_REGIONS` (Europe / US / Asia, endpoints and
validators above); else the single ER of `VITE_ER_RPC` ("Local" on the local stack). The
default is the region `VITE_ER_RPC` names (an endpoint outside the list becomes its own region
with `VITE_ER_VALIDATOR`), else the first. The choice is stored in `localStorage`
(`magicraft.region.<base RPC>`; ignored if no longer listed). The picker is disabled inside a
world and while a player move is running.

- Switching rebuilds the ER connection, program client and session sender for the new ER
  (the session key is base-layer and kept), tears down the HUD subscription and re-runs the
  flow. The world list only queries the selected ER (its cache is keyed by ER endpoint).
- Each region has its own worlds: on 2026-10-10 Europe listed the smoke worlds, US and Asia none.
- **Player in another region.** The Player PDA is delegated to one validator. The client reads
  it from the delegation record on base (`["delegation", player]` under
  `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`; bytes 8..40 = validator, layout of
  `magicblock-delegation-program-api` `DelegationRecord`). If it is not the selected region's
  validator, the app shows "Your player is in <region>" (plus a read-only list of this region's
  worlds) with:
  - **Switch to <region>**: selects that region.
  - **Move player to <here>**: `withdraw` on the old region's ER (wallet-signed, commit +
    undelegate; same resumable phases as the HUD withdraw, incl. waiting for base settlement),
    then the usual "parked player" screen delegates it to the selected region's validator
    (second approval, optional extra deposit; no `withdraw_base` needed). Worlds, chunks and
    PlayerStates in the old region stay there; the rent of chunks opened there stays locked
    until the player plays there again (switch back first to reclaim unused chunks).
  - A validator no configured region runs: explained, no actions.

## Next steps

1. A full human playtest (5 min) with a browser wallet on devnet.
2. Pipelining only if players are far from their ER (latency above).
3. Hydra: nothing to do now (Magic-program `ScheduleTask` works on ER 1.0.0; the docs still
   document it); keep `scheduler.rs` as the single swap point and re-check at mainnet time.
