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

**`Player`** PDA `["player", authority]` — holds SOL, is the `sponsor` for all ephemeral accounts the
player creates. Created + funded + delegated in one wallet tx. Withdraw = commit + undelegate, then
transfer out on base layer.

### Ephemeral (ER-only)

| Account | Seeds | Contents |
|---|---|---|
| `World` | `["world", creator, nonce]` | name, creator, `seed: [u8;32]` (zero until VRF), `params: WorldParams`, `time_of_day`, `spawn: (x,y,z)`, day-crank task id, chunk count |
| `Chunk` | `["chunk", world, cx, cz]` | payer, `edited`, `gen_stage`, blocks `16×16×64` u8 (16 KB), mob slots (8), fluid queue (ring of 64), tick-crank task id/state |
| `ChunkPresence` | `["presence", chunk]` | growable vec of `{player, pos, last_seen, pending_damage}` (~40 B each), no cap |
| `PlayerState` | `["pstate", world, player]` | pos, vel, `fall_start_y`, health, food, 36-slot inventory `{item:u16,count:u8,durability:u16}`, cooldowns, last move slot/time |

### WorldParams (set at `create_world`, immutable, range-checked)

`walk_speed, sprint_speed, swim_speed, jump_velocity, gravity, max_fall_speed, reach,
attack_cooldown_ms, day_length_secs, fall_damage: bool, hunger: bool, zombie_cap_per_chunk,
mob_tick_ms, fluid_tick_ms`. Client physics reads the same values.

### Presence economics

Entering a chunk resizes `ChunkPresence` up one entry, paid by the entering player's `Player` PDA;
leaving shrinks and refunds to the leaver. Entries with `last_seen` older than ~5 s are ignored by
mobs and pruned by the next mover in that chunk (pruner receives the refund).

### Spawn

Global per world, stored in `World.spawn`. Chunk (0,0) is always the first chunk, created by the
world creator right after the VRF callback; generating it sets spawn above the topmost solid block
nearest its center.

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

Two stages, sent together by the client:
1. `create_chunk(cx, cz)` — allocate (+ resize if the 10 KB limit applies), biome, heightmap, column fill.
2. `populate_chunk` — caves, ores, trees, cactus, ice, animals. Sets `gen_stage = DONE`.

Edits rejected until `DONE`. Creation allowed only adjacent to an existing chunk or the player's
current chunk. Payer = creator's `Player` PDA.

`close_chunk`: payer only, if `!edited`, no mobs, presence empty. Closes `Chunk` + `ChunkPresence`,
refunds rent. Regeneration later yields identical terrain.

## Cranks

- **World day crank** — scheduled at world creation; advances `time_of_day`.
- **Chunk tick crank** — accounts `[world, chunk, presence, N/S/E/W chunks + presences]` (missing
  neighbor = self placeholder; `create_chunk` cancels and reschedules existing neighbors' cranks).
  Each tick: process up to ~32 fluid-queue entries; step mobs; spawn zombies. Runs while fluid work,
  mobs, or fresh presence exist; otherwise lets iterations expire. Re-armed by edits/moves/spawns.

### Fluids

Water source + levels 1–7. Block changes next to water enqueue positions. Flow down first, else
spread sideways with level+1 up to 7; two adjacent sources create a source; unsupported flow
recedes. Each change enqueues neighbors; cross-border writes go to neighbor chunks in the crank.

### Mobs

- Pig, cow, sheep: wander, 1-block step-up, avoid drops > 3.
- Zombie: spawns at night (or underground anytime) near fresh presence, ≥8 blocks away, no torch
  within 4, cap `zombie_cap_per_chunk`; chases nearest fresh player within 16 (own + neighbor
  presence); contact damage 3/s into `pending_damage`; burns on surface by day.
- Mobs may move into a free slot of a neighbor chunk.
- Randomness: `hash(world.seed, chunk, tick)`. VRF only for world seed.

## Instructions

All gameplay ixs: `#[session_auth_or(player.authority == signer.key())]` with `SessionToken`.

- `init_player` / `deposit` / `delegate_player` / `withdraw` (commit + undelegate) — wallet-signed.
- `create_world(name, nonce, params)` → `request_seed` (VRF, ER ephemeral queue) → `callback_seed`
  (`#[vrf_callback]`) → chunk (0,0) → `schedule_day_crank`.
- `join_world` — creates `PlayerState` at spawn, health 20, food 20.
- `move_player(pos, vel, on_ground)` ~8 Hz — speed bound vs elapsed time, AABB collision vs solid
  blocks, fall damage `max(0, fall_start_y − y − 3)` (water cancels), presence update/migration,
  apply `pending_damage`, hunger drain / regen / starvation.
- `break_block(x,y,z)` — reach, hardness/tool-tier cooldown, harvest tier, drop to inventory,
  durability, fluid enqueue, `edited = true`. Bedrock unbreakable.
- `place_block(x,y,z,slot)` — reach, target air/water, face-adjacent, no self-overlap, fluid enqueue.
- `craft(recipe_id, count)` — const recipe table; station (none/table/furnace) verified by position
  within reach; furnace smelting instant with coal/planks fuel.
- `attack_mob(chunk, idx)` — reach 3, cooldown, weapon damage, drops to inventory.
- `eat(slot)`, `respawn` (health 0 → spawn, inventory cleared).
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

## Errors

Specific Anchor codes: `MoveTooFast`, `Collision`, `OutOfReach`, `Cooldown`, `ChunkNotReady`,
`InsufficientSponsorFunds`, `NotAdjacent`, `SeedPending`, `InvalidParams`, `NotDead`, … Client maps:
rejected move → snap back; funds → top-up prompt; cooldown → silent retry; session expiry → renew.

## Testing

- Rust unit tests on pure modules: terrain (determinism, order independence, CU measurement), fluids,
  mob steps, movement validation, recipes.
- Integration: `anchor test` with local validator + local ephemeral validator + local VRF oracle,
  full path from delegation through crank ticks and `close_chunk`.
- Day-one spikes: 16.8 KB ephemeral account creation; per-stage generation CU; crank calling an ix
  with ephemeral accounts; session-key fee model in ER.
- Client: Vitest for meshing and physics parity; manual browser smoke test on devnet + ER.

## Open risks

1. Ephemeral account max size / creation-time realloc limit.
2. Generation CU budget (fallback: more stages).
3. Crank compatibility with ephemeral accounts and rescheduling semantics (cancel by task id).
4. Write contention on hot chunks (movers + crank on same accounts).
5. Durability: ephemeral accounts live only in the ER; worlds are as durable as the ER state.
