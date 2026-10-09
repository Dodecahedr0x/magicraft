# Magicraft Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (or superpowers:executing-plans) to implement this plan task-by-task.

**Goal:** Build Magicraft — a fully onchain, browser-playable Minecraft-like survival game on MagicBlock Ephemeral Rollups, as specified in `docs/plans/2026-10-09-magicraft-design.md`.

**Architecture:** A pure, deterministic Rust crate (`magicraft-core`) holds all game logic (terrain, fluids, mobs, movement checks, recipes) and is unit-tested without a validator. A thin Anchor program (`magicraft`) wraps it with accounts, ephemeral-account sponsorship, session-key auth, VRF and cranks. A Vite + TypeScript + Three.js client renders chunks read directly from ER accounts.

**Tech Stack:** Rust (Anchor 1.0.x, `ephemeral-rollups-sdk` 0.17.x with `anchor,vrf` features, `session-keys` 3.x, `magicblock-magic-program-api` 0.14.x), TypeScript (Vite, Three.js 0.186, `@anchor-lang/core` 1.0 (Anchor 1.x's rename of `@coral-xyz/anchor`), `@solana/web3.js` 1.x, `@magicblock-labs/ephemeral-rollups-sdk`; session-key ixs hand-built, no `@magicblock-labs/gum-sdk`), Vitest, Mocha (anchor test), `@magicblock-labs/ephemeral-validator` for local ER.

**Ground rules for every task**
- Read the design doc first. It is the source of truth; if a task conflicts with it, stop and report.
- TDD: write failing test → see it fail → implement → see it pass → commit.
- Commit after each task with a conventional message (`feat:`, `test:`, `chore:`, `docs:`). No attribution lines.
- If a dependency version doesn't compile with Anchor 1.0.1, pick the nearest compatible set and record it in `docs/notes/versions.md`.
- Spike findings go into `docs/notes/spikes.md` (append, with date, what was tried, result, decision).

**Repository layout (target)**

```
Anchor.toml
Cargo.toml                      # workspace
crates/core/                    # magicraft-core (pure logic, no anchor dependency)
  src/{lib,consts,hash,noise,blocks,items,coords,terrain,caves,fluid,physics,mobs,recipes,inventory}.rs
programs/magicraft/             # Anchor program
  src/{lib,state,errors,auth,sponsor}.rs
  src/instructions/{player,world,chunk,play,crank}.rs
tests/                          # anchor integration tests (ts-mocha)
scripts/local-er.sh             # start validator + ephemeral validator + vrf oracle
app/                            # Vite client
docs/plans, docs/notes
```

---

## Phase 0 — Scaffold and spikes

### Task 1: Workspace scaffold

**Files:** Create `Anchor.toml`, `Cargo.toml`, `crates/core/Cargo.toml`, `crates/core/src/lib.rs`, `programs/magicraft/{Cargo.toml,src/lib.rs}`, `package.json`, `tsconfig.json`, `.gitignore`, `docs/notes/versions.md`.

**Steps**
1. `anchor init`-equivalent by hand in the repo root (repo already exists; do not nest). Program name `magicraft`. Workspace members: `programs/*`, `crates/*`.
2. `crates/core`: `#![cfg_attr(not(test), no_std)]` is NOT required; plain std crate, no deps besides none. Add a trivial `pub fn version() -> u32 { 1 }` and a test asserting it.
3. Program deps: `anchor-lang = "1.0.1"` (match CLI), `ephemeral-rollups-sdk = { version = "0.17", features = ["anchor", "vrf"] }`, `session-keys = { version = "3", features = ["no-entrypoint"] }`, `magicblock-magic-program-api = "0.14"`, `bincode = "1"`, `magicraft-core = { path = "../../crates/core" }`.
4. Program `lib.rs`: `#[ephemeral]` on the `#[program]` module, one `ping` ix.
5. Run `cargo test -p magicraft-core` → PASS. Run `anchor build` → success. If dependency conflicts arise, resolve (pin versions / patch) and document in `docs/notes/versions.md`.
6. `.gitignore`: `target/`, `node_modules/`, `test-ledger/`, `.anchor/`, `app/dist/`.
7. Commit `chore: scaffold anchor workspace`.

### Task 2: Local ER harness

**Files:** Create `scripts/local-er.sh`, `tests/helpers/env.ts`, `tests/00-harness.spec.ts`, update `Anchor.toml` (`[scripts] test`), `package.json`.

**Steps**
1. Read https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/local-development.md and record the exact commands for: `solana-test-validator` with the delegation program / magic program / VRF program / session program cloned or loaded; the `ephemeral-validator` (npm `@magicblock-labs/ephemeral-validator`) pointed at it; the local VRF oracle.
2. `scripts/local-er.sh up|down` starts/stops all of the above, waits for both RPCs (base `http://127.0.0.1:8899`, ER `http://127.0.0.1:7799` or whatever docs specify) to respond.
3. `tests/helpers/env.ts` exports `baseConn`, `erConn`, `provider`, `erProvider`, `program`, `erProgram`, `airdrop(pk, sol)`.
4. `tests/00-harness.spec.ts`: calls `ping` on base layer and asserts success; asserts ER `getSlot()` > 0.
5. Run: `scripts/local-er.sh up && anchor test --skip-local-validator` → PASS.
6. Commit `test: local ephemeral rollup harness`.

### Task 3: Spike — Player sponsor + 16.8 KB ephemeral chunk

**Files:** Modify program (`state.rs`, `instructions/player.rs`, a temporary `spike_chunk` ix); `tests/01-spike-chunk.spec.ts`; `docs/notes/spikes.md`.

**Steps**
1. Implement `init_player` (base layer, `Player { authority, bump }` PDA `["player", authority]`), `deposit(lamports)` (system transfer wallet → PDA), `delegate_player` (`#[delegate]` macro, `delegate_pda` with seeds). Follow https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/quickstart.md.
2. Implement `spike_chunk(cx: i32, cz: i32)` using `#[ephemeral_accounts]` with `#[account(mut, sponsor, seeds=[b"player", authority], bump)] player` and `#[account(mut, eph, seeds=[b"chunk", ...], bump)] chunk: AccountInfo`. Call `create_ephemeral_chunk(16_384 + 512)`.
3. Test: init+deposit 0.05 SOL+delegate on base; on ER call `spike_chunk(0,0)`; fetch account from ER; assert `data.len() == 16_896`; assert Player lamports decreased by `(16_896 + 60) * 32`.
4. If creation > 10 KB fails, try create at 10_240 then `resize_ephemeral_chunk(16_896)` in a second ix; record which works.
5. Also measure CU (from tx logs) of writing all 16 384 bytes in one ix.
6. Write findings to `docs/notes/spikes.md`. Commit `spike: ephemeral chunk sponsorship`.

### Task 4: Spike — crank on ephemeral accounts + cancel/reschedule

**Files:** Program temporary `spike_tick`, `spike_schedule(task_id, interval, iterations)`, `spike_cancel(task_id)`; `tests/02-spike-crank.spec.ts`; `docs/notes/spikes.md`.

**Steps**
1. Read https://docs.magicblock.gg/pages/tools/crank/implementation.md and the `magicblock-magic-program-api` crate source for `ScheduleTask`/`CancelTask` (find the exact enum variants/import paths).
2. `spike_tick` increments a u64 at a fixed offset in the spike chunk account.
3. Test: schedule 100 ms × 10 iterations; wait 2 s; counter == 10. Schedule again 100 ms × 1000; cancel after 500 ms; counter stops growing.
4. Determine: who pays for scheduled executions, whether the payer may be a PDA (signing via seeds), whether `task_id` must be unique per payer.
5. Record findings; commit `spike: crank scheduling`.

### Task 5: Spike — VRF in ER and session keys in ER

**Files:** Program temporary `spike_vrf`, `spike_vrf_callback`, `spike_session_ping`; `tests/03-spike-vrf-session.spec.ts`; `docs/notes/spikes.md`.

**Steps**
1. VRF: follow https://docs.magicblock.gg/pages/verifiable-randomness-functions-vrfs/how-to-guide/quickstart.md, use `DEFAULT_EPHEMERAL_TEST_QUEUE` locally. Callback (`#[vrf_callback]`) writes 32 bytes into the spike chunk. Test: request on ER, poll ≤ 10 s, bytes non-zero.
2. Session: read https://docs.magicblock.gg/pages/tools/session-keys/integrating-sessions-in-your-program.md. `spike_session_ping` uses `#[derive(Session)]` + `#[session_auth_or(...)]`. Test: create session token on base layer for the program with a fresh keypair (top-up 0.01 SOL); sign `spike_session_ping` on ER with the session keypair; PASS. Note whether the ER charges fees to the session signer and whether the session token must be cloned/delegated.
3. Record; commit `spike: vrf and session keys in ER`.

### Task 6: Remove spike code, finalize decisions

**Steps**
1. Update the design doc's "Open risks" with resolved answers (link `docs/notes/spikes.md`).
2. Delete spike instructions and spike tests (keep helpers). `anchor build` passes.
3. Commit `chore: remove spikes, record decisions`.

Done: spike findings are folded into the design doc and Tasks 15–28 below. Kept: `init_player`,
`deposit`, `delegate_player`, `errors.rs` (`MagicraftError`, offset 6100), `tests/01-player.spec.ts`,
`tests/helpers/{env,session,player}.ts`. Program deps `magicblock-magic-program-api` 0.14 + `bincode`
stay for cranks. The spike code is in git history (commits `spike: …`) as reference for the
`ScheduleTask`/`CancelTask` CPI, ephemeral create/resize/close, VRF with a PDA payer, and commit.

---

## Phase 1 — Pure core (crates/core), TDD with `cargo test -p magicraft-core`

All arithmetic is integer. No floats in core (determinism across platforms). Positions are `i32` fixed-point, `FP = 256` per block.

### Task 7: Constants, coords, blocks, items

**Files:** `crates/core/src/{consts,coords,blocks,items}.rs`, tests inline (`#[cfg(test)]`).

- `consts`: `CHUNK_W = 16`, `CHUNK_H = 64`, `CHUNK_VOL = 16384`, `SEA_LEVEL = 28`, `FP = 256`.
- `coords`: `block_index(lx, y, lz) -> usize = (y * 16 + lz) * 16 + lx`; `world_to_chunk(x) -> (cx, lx)` with floor division for negatives; `chunk_origin(cx)`.
- `blocks`: `#[repr(u8)] enum Block` with every block from the design (Air=0, …, Water=WATER_SOURCE, WATER_1..=WATER_7 contiguous). Fns: `is_solid`, `is_fluid`, `water_level(b) -> Option<u8>` (source = 0), `hardness_ms(b)`, `required_tool(b) -> (ToolKind, Tier)`, `drop(b) -> Option<(Item, u8)>`.
- `items`: `#[repr(u16)] enum Item` (all blocks as items with `Item::from_block`, tools × tiers, materials, foods, drops). `max_stack`, `max_durability`, `food_value`, `tool_info -> Option<(ToolKind, Tier, damage)>`.

Tests (write first): negative coord floor (`world_to_chunk(-1) == (-1, 15)`), `block_index` bounds, every `Block` with `is_solid` sanity (air/water not solid), stone needs wood pickaxe, diamond ore needs iron pickaxe, bedrock unbreakable (`hardness_ms == u32::MAX`), tools have durability, foods have food value.

Commit `feat(core): blocks, items, coords`.

### Task 8: Hash and value noise

**Files:** `crates/core/src/{hash,noise}.rs`.

- `hash`: `fn h64(seed: &[u8;32], a: i64, b: i64, c: i64, salt: u32) -> u64` — splitmix64/wyhash-style mixing over seed words; `fn rand_range(h, lo, hi)`.
- `noise`: `fn value_noise_2d(seed, x, z, cell: i32, salt) -> i32` returning 0..=1024 using bilinear interpolation of lattice hashes with smoothstep in integer math; `fn fbm_2d(seed, x, z, octaves, base_cell, salt) -> i32`.

Tests: determinism (same input same output), different salts differ, range bounds over a 256×256 sweep, continuity (|n(x)-n(x+1)| ≤ 1024/cell*2 roughly — assert a concrete bound you derive), negative coords work.

Commit `feat(core): integer hash and value noise`.

### Task 9: Terrain stage 1 — biomes, heightmap, column fill

**Files:** `crates/core/src/terrain.rs`.

- `enum Biome { Plains, Forest, Desert, Snowy, Mountains }`, `fn biome_at(seed, x, z) -> Biome` from temperature/moisture fbm.
- `fn height_at(seed, x, z) -> i32` with per-biome amplitude/base, blended by averaging biome params over a 5×5 column neighborhood (stride 4 to stay cheap).
- `fn generate_stage1(seed, cx, cz, out: &mut [u8; CHUNK_VOL])`: bedrock y=0, stone, 3 dirt (sandstone under sand in desert), surface (grass/sand/snow/stone in mountains; snow above y=50), water to SEA_LEVEL (ice on surface in Snowy).

Tests: determinism; y=0 all bedrock; no floating air below surface in stage 1; sea columns have water up to SEA_LEVEL; desert columns have sand surface; heights within 1..CHUNK_H-8; seam test: `height_at` across chunk border equals what each chunk computes (it's a pure fn of world coords — assert generating chunk (0,0) and (1,0) gives column x=15 / x=16 heights consistent with `height_at`).

Add a `#[test] #[ignore] fn bench_stage1` printing duration (CU is measured in Task 17).

Commit `feat(core): biomes and heightmap`.

### Task 10: Terrain stage 2 — caves, ores, trees, cactus, animals

**Files:** `crates/core/src/caves.rs`, extend `terrain.rs`.

- `caves::worms_for_chunk(seed, cx, cz) -> impl Iterator<Item = Sphere>`: 0–2 worms, 20–40 segments, radius 1–3, direction drift via hash.
- `fn generate_stage2(seed, cx, cz, blocks: &mut [u8; CHUNK_VOL]) -> Vec<MobSpawn>`: for each of 9 neighbor chunks replay worms and carve local voxels (skip bedrock; skip any voxel with a water neighbor); ore clusters (counts/depths from design); trees (forest dense, plains sparse) and cactus (desert) replayed from 3×3 neighborhood, writing only local voxels; animals 0–3 in grass biomes on surface.
- Requires the stage-1 heights of neighbor columns for trees: compute via `height_at` (pure), don't read neighbor accounts.

Tests: **order independence** — generate a 3×3 region chunk-by-chunk in two different orders, compare all blocks; caves exist (some air below surface in a 4×4 region for a fixed seed); no carved voxel adjacent to water; diamond only y<12; tree log continuity across a border for a seed where a tree straddles (search seeds in test until found, assert found within 1000).

Commit `feat(core): caves, ores, trees, animals`.

### Task 11: Fluids

**Files:** `crates/core/src/fluid.rs`.

- `struct FluidQueue { buf: [u16; 64], head: u8, len: u8 }` storing local block index; `push` dedups, drops when full (returns false).
- `trait BlockAccess { fn get(&self, x,y,z) -> u8; fn set(&mut self, x,y,z, b) }` in world coordinates over a center chunk + 4 neighbors (missing neighbor → treat as solid stone, never write).
- `fn step(world: &mut impl BlockAccess, q: &mut FluidQueue (center), neighbor_queues, budget: u32) -> u32` implementing: flow down; else spread sideways with level+1 ≤ 7; 2+ adjacent sources over solid → new source; unsupported flow recedes; enqueue neighbors of every change (cross-border into neighbor queues).

Tests: water above air falls to floor; source on flat floor spreads to radius 7; two sources fill a 1-gap; removing source makes flow recede to air after enough steps; flow crosses chunk border into neighbor; queue full returns false; budget respected.

Commit `feat(core): flowing water`.

### Task 12: Movement validation

**Files:** `crates/core/src/physics.rs`.

- `struct WorldParams` (all fields from design, fixed-point where needed) with `fn validate(&self) -> Result<(), ParamError>` (ranges) and `Default`.
- `struct MoveState { pos: [i32;3], vel: [i32;3], on_ground: bool, fall_start_y: i32, last_ms: i64, in_water: bool }`.
- `fn check_move(params, prev: &MoveState, new_pos, new_vel, on_ground, now_ms, blocks: &impl BlockAccess) -> Result<MoveOutcome, MoveError>` where `MoveOutcome { fall_damage: u8, state: MoveState }`. Rules: horizontal speed ≤ (sprint or swim if in water) × dt × 1.25 tolerance + 0.25 block; vertical ≤ max_fall_speed × dt + jump allowance; AABB 0.6×1.8×0.6 must not overlap solid; `on_ground` claim requires a solid block within 0.05 below feet; fall damage `max(0, fall_start_y − y − 3 blocks)` when landing and `params.fall_damage`; water landing → 0.

Tests: standing still OK; walking at walk_speed OK; 3× sprint rejected (`MoveTooFast`); moving into stone rejected (`Collision`); claiming on_ground over air rejected; falling 10 blocks deals 7; falling into water deals 0; fall_damage disabled → 0; params.validate rejects speed 0 and 1000.

Commit `feat(core): movement validation`.

### Task 13: Mobs

**Files:** `crates/core/src/mobs.rs`.

- `#[repr(C)] struct Mob { kind: u8, hp: u8, flags: u8, _pad: u8, pos: [i32;3], dir: u8, cooldown_ms: u16, ... }` fixed size (document size), `MOB_SLOTS = 8`.
- `struct Target { pos: [i32;3], idx: u16 /* presence entry */ }`.
- `fn step_mob(seed, tick, mob, world: &impl BlockAccess, targets: &[Target], params, is_day, dt_ms) -> MobEvent` where `MobEvent::{None, Moved, DamagePlayer{idx, dmg}, Died, CrossedBorder(dx,dz)}`. Passive: random wander, step-up 1, refuse drop > 3. Zombie: chase nearest target ≤ 16 blocks, contact (≤ 1 block) → damage 3 every 1000 ms; burn on surface by day (hp−1 per second).
- `fn try_spawn_zombie(seed, tick, cx, cz, blocks, targets, is_night, count, cap) -> Option<Mob>`: candidate from hash, needs ≥ 8 blocks from all targets, solid floor + 2 air, no torch within 4, (night or below surface).

Tests: pig never walks off a 5-block cliff over 1000 steps; pig climbs 1-block step; zombie approaches target monotonically on flat ground; zombie deals damage when adjacent and respects cooldown; zombie burns by day on surface but not underground; spawn respects distance and torch rule; deterministic given same inputs.

Commit `feat(core): mob AI`.

### Task 14: Inventory and recipes

**Files:** `crates/core/src/{inventory,recipes}.rs`.

- `#[repr(C)] struct Slot { item: u16, count: u8, _pad: u8, durability: u16 }`, `struct Inventory { slots: [Slot; 36] }`: `add(item, n) -> u8 leftover` (stacks then empty), `remove_at(slot, n)`, `count(item)`, `take(item, n) -> bool`, `damage_tool(slot)`.
- `recipes`: `enum Station { None, Table, Furnace }`, `struct Recipe { inputs: &'static [(Item, u8)], output: (Item, u8), station }`, `const RECIPES: &[Recipe]` covering planks, sticks, crafting table, furnace, torches, all tools × tiers, glass (smelt sand), iron ingot (smelt ore), cooked foods, iron block. Furnace recipes require 1 fuel (coal or planks) per item. `fn craft(inv, recipe_id, count) -> Result<(), CraftError>` is atomic (no partial).

Tests: add stacks to 64; overflow returns leftover; craft planks from log; craft wooden pickaxe; insufficient inputs leaves inventory unchanged; smelt iron consumes fuel; tool breaks at 0 durability (slot cleared).

Commit `feat(core): inventory and recipes`.

---

## Phase 2 — Anchor program

Use `magicraft-core` for all logic; the program only (de)serializes, authorizes, sponsors, and schedules. Use zero-copy (`#[account(zero_copy)]` or manual byte layout) for `Chunk` — the 16 KB array must not be Borsh-deserialized each call. Ephemeral accounts are `AccountInfo` (per docs); write a manual header layout with `bytemuck`.

Spike-derived rules (see design doc and `docs/notes/spikes.md`; the spike code is in git history, `git show 965c661:programs/magicraft/src/instructions/spike.rs` and, for a chunk-PDA crank authority, `git show d6dfb8a:programs/magicraft/src/instructions/spike.rs`):
- Create/resize/close ephemeral accounts with `ephemeral_rollups_sdk::ephemeral_accounts::EphemeralAccount` directly (sponsor = `Account<Player>` with `mut, seeds, bump = player.bump, has_one = authority`; signer seeds from `player.bump` / `ctx.bumps.*`; declare `#[account(address = EPHEMERAL_VAULT_ID)] vault` and `magic_program` yourself). Not `#[ephemeral_accounts]`: its generated methods can't use `#[instruction]` args in seeds.
- Accounts > 10 240 bytes: create at ≤ 10 240, resize in a second top-level ix (same tx OK).
- Program errors: one `#[error_code(offset = 6100)] MagicraftError` in `errors.rs`; 6000–6003 belong to `session_keys::SessionError`.
- Chunk readiness: only `grow_chunk` (needs `gen_stage == 0` and length 10 240), `populate_chunk` (needs `gen_stage == 1`) and `close_chunk` accept unfinished chunks; every other ix rejects a chunk not at full size and `DONE` with `ChunkNotReady` (cranked ticks no-op instead).
- Tests use `sendEr` (polls `getSignatureStatuses`) for ER txs and `tests/helpers/player.ts` (`setupPlayer`, `waitForEr`, `until`) for setup.

### Task 15: State, errors, auth helpers, Player lifecycle

**Files:** `programs/magicraft/src/{state,errors,auth}.rs`, `instructions/player.rs`, extend `tests/01-player.spec.ts`.

- `state.rs`: `Player`, `WorldHeader` (+`WorldParams` mirror with `From<core::WorldParams>`), `ChunkHeader` (payer, cx, cz, edited, gen_stage, task_id, tick state, FluidQueue, mobs[8]) + `CHUNK_BLOCKS_OFFSET`, `PresenceEntry { player, pos, last_seen_ms, pending_damage }`, `PlayerState` (MoveState + health + food + Inventory + cooldowns). Byte-layout helpers `chunk_header_mut(&AccountInfo)`, `chunk_blocks_mut`.
- `errors.rs`: extend `MagicraftError` (offset 6100) with all codes from design.
- `Player`: add `open_chunks: u32` out of `_reserved` (incremented by `create_chunk`, decremented by `close_chunk`), **for UI warnings only**. `withdraw` is never blocked: rent of edited chunks stays locked by design, and unedited chunks open at undelegation can only be closed after re-delegation.
- Instructions: `init_player`, `deposit` (initial funding only, before delegation), `delegate_player` (exist), `withdraw` (on ER: commit+undelegate via `ephem::commit_and_undelegate_accounts`, only `magic_context`/`magic_program` extra; then base-layer `withdraw_base(lamports)` keeping rent-exempt min). No top-up ix: top-ups are the client-side `lamportsDelegatedTransferIx` (npm SDK, e-SPL). Settlement is delta-based: base = base + ER delta since last commit.
- Test: full lifecycle on local ER: init+deposit+delegate (one tx) → top-up with `lamportsDelegatedTransferIx` (fresh 32-byte salt; locally fund the e-SPL rent PDA `["rent"]` of `SPLxh1…` with 1 SOL first) → ER balance +amount within ~1 s → withdraw → base balance = deposit + top-up − ER spend, minus fees. Withdraw with an open chunk succeeds (once Task 17 exists). `deposit` on a delegated Player fails (already covered in `01-player.spec.ts`).

Commit `feat(program): player lifecycle`.

### Task 16: Worlds + VRF seed + day crank

**Files:** `instructions/world.rs`, `instructions/crank.rs` (day part), `tests/11-world.spec.ts`.

- `create_world(nonce: u64, name: [u8;32], params: WorldParams)` (ER, session-auth, sponsor = Player): eph `World` PDA `["world", player.authority, nonce]` created via `EphemeralAccount` (keep `World` ≤ 10 240 bytes so one ix suffices; store creator, nonce and bump so it can sign); validate params; seed zeroed, `seed_set = false`.
- `request_seed` (`#[vrf]`, `oracle_queue` constrained `address = DEFAULT_EPHEMERAL_QUEUE`, with a cargo feature switching to `DEFAULT_EPHEMERAL_TEST_QUEUE` for localnet). Payer = the creator's delegated Player PDA: build with `create_request_randomness_ix` (the scoped request in 0.17.3; `accounts_metas` = World writable) and call `invoke_signed` yourself with account infos `[player, program_identity, oracle_queue, system_program, slot_hashes]` and **both** seed sets (`["identity", bump]` and the Player seeds). Don't use `invoke_signed_vrf` (identity seed only) or the legacy builders.
- `callback_seed(randomness)` (`#[vrf_callback]`; `vrf_program_identity` is injected as the first account): typed `Account<World>` with seeds/bump, `require!(!world.seed_set)`, copy the 32 bytes, nothing else (≈ 260k CU available; no generation here).
- `schedule_day_crank` → `tick_day(world)` every 1000 ms with large iteration count. ScheduleTask CPI (`magicblock-magic-program-api` 0.14 `MagicBlockInstruction::ScheduleTask`, bincode) with **the World PDA as account 0 / authority**, signed via `invoke_signed` with the World seeds (no Player needed); `task_id` = collision-free id derived from the World PDA (e.g. first 8 bytes of `hash("day" ‖ world)` masked positive, non-zero), stored in `World`. `tick_day` is permissionless (no signer), advances `time_of_day` modulo `day_length_secs*1000`, sets `World.last_tick`, and must not return errors on recoverable state (the scheduler drops a task after ~26 s of failures). **Done (Task 16 + review):** `create_world` arms it; `schedule_day_crank` takes the World read-only and is a no-op unless stale (`World::day_crank_stale`, 3 s); re-arming is client-driven (not `move_player`). `request_seed` is payable by any session-authed delegated Player while `!seed_set`; `tick_day` is liveness-only while `!seed_set`. Release builds: `scripts/build-release.sh` (`pnpm test` leaves a `localnet` build in `target/`).
- Tests: invalid params rejected; seed becomes non-zero ≤ 10 s (expect ~110 ms); forged callback signer rejected (`ConstraintAddress`); second callback can't overwrite; `time_of_day` advances; rescheduling the day crank (same id) replaces rather than duplicates (tick rate unchanged).

Commit `feat(program): worlds, vrf seed, day crank`.

### Task 17: Chunks

**Files:** `instructions/chunk.rs`, `tests/12-chunk.spec.ts`.

- `create_chunk(cx, cz)`: requires seed set; adjacency rule (existing neighbor chunk passed as optional account, or `(cx,cz)` == player's current chunk, or world has 0 chunks and `(0,0)`); creates `Chunk` at **10 240 bytes** + `ChunkPresence` (empty, header only) via `EphemeralAccount`, sponsored by Player; writes the header (payer, bump, cx, cz, `gen_stage = 0`); `player.open_chunks += 1`.
- `grow_chunk(cx, cz)`: session-auth for the chunk's payer (`chunk.payer == player`, signer = wallet or session key); requires `gen_stage == 0` **and** data length == 10 240 (a repeated call is rejected, never resized twice); resize `Chunk` to full size (header + 16 384), then `core::terrain::generate_stage1`; `gen_stage = 1`. Sent in the same tx as `create_chunk`, preceded by `ComputeBudgetProgram.setComputeUnitLimit(1_400_000)` (the tx budget is shared by all its ixs). If stage 1 doesn't fit next to the create/resize, move it to its own ix/tx.
- `populate_chunk(cx, cz)`: requires `gen_stage == 1`; own tx with ComputeBudget 1.4M; `generate_stage2`; place animals in mob slots; `gen_stage = DONE`; if `(0,0)` and world spawn unset → compute spawn.
- `close_chunk`: payer only; `!edited`, no mobs, presence empty; cancel the chunk's tick crank (`CancelTask`, authority = the Chunk PDA signing with its seeds); close both via `EphemeralAccount` (rent refunded to the Player on the ER, settles to base on the next commit); `player.open_chunks -= 1`. Requires the payer Player to be delegated.
- Test: generate (0,0) → spawn set; generated bytes equal `magicraft-core` output for the same seed (expose a tiny test-only wasm? simpler: a Rust test binary `crates/core/examples/gen.rs <seed_hex> cx cz` writes blocks to stdout; TS test spawns it and compares); Player ER lamports drop by exactly `(chunk_len + 60) * 32 + (presence_len + 60) * 32`; non-adjacent create rejected; `grow_chunk` twice rejected; `populate_chunk` before `grow_chunk` rejected; a non-`DONE` chunk rejected by other ixs (once they exist); close refunds and decrements `open_chunks`; regenerate identical. **Log CU for every stage (expect ≥ ~7 CU per computed byte, i.e. > 115k for stage 1 alone); if any tx > 1.2M, split further and note.** Note absolute CU varies by ~3k between runs from `find_program_address` bump searches on random keys; prefer stored bumps.

**Done (Task 17):** measured (SBF) tx 1 (create + grow) 604k-632k CU, populate 587k-802k (model
max over 10^6 chunks 1.13M; construction bound ≈ 1.42M), close 17k; no further split. Needed
`overflow-checks = false` for `magicraft-core` in release (stage 1 > 1.4M with checks).
`grow_chunk` and `populate_chunk` are permissionless (grow's sponsor = the chunk's payer
Player); adjacency = a `DONE` edge neighbor passed as `neighbor`, or the world's first chunk
(0,0) (player's-chunk path: TODO Task 18); populate takes the World read-only and the client
then sends the permissionless `set_spawn` (`populate::spawn_point`, block coords); `close_chunk`
ignores passive animals (zombies block). Open risk: populate worst case ≈ 1.42M CU
(theoretical) — follow-up core optimization, no split. Helpers:
`tests/helpers/{world,chunk}.ts`. Details: `docs/notes/spikes.md`.

Commit `feat(program): chunk generation and reclaim`.

### Task 18: Join, presence, move

**Files:** `instructions/play.rs` (join/move), `programs/magicraft/src/presence.rs`, `tests/13-move.spec.ts`.

- Session-auth pattern for all gameplay ixs (verified in the Task 5 spike): `use session_keys::{session_auth_or, Session, SessionError, SessionTokenV2};` (the macro uses `SessionError` unqualified), `#[derive(Accounts, Session)]`, `#[session(signer = signer, authority = player.authority.key())] session_token: Option<Account<'info, SessionTokenV2>>`, `#[session_auth_or(ctx.accounts.player.authority == ctx.accounts.signer.key(), MagicraftError::Unauthorized)]` (the expression must go through `ctx.accounts.…`). `player` is a seeded `Account<Player>` (`seeds = [PLAYER_SEED, player.authority.as_ref()], bump = player.bump`) so the session authority comes from a validated account. The session key signs and pays fees on the ER with 0 lamports. Use `tests/helpers/session.ts` (`createSessionIx`, `revokeSessionIx`, `sessionTokenPda`, `SESSION_ERRORS`) in tests.
- `join_world`: eph `PlayerState` at spawn.
- `move_player(pos, vel, on_ground)`: accounts: world, player_state, chunk(s) for current (and previous if crossed), presence(s); runs `core::physics::check_move` with a `BlockAccess` over passed chunks; applies `pending_damage` from presence entry; hunger; presence add/update/remove (resize via `EphemeralAccount::resize`, sponsor = Player; refunds on shrink); prunes stale entries (≤ 4 per call). Re-arms the current chunk's tick crank if it is stale (Task 20 helper; stub now). Takes the World **read-only** (never re-arms the day crank).
- Tests: valid walk accepted; teleport rejected; walking into stone rejected; crossing a border moves presence entry and rent nets to ~0; stale entry pruned; fall damage applied; session key signer (0 lamports) works; random signer without token → `Unauthorized` (6100); random signer with someone else's token → `InvalidToken` (6001); expired/revoked token rejected.

**Done (Task 18):** `move_player(pos, vel, on_ground, client_ms)` takes the 2×2 `move_window` chunks as optional `chunk00/10/01/11`, `presence` (chunk of the new position) and `old_presence` (when crossing); first move adds the presence entry (not `join_world`); `create_chunk` takes an optional `player_state` (own chunk always creatable). Measured: typical move 14.5k-15.4k CU, crossing 20.2k. Fall damage / death / hunger are unit-tested (`play::apply_vitals`). Task 19 `place_block` must reject overlap with any fresh presence entry's box (not only the placer's); `respawn` must reset `MoveState` (spawn, `last_ms` = chain ms), `cx/cz`; its old presence entry may be left to pruning. Details: `docs/notes/spikes.md`.

Commit `feat(program): join, presence, movement`.

### Task 19: Block edits, crafting, combat, eat, respawn

**Files:** `instructions/play.rs`, `tests/14-actions.spec.ts`.

- `break_block`, `place_block`, `craft`, `attack_mob`, `eat`, `respawn` per design, all delegating to core. Block edits enqueue fluid positions (cross-border to neighbor chunk queues when passed) and set `edited`.
- Tests: punch log → log in inventory; craft planks → table → wooden pickaxe; mine stone with pickaxe gets cobblestone, without gets nothing; out-of-reach rejected; cooldown enforced; place block into own body rejected; respawn only when dead clears inventory and moves to spawn; attack pig until dead → pork in inventory.

**Done (Task 19):** code in `instructions/actions.rs` (not `play.rs`); extra ix `select_slot(slot)` (held tool); `craft(recipe_id, count, table, furnace)` takes optional station positions + `table_chunk`/`furnace_chunk`; `attack_mob(idx)` with `chunk` as an account. `place_block` requires the border-neighbour presences (`remaining_accounts`, see the module docs). Block edits call `crank::maybe_arm_chunk` for every chunk whose fluid queue has work (also neighbours passed as `chunk_n/s/e/w`) — **Task 20** implements it. Measured: break 9.7k-12.3k, place 11.1k, attack 7.7k-8.3k CU. Details: `docs/notes/spikes.md`.

Commit `feat(program): block edits, crafting, combat`.

### Task 20: Chunk tick crank

**Files:** `instructions/crank.rs`, `tests/15-crank.spec.ts`.

- `tick_chunk` accounts `[world, chunk, presence, n,s,e,w chunks, n,s,e,w presences]` (self placeholders allowed). **Permissionless**: no user signer (the only signer the scheduler allows in a cranked ix is the crank-executor PDA `["crank-executor", authority]` of `Crank1111…`; don't require it). Each tick: `fluid::step` (budget 32), step all mobs (move across borders into neighbor free slots; damage → presence entries), zombie spawn attempt, idle detection, `last_tick = now`. Never return an error on recoverable state (missing/closed neighbor, full queue): ~26 s of continuous failures makes the scheduler drop the task silently.
- `arm_chunk_crank(chunk)` helper used by move/edits/spawn/watchdog: CPI `ScheduleTask` with `task_id` derived collision-free from the chunk PDA (stored in `ChunkHeader`; ids are global per validator) and **authority = the Chunk PDA itself** (account 0 of the CPI, writable signer via `invoke_signed` with the chunk seeds; tested: an ephemeral, non-delegated, 0-lamport PDA can schedule, replace and cancel, whoever sends the outer tx). Same authority + same id **replaces** the task, so arming is idempotent and `create_chunk` simply re-arms existing neighbors with the new account list (no cancel). No Player needs to be passed or delegated to arm.
- Watchdog: `move_player` and block edits re-arm the current chunk's crank when work exists and it is **stale** (`last_tick` older than `CRANK_STALE_MS` = 3 s, or never ticked and created > 3 s ago); otherwise no CPI (a replace restarts the timer and executes at once, so unconditional re-arms would let movers drive the tick rate — Task 16 finding). Arm with the Chunk read-only where the ix doesn't write it (`ScheduleTask` accepts a read-only signer at account 0). Exception: `create_chunk` re-arms neighbors unconditionally (account list change). The **day crank watchdog is client-driven** (client sends `schedule_day_crank` when `World.last_tick_ms` is stale; that ix is itself stale-gated); `move_player` never write-locks the World. (A schedule tx succeeding doesn't prove the task runs; `tick_day` has a fixed account list, so it can't watch chunks.)
- Hydra: the SDK marks these Magic-program crank CPIs deprecated in favour of Hydra (not in the local stack). Keep the CPI behind one helper so it can be swapped; re-check before devnet (Task 28).
- Tests: pour water (place source on a flat area) → after 2 s water spread observed; zombie spawned at night (create world with short `day_length_secs`) near a joined player and `pending_damage` grows; idle chunk crank stops; re-arming twice doesn't double the tick rate; a crank stalled by cancelling it directly is re-armed by the watchdog; closing a chunk cancels its crank.

**Done (Task 20):** code in `instructions/crank.rs` (module docs hold the rules). Deviations:
missing neighbors are **placeholders** (center chunk / presence) because the ER rejects a tx
listing a non-existent account writable ("illegally used as writable", checked after execution);
so `ChunkHeader` gained `nbr_mask` (+ stored `presence_bump`, `nbr_bumps`, `arm_tick`) and
`create_chunk` / `close_chunk` take the 4 neighbor slots `chunk_n/s/e/w` (each the neighbor PDA,
writable iff it exists; `create_chunk`'s `neighbor` account is gone, adjacency = any `DONE`
neighbor slot) and re-arm armed neighbors. Interval `min(fluid, mob)` (250 ms), 240 iterations;
idle ticks cancel their own task, busy ones renew every 160 ticks (both CPIs from inside the crank
work, tested); `arm_chunk` (permissionless watchdog) and `debug_cancel_tick` (localnet-only test
hook) added; `break_block` / `place_block` / `populate_chunk` take `magic_program`. Test params
default to no zombies and a 60 s mob tick (`helpers/world.ts`) so older specs stay deterministic.
Measured: tick 5-12k CU (animals, fluid), 12-21k with a zombie and a player (max 44k with a spawn
attempt), cancel 8k, renew 23-31k (crank tx limit 400k); move that arms ≈ +17k. Details:
`docs/notes/spikes.md`.

Commit `feat(program): chunk tick crank`.

### Task 21: End-to-end integration test

**Files:** `tests/99-e2e.spec.ts`.

Full path: wallet → player → delegate → session → create world → VRF → chunk (0,0) → join → move around creating 8 chunks → top up (`lamportsDelegatedTransferIx`) → break/craft/place → water flow → night zombie damage → death → respawn → close the player's unedited chunks → withdraw (assert base balance reflects ER spend). Commit `test: end-to-end gameplay`.

**Done (Task 21):** `pnpm test:e2e` (= `TEST_SPEC=tests/99-e2e.spec.ts scripts/test.sh`; the
Anchor test script honours `TEST_SPEC`). Every gameplay tx is signed and paid by a 0-lamport
session key; the wallet signs only base txs and `withdraw`. The route (tour of ≥ 8 chunks, a
block water flows into, 3 logs, a work spot with ≥ 22 soft blocks) is scouted over reference
blocks; the water break comes before the logs (scout route order). Death: zombies if they get
there first, else a pillar sized from the current health (+2 margin) and a step off. ~90 s.
The night is spent in a fresh chunk; reclaiming is best effort (cave zombies block most visited
chunks — design follow-up in `spikes.md`).
New helpers: `createSession`/`sessionAccounts` (session), `topUp` (player), `creationChain`,
`liveBlocks`, session-signed `createAndGrow` (chunk), `scoutTour`, `fedByWater`,
`scoutWork(..., {fed})` (scout), `mobsIn` (actions), `TxStats` (stats). Numbers:
`docs/notes/spikes.md`.

### Task 21b: Zombie despawn, reclaimable chunks, deterministic zombie tests

**Done:** `core::mobs` despawn (15 s of stepped time with no fresh target within 32 blocks,
`Mob.alone_ms`); `close_chunk` drops mobs (empty presence suffices); localnet hook
`debug_spawn_mob(kind, pos)` (kind 0 clears); shared `helpers/zombie.ts` (`columnNear`,
`chaseUntilHurt` with `pending_damage` attribution); 15-crank: one natural-spawn test (bounded,
fallback chunks), one hook-placed zombie test, a despawn + close-with-zombie test, quiescent idle
test; e2e: hook-placed zombie at night (`DAY_SECS` 120, bounded wait), a fresh chunk created
and closed after respawn (≥ 1 exact-refund close). Notes: `docs/notes/spikes.md`.

---

## Phase 3 — Browser client (`app/`)

### Task 22: Client scaffold + chain layer

**Files:** `app/{package.json,vite.config.ts,index.html,src/main.ts}`, `app/src/chain/{config,connections,program,session,sender,pdas,layout,player}.ts`, `app/src/chain/*.test.ts`.

- Vite + TS strict + Three.js + Vitest. Copy IDL from `target/idl` via a `predev` script.
- `pdas.ts` mirrors all seeds. `layout.ts` decodes `ChunkHeader`, blocks, mobs, presence, `PlayerState` from raw bytes (zero-copy layout) — tests decode fixtures produced by `crates/core/examples/gen.rs` and a hand-built header.
- `sender.ts`: ER tx sender signing with session keypair (also the fee payer; needs 0 lamports on the ER), fire-and-forget, latest-wins coalescing per key (`move`), error-code mapping callback: program errors from the IDL (6100+) plus `SessionError` 6000 `ValidityTooLong`, 6001 `InvalidToken`, 6002 `NoToken`, 6003 `InvalidAuthority` (not in the IDL; copy `SESSION_ERRORS`). Generation txs prepend `ComputeBudgetProgram.setComputeUnitLimit(1_400_000)`. Confirm by polling `getSignatureStatuses` (like `tests/helpers/env.ts` `sendEr`), not `confirmTransaction`. Test with a mocked connection.
- `session.ts`: create/restore/revoke session (keypair in `localStorage`, guarded try/catch) by porting `tests/helpers/session.ts` (hand-built `create_session_v2`/`revoke_session_v2`, `sessionTokenPda`; no gum SDK, which pulls `@coral-xyz/anchor` 0.30). No top-up by default; `valid_until` ≤ now + 7 days.
- `player.ts`: builders for the onboarding tx (`init_player` + `deposit` + `delegate_player`, see `tests/helpers/player.ts`) and top-up via `lamportsDelegatedTransferIx` from `@magicblock-labs/ephemeral-rollups-sdk` (fresh random 32-byte salt per call).
- Commit `feat(app): scaffold and chain layer`.

**Done (Task 22):** pnpm workspace (`pnpm-workspace.yaml`: root + `app`, one lockfile); Vite 8.3.1,
Vitest 5.0.2, TS 5.9.3, three 0.186.1; `vite-plugin-node-polyfills` (Buffer/process/global; the
MagicBlock SDK uses the global `Buffer`), off under Vitest. IDL + types are committed in
`app/src/idl/` and refreshed from `target/` by `scripts/sync-idl.mjs` (pre-dev/build/test).
Cluster addresses come from `VITE_*` env (`chain/config.ts`, defaults = local stack); `idlFor`
rewrites the program id (and accounts pinned to it) and the VRF queue in the IDL. Modules:
`chain/{config,connections,program,pdas,layout,session,sender,player,actions,index}.ts`.
`actions.ts` takes an `Exists` predicate (chunk store) instead of RPC lookups (`fetchExisting`
for the RPC path). `ErSender`: per-key lanes (one in flight, newest waiting wins), shared status
poller, error `kind` (snapback / topup / retry / renewSession / notReady / timeout / send).
Fixture: `app/src/chain/__fixtures__/gen_0_0.bin` (`pnpm -C app fixtures`). Tests in
`tests/helpers` still have their own copies (CJS ts-mocha vs ESM app); not shared yet.
Review follow-ups: builders take a `ChunkView` (`exists` / `ready`); `moveIx` ports
`required_slots` (required ⇒ must be ready, else `ChunkNotReadyError` → sender kind
`notReady`; other ready slots are passed too), break/place pass only the ready neighbors across
touched borders. `MoveArgs.prev` = last **confirmed** position tracked locally; `client_ms` must
strictly increase (`layout.nextClientMs`, `actions.waitClientMs`). Keyed sends time out after
2 s (`timeout` = may still land); kinds `dead`, and `InvalidAuthority`/`ValidityTooLong` →
`renewSession`; custom errors are decoded only for our program's ixs. Production builds require
`VITE_BASE_RPC`, `VITE_ER_RPC`, `VITE_PROGRAM_ID`, `VITE_ER_VALIDATOR`, `VITE_VRF_QUEUE`;
hidden sourcemaps; `vendor`/`three` chunks, the MagicBlock SDK is lazy-loaded (top-ups only).
`src/idl` is only rewritten by `pnpm -C app sync-idl` (dev/build/test just warn on a diff).
`app/src/chain/live.test.ts` (LIVE=1, run by `scripts/test.sh` after the Anchor suite, skip with
`SKIP_APP_LIVE=1`) drives onboarding → session → world → (0,0) → join → border walk → break →
border place through the app code.

### Task 23: Onboarding and world picker UI

**Files:** `app/src/ui/{onboarding,worlds,createWorld,hud}.ts`, `app/src/style.css`.

Wallet connect (Wallet Standard via `@solana/wallet-standard` / injected Phantom/Backpack), create+fund+delegate Player (1 tx), create session (base tx; may share the onboarding tx or follow it; works while the Player is delegated), list worlds (`getProgramAccounts` on ER filtered by World discriminator), create world form with `WorldParams` (defaults prefilled, ranges validated client-side), progress through VRF seed + chunk (0,0) + crank. Top-up button (`lamportsDelegatedTransferIx`, ER balance updates in ~100 ms; show the 300 000-lamport setup charge) and withdraw button (never blocked: shows `open_chunks`, offers to close the player's unedited chunks first, and warns that rent of edited chunks stays locked and that unedited ones left open can only be reclaimed after re-delegating). Commit `feat(app): onboarding and worlds`.

### Task 24: Chunk store, meshing, rendering

**Files:** `app/src/world/{store,mesher.worker,mesher,atlas,renderer}.ts`, `app/src/world/mesher.test.ts`.

Greedy mesher (opaque) + separate water mesh with level heights + cutout for leaves/glass/torch; neighbor-aware face culling; atlas generated procedurally (canvas, 16×16 tiles) so no asset licensing. Store subscribes with `erConn.onAccountChange` per loaded chunk, unsubscribes beyond radius. Auto-creates missing chunks within radius 3 (adjacency order, outward from player) with cost toast. Tests: mesher face counts for single block, two adjacent blocks (shared face culled), water level heights. Commit `feat(app): chunk rendering`.

### Task 25: Player controller and move sync

**Files:** `app/src/player/{physics,controller,sync}.ts`, `app/src/player/physics.test.ts`.

Pointer-lock FPS controls, WASD/space/shift(sprint)/swim, physics in fixed-point-compatible units using `WorldParams`; parity tests reuse the same cases as Task 12 (walking into stone blocked, falls). `sync.ts` sends `move_player` at 8 Hz with chunk/presence accounts, handles `MoveTooFast`/`Collision` by snapping to on-chain `PlayerState`. Commit `feat(app): player controller and sync`.

### Task 26: Interaction, inventory, crafting, HUD

**Files:** `app/src/ui/{hotbar,inventory,crafting,health}.ts`, `app/src/player/interact.ts`.

Voxel raycast (DDA) for target block highlight; left click break (shows cooldown progress), right click place; number keys/scroll hotbar; `E` inventory with recipe list filtered by available inputs/station proximity; health/food bars; death screen with respawn. Commit `feat(app): interaction and HUD`.

### Task 27: Mobs, other players, day/night, water visuals

**Files:** `app/src/world/{mobs,players,sky}.ts`.

Box-model mobs (pig/cow/sheep/zombie) interpolated between account updates; other players from presence entries; sky color + directional light from `time_of_day`; torch point lights (cap nearest 16); click mob → `attack_mob`. Commit `feat(app): mobs, players, day/night`.

### Task 28: Devnet deploy and smoke test

**Files:** `docs/notes/deploy.md`, `app/.env.example`.

**Move pipelining (from Task 22):** the `move` lane sends one tx at a time (next after
confirmation), so the move rate is capped by the ER round trip (fine locally, < 8 Hz if RTT >
125 ms). If devnet RTT is high, pipeline: send the next move before the previous confirms with
`prev` = the last *sent* position and strictly increasing `client_ms`, and on any rejection
snap back to the onchain `PlayerState` and drop the in-flight chain (order is preserved by the
single sender / same signer, but a rejected move invalidates every later one).

Deploy program to devnet (build without the localnet VRF-queue feature); configure ER endpoint (devnet ER from docs) and pin its validator identity in `delegate_player`, VRF ephemeral queue, session program. Before playing, re-check the remaining risks from the design doc: Magic-program crank CPIs vs Hydra; the deployed VRF program's fee exemption for `DEFAULT_EPHEMERAL_QUEUE` (a Player-PDA payer needs it; fallback wallet payer); e-SPL global rent PDA funded (top-ups); ER fees still 0 (session keys with 0 lamports). Run the app (`pnpm -C app dev`), complete the onboarding flow with a devnet wallet, create a world, play 5 minutes; record issues. Commit `docs: devnet deploy notes`.
