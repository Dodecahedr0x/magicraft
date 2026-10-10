# Magicraft — Design

Fully onchain, browser-playable Minecraft-like survival game on MagicBlock Ephemeral Rollups (ER).

## Goals

- Playable in a browser; no wallet popups during gameplay (session keys).
- A player is a delegated account holding SOL; it sponsors (pays rent for) everything it creates.
- Worlds and all in-world state are ER ephemeral accounts (rent: `(data_len + 60) * 32` lamports).
- Anyone can create worlds; world seed comes from MagicBlock VRF.
- Survival gameplay: mining, placing, inventory, crafting, health, hunger, fall damage, day/night,
  passive animals and hostile zombies driven by MagicBlock cranks, caves, biomes, flowing water.

## Tech choices

- Program: plain Anchor (1.0.x) + `ephemeral-rollups-sdk` (features `anchor`, `vrf`) + gpl_session
  (`KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5`).
- Client: Vite + TypeScript + Three.js, custom voxel renderer, plain HTML/CSS UI.
- Movement: client-authoritative physics with onchain plausibility checks.

## Accounts

### Base layer, delegated to ER

**`Player`** PDA `["player", authority]` — `authority`, `bump`, `open_chunks` (count of open chunks
it sponsors; UI warnings only). Holds SOL, is the `sponsor` for all ephemeral accounts the
player creates. Created + funded + delegated in one wallet tx (`init_player` + `deposit` +
`delegate_player`; `deposit` is only for this initial funding, it needs an undelegated Player).
Top-ups while delegated use the npm SDK's `lamportsDelegatedTransferIx` (e-SPL program): one base tx
signed by any wallet, credited on the ER in ~100 ms, no undelegation (cost: amount + 300 000 setup
lamports + base fee; fresh 32-byte salt per call). A plain base transfer to the delegated PDA is
**not** a top-up (the ER never sees it).
Settlement is **delta-based**: each commit applies the Player's ER lamport change since the last
sync to its base balance (rent spent on the ER lowers base at the first commit; refunds from closed
accounts flow back on the next commit). Withdraw = commit + undelegate, then transfer out on base
layer; it is **never blocked**. Only unedited chunks are reclaimable (`close_chunk`), so rent of
edited chunks stays locked by design. Chunks still open at undelegation survive on the ER; an
unedited one can be closed (rent back) only after the Player is delegated again. Before a withdraw
the client shows `open_chunks` and offers to close the player's unedited chunks first.

### Ephemeral (ER-only)

Created, resized and closed by calling the SDK's `ephemeral_accounts::EphemeralAccount` builder
directly (sponsor = Player PDA, signer seeds from Anchor's bumps, `vault` = `EPHEMERAL_VAULT_ID` and
`magic_program` declared by hand). The `#[ephemeral_accounts]` macro is not used: its generated
`create_ephemeral_*` methods cannot use ix args in eph seeds (and re-derive bumps at runtime).
A CPI can grow an account by at most 10 240 bytes, so any account larger than that is created at
≤ 10 240 bytes and then resized in a second top-level ix (both can share one tx). Rent is
`(data_len + 60) * 32` lamports, e.g. 542 592 for a 16 896-byte chunk.

| Account | Seeds | Contents |
|---|---|---|
| `World` (≤ 10 240 B) | `["world", creator, nonce]` | name, creator, nonce, bump, `seed: [u8;32]`, `seed_set`, `params: WorldParams`, `time_of_day`, `spawn: (x,y,z)`, day-crank task id, `last_tick`, chunk count |
| `Chunk` (17 152 B = 768 header + 16 384 blocks; rent 550 784) | `["chunk", world, cx, cz]` | payer, bump, `edited`, `gen_stage`, blocks `16×16×64` u8 (16 KB), mob slots (8), fluid queue (ring of 64), tick-crank task id, `last_tick` |
| `ChunkPresence` | `["presence", chunk]` | growable vec of `{player, pos, last_seen, pending_damage}` (~40 B each), no cap |
| `PlayerState` | `["pstate", world, player]` | pos, vel, `fall_start_y`, health, food, 36-slot inventory `{item:u16,count:u8,durability:u16}`, cooldowns, last move slot/time |

Exact byte layouts of all accounts: `programs/magicraft/src/state.rs` (module docs).

### WorldParams (set at `create_world`, immutable, range-checked)

`walk_speed, sprint_speed, swim_speed, jump_velocity, gravity, max_fall_speed, reach,
attack_cooldown_ms, day_length_secs, fall_damage: bool, hunger: bool, zombie_cap_per_chunk,
mob_tick_ms, fluid_tick_ms`. Client physics reads the same values.

### Chain time (`World.clock`, `state::TimeAnchor`)

`Clock::unix_timestamp` has 1 s resolution; movement validation needs ms. The World stores an
anchor (`anchor_slot`, `anchor_ms`, effective `us_per_slot`, measured `base_us_per_slot` — µs
per slot, bounds 1 000–1 000 000 — and a rate sync point). **Readers** (gameplay ixs, World
read-only, so no write contention) use `chain_ms_ro` = `anchor_ms + ⌊(slot − anchor_slot) ·
us_per_slot / 1000⌋`; if the anchor is unset or stale (older than 10 s, or > 10 s from wall
time) they get a **coarse** reading (wall seconds, `coarse = true`) and widen tolerance (move
lead 1000 ms instead of 250). **Writers**: `create_world` sets the first anchor at the client's
measured slot rate (`us_per_slot_hint`, ~2 s of `getSlot`; 0 = 50 ms default), `tick_day`
(~1 s) re-anchors, and the first `join_world` re-anchors once more before stamping. Rate:
before 30 s every re-anchor checks the current rate against the observed span (±1 s) and
replaces it by the measurement only if inconsistent; then re-measured over ≥ 30 s spans.
Offset: **until the first join** (`World.first_join_ms == 0`) the clock steps to wall time
(`unix·1000 + 500`) whenever it is > 500 ms off, in either direction; **after it**, re-anchoring
is monotonic: lagging by > 750 ms jumps forward; lagging/ahead by > 500 ms runs the clock 1/8
fast/slow (slew, never backwards; 1/8 stays inside the 5/4 move speed tolerance). Devnet ERs run
~10 ms slots (the local ER 50 ms), which is why the rate is not assumed (Task 28).

### Presence economics

Entering a chunk resizes `ChunkPresence` up one entry, paid by the entering player's `Player` PDA;
leaving shrinks and refunds to the leaver. Entries with `last_seen` older than ~5 s are ignored by
mobs and pruned by the next mover in that chunk (pruner receives the refund).

### Spawn

Global per world, stored in `World.spawn`. Chunk (0,0) is always the first chunk, created by the
world creator right after the VRF callback; after populating it the client sends `set_spawn`,
which sets spawn above the topmost solid block nearest its center (block coordinates).

## Terrain generation

Deterministic integer math on `hash(world.seed, …)`; independent of chunk creation order.

- **Blocks (u8):** air, grass, dirt, stone, cobblestone, sand, sandstone, gravel, bedrock, log,
  leaves, planks, coal/iron/diamond ore, crafting table, furnace, torch, glass, iron block, snow,
  ice, cactus, water source + flowing levels 1–7.
- **Biomes:** temperature × moisture low-frequency noise → plains, forest, desert, snowy, mountains.
  Height parameters blended over neighboring columns.
- **Heightmap:** 2–3 octave value noise per column; sea level 28; bedrock at y=0.
- **Caves:** per-chunk hash-seeded worms (0–2 per chunk, 20–40 segments, radius 1–3). Generation
  replays worms from the 3×3 chunk neighborhood and carves only local voxels. Caves never carve a
  block adjacent to water.
- **Ores:** fixed per-chunk cluster counts (≈8 coal y<50, 4 iron y<32, 1 diamond y<12).
- **Trees / cactus:** neighborhood replay, may cross chunk borders.
- **Passive animals:** 0–3 spawned in grass biomes during populate.
- **Stage 2 details** (`crates/core/src/caves.rs`, `populate.rs`): worms have 12–24 segments
  (step = radius) and are clamped to their chunk's 3×3 neighborhood, so 3×3 replay equals a
  single-buffer world carve. Caves carve `1 ≤ y < surface`, never next to water or ice (exact
  across borders via 2-column neighbor height strips); 1 in 4 worms is an entrance worm that may
  also open the surface in its own chunk's non-Plains/Forest columns above sea level. Trees and
  canopies write only above stage-1 surfaces (logs over air/leaves, leaves over air → order-free).
- **Stage 2 cost bound:** a chunk over budget would be stuck at `gen_stage 1`, so populate is
  bounded by construction: cave carving stops taking spheres at a modeled 380k ops (measured over
  10^6 chunks: p99.999 288k, max 340k — never hit), and the const `STAGE2_CU_BOUND` (SBF-calibrated
  CU: hard loop counts × rounded-up measured unit costs, ≈ 898k incl. ix overhead; re-checked by
  `bench/cu/run.sh check`) is asserted ≤ 950k. **SBF-measured (Task 17b, `bench/cu`):** create + grow tx ≈ 186k-200k CU (stage 1
  150k-175k), populate ≈ 196k-262k (stage 2 median 175k, max 294k over 768 chunks). Task 17's
  numbers (grow 584k-604k, populate 587k-802k, construction bound ≈ 1.42M) were dominated by
  signed `i64` divisions (a ~200 CU routine on SBF) and per-neighbor lattice grids (see
  `docs/notes/spikes.md`).

Generation is compute-heavy: anything computed per block costs ≥ ~7 CU per byte (measured:
16 384 computed bytes ≈ 115k CU above baseline; bulk fills/copies are nearly free), so generation
txs set `ComputeBudgetProgram.setComputeUnitLimit(1_400_000)` (honoured on the ER; the default is
200k per ix). The budget is per tx, so stages that don't fit together go in separate txs.

Steps, sent back to back by the client:
1. `create_chunk(cx, cz)` — create `Chunk` at 10 240 bytes (`gen_stage = 0`) + empty
   `ChunkPresence`; `open_chunks += 1`.
2. `grow_chunk(cx, cz)` — requires `gen_stage == 0` and data length 10 240 (so a repeat is
   rejected, never double-resized); resize `Chunk` to full size (same tx as 1), then biome,
   heightmap, column fill if it fits the budget (otherwise a separate stage-1 ix/tx), and
   stores the 256 biome bytes in the `Chunk` header (`biomes: [u8; 256]`) for stage 2.
   `gen_stage = 1`. **Permissionless** (anti-squatting): the chunk's payer Player sponsors the
   resize (rent reserved at create).
3. `populate_chunk` — requires `gen_stage == 1`; rebuilds `Stage1Info` from the stored biomes +
   a column scan of the stage-1 blocks (`stage1_info_from_blocks`), then caves, ores, trees,
   cactus, animals (`generate_stage2`; sea ice is already placed by stage 1). Sets
   `gen_stage = DONE`. Permissionless; World read-only.
4. For (0,0) only: `set_spawn` (permissionless, once) computes `World.spawn` (block coordinates)
   from the populated chunk.

Every other ix that takes a chunk (moves, edits, ticks, mobs) rejects it (`ChunkNotReady`; ticks
no-op) unless it is at full size and `DONE`.

Creation allowed only adjacent to an existing **fully generated** chunk or the player's current
chunk (or (0,0) in an empty world). Payer =
creator's `Player` PDA.

`close_chunk`: payer only, never the spawn chunk (0,0) (`SpawnChunk`), if `!edited` and presence empty. Mobs never block: animals are
dropped and come back when the chunk is regenerated; zombies are dropped (with nobody present
they would despawn anyway). **Accepted tradeoff:** a payer can lure a zombie into its own
unedited chunk, step out (presence empty) and close the chunk, deleting the zombie — the
same effect as despawn, only sooner, and it costs the payer the chunk. Cancels the chunk's tick crank,
closes `Chunk` + `ChunkPresence`, refunds rent, `open_chunks -= 1`. Regeneration later yields
identical terrain. The payer's `Player` must be delegated (the refund goes to it on the ER).

## Cranks

Scheduled with the Magic program's `ScheduleTask` (bincode `MagicBlockInstruction`, CPI to
`MAGIC_PROGRAM_ID`, crate `magicblock-magic-program-api` 0.14) and stopped with `CancelTask`.

Rules established by the spikes (`docs/notes/spikes.md`, Tasks 4 and 6):

- **Authority.** Account 0 of the CPI is the task authority; it signs via `invoke_signed`. Any
  program PDA works: a delegated `Player`, and also an ephemeral, non-delegated, 0-lamport PDA
  (tested with the chunk). Only the same authority can replace or cancel a task (a different
  authority reusing a live id is silently rejected); who sends the outer tx doesn't matter.
- **Task ids are global per validator**, not per authority. Derive them collision-free from the
  account they serve (e.g. the first 8 bytes of `hash("tick" ‖ chunk PDA)` / `hash("day" ‖ world
  PDA)`, masked positive and non-zero) and store them in the account. A schedule tx succeeding does
  **not** prove the task exists (collisions are rejected later, only in the validator log).
- **Same authority + same id = replace** (interval, iterations and ixs reset). This is the
  reschedule primitive: re-arming or changing a chunk's neighbor list is just another
  `ScheduleTask`; no cancel needed. Cancelling an unknown id is a no-op. **A replace restarts the
  timer and executes at once** (Task 16: re-arming every ~500 ms gave ~2 ticks/s on a 1 s crank),
  so unconditional re-arms let callers drive the tick rate: re-arm ixs are no-ops unless the
  crank is **stale** (`last_tick` older than `CRANK_STALE_MS` = 3 s, or never ticked and created
  more than 3 s ago). Changing a chunk's neighbor list is the one deliberate unconditional replace.
- **`ScheduleTask` accepts a read-only signer at account 0** (Task 16, tested): the authority
  PDA need not be write-locked to arm its crank (`schedule_day_crank` takes the World read-only;
  4.9k CU vs 7.3k writable).
- **Cranked ixs are permissionless.** Executions are signed and fee-paid by the validator; the only
  signer allowed inside a cranked ix is the crank-executor PDA (`["crank-executor", authority]` of
  `Crank1111…`). `tick_day` / `tick_chunk` take no user signer.
- **Failures kill tasks silently.** A failing cranked ix is retried (backoff 100 ms … 5 s, missed
  ticks caught up on recovery) but after ~26 s of continuous failure the task is dropped.
- Cost: currently none (ER fees 0); scheduling ≈ 10.6–12.6k CU, cancel ≈ 4.5k CU.

Design decisions (post-spike):

- **Chunk tick crank authority = the `Chunk` PDA** (signs with its own seeds); **day crank
  authority = the `World` PDA**. Neither needs a delegated `Player` in the arming tx, so any
  player's move/edit can re-arm any chunk's crank.
- **Never-failing ticks + watchdog.** `tick_chunk` / `tick_day` no-op instead of erroring on bad
  state and record `last_tick`. `move_player` (and block edits) re-arm the current chunk's crank
  when work exists and it is stale (same 3 s rule). **The day-crank watchdog is client-driven:**
  the client sends `schedule_day_crank` when it sees `World.last_tick_ms` stale; `move_player`
  takes the World **read-only** and never re-arms the day crank (no write lock on the World from
  movers). (A cranked ix has a fixed account list, so `tick_day` can't watch chunks.)
- **Unseeded worlds:** `tick_day` only records liveness (`last_tick_ms`, `day_ticks`) while
  `!seed_set` — no clock re-anchor, `time_of_day` stays 0, so the first day starts at sunrise
  when the seed lands. `request_seed` can be paid by **any** session-authed delegated Player
  while `!seed_set` (VRF output is unbiasable, so the payer doesn't matter).
- **`close_chunk` cancels the chunk's crank** before closing.
- **`World` ≤ 10 240 bytes**, so it is created in one ix.
- **`Player.open_chunks`** is for UI warnings only; withdraw is never blocked.

Crank types:

- **World day crank** — scheduled at world creation; advances `time_of_day`.
- **Chunk tick crank** — `tick_chunk` with accounts `[world, chunk, presence, N/S/E/W chunks,
  N/S/E/W presences, magic_program]`; a **missing neighbor is a placeholder** (the center chunk /
  presence again: the ER rejects non-existent accounts listed writable). Which neighbors exist is
  `ChunkHeader::nbr_mask`, kept by `create_chunk` / `close_chunk` (both take the 4 neighbor slots,
  writable iff the neighbor exists) and they re-arm every armed neighbor (its list changed); a tick
  whose list doesn't match the mask re-arms itself. Interval `min(fluid_tick_ms, mob_tick_ms)`,
  240 iterations per arm; each accepted tick (≥ half an interval since the last): fluid step
  (budget 16), mobs on the global `mob_tick_ms` period (crossings into neighbor slots, hits into
  fresh presence entries), one zombie spawn attempt. Idle (no fluid work, no mobs, no fresh
  presence in the chunk or its neighbors) → the tick **cancels its own task** (CPI from inside the
  crank works); fluid work or fresh presence → it **renews** its task every 160 ticks; mobs alone
  → it runs out (≤ 60 s). Armed by populate (animals), moves (watchdog), fluid edits, neighbor
  fluid pushes (from inside the tick) and the permissionless `arm_chunk`; all stale-gated. Details:
  `instructions/crank.rs` (module docs).

### Fluids

Water source + levels 1–7. Block changes next to water enqueue positions. Flow down first, else
spread sideways with level+1 up to 7; two adjacent sources create a source; unsupported flow
recedes. Each change enqueues neighbors; cross-border writes go to neighbor chunks in the crank.

### Mobs

- Pig, cow, sheep: wander, 1-block step-up, avoid drops > 3.
- Zombie: spawns at night (or underground anytime) near fresh presence, ≥8 blocks away, no torch
  within 4, cap `zombie_cap_per_chunk`; chases nearest fresh player within 16 (own + neighbor
  presence); contact damage 3/s into `pending_damage`; burns on surface by day; **despawns** after
  15 s of stepped time with no fresh player within 32 blocks (3D; `Mob.alone_ms`) among the
  targets the tick sees (presence of the chunk and its 4 side neighbors), so cave zombies
  spawned by day near a passing player don't pile up and hold the cap.
- Mobs may move into a free slot of a neighbor chunk.
- Randomness: `hash(world.seed, chunk, tick)`. VRF only for world seed.

## Instructions

All gameplay ixs: `#[session_auth_or(ctx.accounts.player.authority == ctx.accounts.signer.key(),
MagicraftError::Unauthorized)]` with an optional `SessionTokenV2` (gpl_session V2 tokens: rent
returns to the fee payer and revoke needs the authority). The session key is the ER fee payer and
needs **0 lamports** there (ER fees are 0), so sessions are created without top-up. Tokens are plain
base-layer txs that don't reference the Player, so they can be created/revoked while it is
delegated; the ER clones the token on demand and follows base changes (revocation takes effect at
once). Validity is checked against the ER clock, max 7 days.

- `init_player` / `deposit` / `delegate_player` / `withdraw` (commit + undelegate) — wallet-signed.
  Top-up is client-side only (`lamportsDelegatedTransferIx`).
- `create_world(name, nonce, params)` → `request_seed` (VRF inside the ER on `DEFAULT_EPHEMERAL_QUEUE`,
  `DEFAULT_EPHEMERAL_TEST_QUEUE` locally, `oracle_queue` address-constrained; payer = any
  session-authed delegated `Player` PDA via a manual `invoke_signed` with both the `["identity"]` and Player seeds —
  not `invoke_signed_vrf`, which signs with the identity only) → `callback_seed` (`#[vrf_callback]`,
  typed seeded `World`, stores the 32-byte seed only if unset; the callback gets ≈ 260k CU, so no
  generation there; fulfilled in ~110 ms locally) → chunk (0,0). `create_world` arms the day crank
  itself (World PDA = task authority, +~7k CU); `schedule_day_crank` (permissionless, World
  read-only, no-op unless the crank is stale) is the client-driven watchdog's re-arm. `request_seed(client_seed)` mixes a client nonce into the caller seed.
- `join_world` — creates `PlayerState` at spawn, health 20, food 20.
- `move_player(pos, vel, on_ground)` ~8 Hz — speed bound vs elapsed time, AABB collision vs solid
  blocks, fall damage `max(0, fall_start_y − y − 3)` (water cancels), presence update/migration,
  apply `pending_damage`, hunger drain / regen / starvation.
- `break_block(x,y,z)` — reach (eye → block center), cooldown model (`now ≥ break_until`, then
  `break_until = now + break_time(block, held tool)`; the client shows the progress before
  sending), harvest tier, drop to inventory (lost if full; the block breaks anyway), durability,
  fluid enqueue, `edited = true`. Air/water/bedrock unbreakable.
- `place_block(x,y,z,slot)` — reach, target air/water, face-adjacent (to a solid block in a passed
  chunk), no overlap with the placer or any fresh presence entry (target chunk + required
  border-neighbour presences), fluid enqueue.
- `select_slot(slot)` — the held slot (tool for breaking / weapon).
- `craft(recipe_id, count, table?, furnace?)` — const recipe table; a station is claimed by block
  position (+ its chunk) and verified (block type, within reach); furnace smelting instant with
  coal/planks fuel.
- `attack_mob(chunk, idx)` — reach 3, cooldown, weapon damage, drops to inventory.
- `eat(slot)`, `respawn` (health 0 → spawn, inventory cleared).
  Details: `programs/magicraft/src/instructions/actions.rs` (module docs).
- `close_chunk`, `tick_chunk` (crank target), `tick_day` (crank target).

**Items (u16):** all blocks; pickaxe/axe/shovel/sword × wood/stone/iron/diamond with durability;
stick, coal, iron ingot, diamond, raw/cooked pork/beef/mutton, leather, wool, rotten flesh.

## Client

- `chain/` — base + ER connections, Anchor client from IDL, session key manager, tx sender
  (fire-and-forget, latest-wins coalescing for moves).
- `world/` — chunk store, `onAccountChange` subscriptions, worker greedy meshing, atlas, transparent
  water mesh by level, mob rendering from chunk slots.
- `player/` — 60 fps physics using `WorldParams`, 8 Hz position send, snap-back on rejection.
- `ui/` — world picker, create-world form (params), hotbar, inventory/crafting grid, health/food, PDA
  SOL balance, cost toasts, death screen. Day/night lighting from `time_of_day`; torches as lights.

### Flow

Connect wallet → create/fund/delegate `Player` (1 tx) → create session (1 approval) → pick or create
world → `join_world` → play (auto-create chunks within render radius ~3) → top up / withdraw.

### ER regions

The top bar picks the ER region (devnet: Europe / US / Asia; local stack: "Local"; list from
`VITE_ER_REGIONS` or the built-in devnet table, choice persisted per base cluster). Worlds, chunks
and PlayerStates exist only on the ER that created them and the `Player` is delegated to one
validator, so the world list shows the selected region's ER only, and a `Player` delegated to
another region's validator (read from its base delegation record) gets "Your player is in
<region>": switch there, or move it (`withdraw` on the old ER → base settlement →
`delegate_player(new validator)`); what it opened in the old region stays there. Session keys
are base-layer and survive region switches.

## Errors

One `#[error_code(offset = 6100)] enum MagicraftError` (Anchor 1.0 allows a single error enum per
program; 6000–6003 are taken by `session_keys::SessionError`, which is compiled in but not in our
IDL, so the client maps 6000 `ValidityTooLong`, 6001 `InvalidToken`, 6002 `NoToken`,
6003 `InvalidAuthority` itself). Specific codes: `Unauthorized`, `MoveTooFast`, `Collision`,
`OutOfReach`, `Cooldown`, `ChunkNotReady`, `InsufficientSponsorFunds`, `NotAdjacent`, `SeedPending`,
`InvalidParams`, `NotDead`, … Client maps: rejected move → snap back; funds → top-up prompt;
cooldown → silent retry; session expiry (`InvalidToken`/`NoToken`) → renew.

## Testing

- Rust unit tests on pure modules: terrain (determinism, order independence, CU measurement), fluids,
  mob steps, movement validation, recipes.
- Integration: `anchor test` with local validator + local ephemeral validator + local VRF oracle,
  full path from delegation through crank ticks and `close_chunk`.
- Day-one spikes (done, removed; findings in `docs/notes/spikes.md`): 16.8 KB ephemeral account
  creation; per-stage generation CU; crank calling an ix with ephemeral accounts; Player economics;
  VRF and session keys in the ER.
- Client: Vitest for meshing and physics parity; manual browser smoke test on devnet + ER.

## Resolved by spikes

Details and evidence: [`docs/notes/spikes.md`](../notes/spikes.md) (Tasks 2–6).

1. **Ephemeral account size.** Creation inside a CPI is capped at 10 240 bytes of growth; create at
   ≤ 10 240 then resize in a second top-level ix (same tx is fine). Use `EphemeralAccount` directly;
   the macro can't use ix args in seeds. A delegated `Player` PDA works as sponsor.
2. **Generation CU.** ≥ ~7 CU per computed byte; ComputeBudget 1.4M is honoured on the ER. Stage
   splitting stays the fallback (measure in Task 17).
3. **Cranks on ephemeral accounts.** Work. Task ids are global per validator; same authority + same
   id replaces (no cancel needed to reschedule); cranked ixs must be permissionless; failing tasks
   are dropped after ~26 s; a delegated Player PDA or an ephemeral non-delegated PDA (the chunk)
   can be the task authority; executions cost nothing today.
4. **Player economics.** Top-up via `lamportsDelegatedTransferIx`; settlement is delta-based on
   commit; open chunks strand rent across undelegation.
5. **VRF in the ER.** Works on the ephemeral queue with the Player PDA as payer (manual
   `invoke_signed`), callback reaches ephemeral accounts in ~110 ms with ≈ 260k CU.
6. **Session keys in the ER.** `SessionTokenV2` tokens are cloned on demand and track base
   (revocation immediate); session signer needs 0 ER lamports; works while the Player is delegated.

## Remaining risks

1. **Hydra deprecation.** The SDK marks the Magic-program crank CPIs deprecated in favour of Hydra.
   *Devnet (2026-10-10, ER `magicblock-core` 1.0.0):* the Magic-program `ScheduleTask` path works
   (day crank 1 tick/s for 14 min, chunk cranks tick); Hydra is deployed but not needed yet.
   Re-check before mainnet.
2. **VRF fee exemption.** *Resolved on devnet:* `request_seed` with the Player PDA as payer on
   `DEFAULT_EPHEMERAL_QUEUE` is fee-exempt (Player and queue ER deltas 0; seed in < 50 ms).
3. **Silently dropped cranks.** ~26 s of failures, or a task-id collision, drops a crank with no
   on-chain signal. Mitigation: never-failing tick handlers, collision-free ids, `last_tick` +
   watchdog re-arm.
4. **Locked chunk rent.** Rent of edited chunks is never reclaimable (by design); unedited chunks
   still open when the `Player` is undelegated keep their rent on the ER until re-delegation.
   Withdraw is never blocked; the client warns (`open_chunks`) and offers to close unedited ones.
5. **Write contention** on hot chunks (movers + crank on same accounts).
6. **Durability.** Ephemeral accounts live only in the ER; worlds are as durable as the ER state.
7. **Cluster prerequisites.** e-SPL global rent PDA must be funded on the target cluster (top-ups);
   ER fees are 0 in the current release (session keys rely on it). *Devnet:* rent PDA funded
   (14.7 SOL), top-up credited in ~250 ms; ER fees 0 (0-lamport session key pays every gameplay
   tx); withdraw settles in ~1 s.
8. **ER slot time (found on devnet, fixed).** The World clock assumed 50 ms slots (local ER);
   devnet ER slots are ~10 ms, so new Worlds ran ~100 s ahead and moves failed `TimeSkew`.
   Fixed: `create_world` takes a measured `us_per_slot_hint`, rates are µs per slot, the rate is
   checked against wall time from the first tick, and the clock may step back until the first
   join. Devnet smoke after the upgrade: 0 `TimeSkew` right after creation, |error| ≤ 351 ms.
   Caveat: Worlds created before the upgrade decode `first_join_ms = 0` (old `_reserved`) and
   ms rates as µs, so they keep stepping back under joined players (recurring short
   `TimeSkew` stalls): do not use them. Future World layout changes should add a
   layout-version byte. Details: `docs/notes/deploy.md`.
