//! Mobs: passive animals (pig, cow, sheep) and zombies, stepped by the `tick_chunk` crank.
//!
//! Runs onchain inside the permissionless `tick_chunk` crank (≈ 3 Hz, `mob_tick_ms`), which
//! must never fail, so everything here is total: no panics for any [`Mob`] bytes, targets,
//! chunk coordinates, block bytes or `dt`; all math is `i64` on bounded values or
//! saturating; every loop has a constant bound; no heap, no floats.
//!
//! # Storage
//! Each chunk header holds [`MOB_SLOTS`] = 8 fixed [`Mob`] slots (32 bytes each, zero-copy,
//! layout in [`Mob`]). `kind == 0` is an empty slot. Positions are **world** FP coordinates
//! of the feet (x/z = body center, y = bottom of the feet block, always a multiple of
//! [`FP`] after a step).
//!
//! # Program duties (implemented by the program, not here)
//! **`tick_chunk`** (accounts: world, center chunk + presence, N/S/E/W chunks + presences;
//! all chunks and presences must be passed **writable**, placeholders included, since a
//! mob may cross into any neighbor and hits go to any presence). Per tick, with
//! `tick = chain_ms / mob_tick_ms` (a **global** clock, the same for every chunk in the
//! same period — see [`Mob::last_tick`]), for each non-empty slot of the center chunk:
//! 1. Build a [`MobCtx`]: `cx, cz` = center; `targets` = **fresh** presence entries
//!    (`last_seen` ≤ ~5 s old) of the center + N/S/E/W presences, `pos` = the entry's
//!    world FP feet position, `chunk`/`idx` = which presence and entry; `enter_mask` = bit
//!    `NORTH/SOUTH/EAST/WEST` set for each neighbor that exists **and has a free slot**,
//!    **recomputed before every mob** (an earlier crossing this tick may have filled the
//!    last free slot).
//! 2. Call [`step_mob`], then:
//!    - `ev.hit = Some(h)` → `presence[h.chunk].entries[h.idx].pending_damage += h.dmg`
//!      (saturating);
//!    - `ev.cross != (0, 0)` → copy the 32 bytes into the free slot of that neighbor that
//!      `enter_mask` promised, then clear the source slot (positions are world
//!      coordinates, nothing to convert). Only cross into a slot reserved this way: there
//!      is no "undo", so a failed copy would silently despawn the mob;
//!    - `ev.died` → the slot was already cleared.
//! 3. Then one [`try_spawn_zombie`] call with the **center chunk's** slots (zombie count
//!    and free-slot checks are center-only); put the result into a free center slot.
//!
//! A neighbor that is not enterable is a wall for that tick; mobs never enter diagonal
//! chunks (`|Δcx| + |Δcz| ≤ 1`), so a step moves a mob at most into one orthogonal
//! neighbor.
//!
//! **`attack_mob(chunk, idx)`**: check reach (and the attack cooldown) against the mob's
//! `pos`, then [`damage_mob`]; if it died, roll [`drops`] with a **non-grindable nonce**
//! (e.g. `mob.id` mixed with the slot index and the current time/slot — never something
//! the attacker can retry for a better roll), add the items, then [`Mob::clear`].
//!
//! **New chunks** (`generate_stage2`): seed the [`MobSpawn`]s into slots with
//! [`Mob::from_spawn`].
//!
//! # Body and collision model
//! A mob is a **point column**: it occupies the feet block `(x>>8, y>>8, z>>8)` and the
//! head block above it (2 blocks tall, zero width). Moving is per axis (x then z), crossing
//! at most 2 block boundaries per axis per tick. Entering a neighboring column at feet
//! level `fy`:
//! - feet block solid → **step up** iff the 2 blocks above it are non-solid and so is the
//!   block above the current head (jump headroom); else blocked;
//! - head block solid → blocked;
//! - feet block water → enter (no drop check, water breaks falls);
//! - otherwise **drop**: the first solid block at most [`MAX_DROP`] (3) blocks below the
//!   feet level is the landing (water within 4 blocks also counts as landing); none →
//!   blocked (cliff refusal).
//!
//! A blocked axis clamps the coordinate to the edge of the current block. "Solid" is
//! [`is_solid_u8`] (torches, air and water are passable; unknown bytes are solid).
//!
//! **Settle** (start of every step, handles edits under/around the mob): feet or head in a
//! solid block → pushed up to the first free 2-block gap within 3 blocks (else stays);
//! feet and head in water → float up 1 block per tick (so a mob in deep water bobs to the
//! surface with its head out); feet in air → fall straight down to the first solid block
//! or into water, at most [`MAX_FALL`] (16) blocks per tick (a longer fall, e.g. after the
//! floor was mined out, takes several ticks; ≤ 18 reads; mobs take no fall damage). While
//! still falling the mob can also walk that tick (harmless). Settle never moves a mob
//! sideways: a mob enclosed in solid blocks with no free 2-block gap within 3 blocks above
//! stays where it is (and does not suffocate).
//!
//! In water (feet block water) mobs move at half speed.
//!
//! # Passive (pig, cow, sheep)
//! Random wander at [`PASSIVE_SPEED`] (1 b/s; diagonals × 181/256 per axis). Each tick
//! `h = hash(seed, mob.id, tick)`; with probability 1/16 (≈ every 5 s at 3 Hz), or right
//! after being blocked, it picks a new heading: one of 8 directions (2/3) or idle (1/3).
//!
//! # Zombie
//! - Target: nearest (horizontal) target with `|dx|, |dz|, |dy| ≤ 16` blocks and
//!   horizontal distance ≤ [`CHASE_RANGE`] (16 blocks). Only the first [`MAX_TARGETS`]
//!   targets are considered (presence is uncapped; bounds cost). No target → wanders like
//!   a passive mob at half speed (0.6 b/s).
//! - Chase at [`ZOMBIE_SPEED`] (1.2 b/s) greedily: per axis toward the target without
//!   overshoot (so the distance never increases), stopping at [`STOP_RANGE`] (0.75 block).
//!   Major axis (larger |delta|) first. If the major axis makes no progress, the minor axis
//!   **sidesteps** instead (side kept in [`FLAG_SIDE`]; flipped when the sidestep is blocked
//!   too), which walks around 1-block pillars.
//! - Contact: horizontal distance ≤ 1 block and `|dy| ≤ 1.5` blocks → [`Hit`] of
//!   [`ZOMBIE_DAMAGE`] (3) to that target, at most once per [`ATTACK_COOLDOWN_MS`].
//!   `cooldown_ms` counts down by `dt`; a hit adds 1000 to the (possibly negative) remainder
//!   (no credit when the cooldown was already 0 before this tick), so the long-run rate is
//!   exactly 1 hit/s for any tick period ≤ 1 s
//!   (e.g. 333 ms ticks → hits at ticks 0, 4, 7, 10, …: 10 hits in 30 ticks).
//! - **Despawn** (Minecraft-style, deterministic): every step with no fresh target within
//!   [`DESPAWN_RANGE`] (32 blocks, 3D) adds `dt` to `alone_ms` (any target in range
//!   resets it). "Targets" are the fresh presence entries visible to the tick: the
//!   center chunk's and its 4 side neighbors' (not diagonals), so a player in a diagonal
//!   chunk does not keep a zombie alive even within 32 blocks; at [`DESPAWN_AFTER_MS`] (15 s of stepped time) the slot is cleared
//!   (`died` + `despawned`). Mobs only step while their chunk ticks: a chunk with mobs and
//!   no fresh presence keeps ticking for the rest of its crank iterations (≥ ~20 s after
//!   the last renewal at the default 250 ms interval), so the threshold sits below that;
//!   zombies frozen in a dormant chunk are dropped by `close_chunk` (empty presence) or
//!   despawn once their chunk ticks again with nobody near. Cave zombies spawned by day
//!   next to a passing player therefore don't pile up and hold the cap.
//! - Burning: by day, with feet not in water and **sky-exposed** (no opaque block from the
//!   block above the head up to the world top): `burn_ms += dt`, −1 hp per full 1000 ms;
//!   0 hp → cleared, `died`. Night, shade or water → `burn_ms` resets. Sunlight passes
//!   through transparent blocks (glass, leaves, ice): only opaque solid blocks shade.
//!
//! # Spawning ([`try_spawn_zombie`])
//! Rate gate first: a call only proceeds on ticks where `hash(seed, cx, cz, tick) %`
//! [`SPAWN_GATE`] `== 0` (deterministic, ≈ 1 attempt per chunk per 30 ticks = ~10 s at
//! the default 333 ms mob tick). Then it requires a free center slot, fewer than `cap` (clamped to [`MOB_SLOTS`]) zombies in the
//! **center** chunk's slots, and ≥ 1 target. Up to [`SPAWN_ATTEMPTS`] (4) candidates per
//! call, each `h = hash(seed, cx, cz, tick, a)`: a column of the center chunk (rejected if
//! a mob already stands in that block column) and a start height; scan down ≤
//! [`SPAWN_SCAN`] (16) blocks for a solid floor with 2 non-solid, non-water blocks above.
//! Then: horizontal distance to **every** target ≥ 8 blocks and to **some** target ≤ 24;
//! light: night, or not sky-exposed ([`light_ok_for_spawn`]); finally no torch within 4
//! blocks horizontally (Chebyshev) in the layers from the floor to one above the head
//! (`fy − 1 ..= fy + 2`, 9×9×4 = 324 reads). The torch scan runs at most once per call: a
//! torch hit ends the call (trying the remaining attempts would cost up to 3 more scans,
//! ≈ 35k, which does not fit the tick budget).
//!
//! # Randomness
//! `seed.h64(...)` with per-purpose salts: wander `(id, tick)`, spawn `(cx, cz, tick, a)`,
//! drops `(nonce, kind)`. Mob ids are derived from the spawn position (animals) or the
//! spawn hash (zombies) and survive slot migration.
//!
//! # Day / night
//! [`is_day`]: `t mod len < ⌈len / 2⌉` — the first half of each day cycle is day
//! (`time_of_day = 0` is sunrise). `len == 0` → always day.
//!
//! # Cost (hand count of SBF ops ≈ CU; not measured on SBF yet)
//! A block read through `ChunkNeighborhood` + the `i64` guard here is budgeted at
//! **35 CU** (30–40: range checks, slot select, option check, index math, bounds check,
//! load, palette-flag lookup).
//! - `step_mob`, worst case: guard + validate ≈ 80; settle ≤ 3 + [`MAX_FALL`] = 19 reads;
//!   sky check (zombie by day) ≤ 62 reads; movement: 2 axes (+1 sidestep) × ≤ 2 crossings
//!   × ≤ 7 reads ≈ 42 reads; → ≈ 123 reads ≈ 4.3k; target scan ≤ [`MAX_TARGETS`] 32 × ≈ 25
//!   = 0.8k; wander hash + misc ≈ 0.2k → **≤ ~5.4k**. Typical (grounded, night, few
//!   targets): ≈ 15 reads ≈ 0.5k + 0.3k ≈ **0.8k**.
//! - `try_spawn_zombie`, worst case: slot scans 8 × 4 ≈ 0.3k; 4 attempts × (hash ≈ 40 +
//!   floor scan ≤ 18 reads ≈ 0.6k + targets ≤ 32 × 20 ≈ 0.6k + sky ≤ 62 reads ≈ 2.2k) ≈
//!   14k; one torch box 324 reads ≈ 11.3k → **≤ ~26k**.
//! - Tick: 8 mobs × 5.4k + 26k ≈ **≤ 70k** worst case (< 80k target; the worst cases of
//!   all 8 mobs at once — every zombie sunlit, every mob mid-fall — are not realistic),
//!   typically ≈ 10–20k.
//!
//! `bench_mobs` (ignored; native release, flat world, 8 targets): `step_mob` ≈ 18 ns/call
//! (pig/zombie alternating), `try_spawn_zombie` ≈ 165 ns/call (4 attempts, night). Measure
//! real CU once `tick_chunk` exists.
//!
//! # SBF stack
//! [`Mob`] 32 B, [`MobEvent`] 12 B, [`MobCtx`] ≈ 56 B; `step_mob` / `try_spawn_zombie` are
//! `#[inline(never)]` and hold only scalars plus a `[i64; 3]` (well under 256 B per frame).

use crate::blocks::{is_fluid_u8, is_solid_u8, is_transparent_u8, Block};
use crate::consts::{CHUNK_H, CHUNK_W, FP};
use crate::fluid::{BlockAccess, EAST, NORTH, SOUTH, WEST};
use crate::hash::{mix, rand_range, splitmix_next, Seed};
use crate::items::Item;
use crate::physics::{isqrt, XZ_LIMIT};
use crate::populate::MobSpawn;

/// Mob slots per chunk.
pub const MOB_SLOTS: usize = 8;

/// Empty slot.
pub const KIND_NONE: u8 = 0;
pub const KIND_PIG: u8 = 1;
pub const KIND_COW: u8 = 2;
pub const KIND_SHEEP: u8 = 3;
pub const KIND_ZOMBIE: u8 = 4;

/// [`MobCtx::enter_mask`] with every neighbor enterable (bits `NORTH..=WEST`).
pub const ENTER_ALL: u8 = (1 << NORTH) | (1 << SOUTH) | (1 << EAST) | (1 << WEST);

/// [`Mob::dir`] value for "standing still"; `0..8` index [`DIRS8`].
pub const DIR_IDLE: u8 = 8;
/// Headings `(dx, dz)`: E, SE, S, SW, W, NW, N, NE.
pub const DIRS8: [(i64, i64); 8] = [
    (1, 0),
    (1, 1),
    (0, 1),
    (-1, 1),
    (-1, 0),
    (-1, -1),
    (0, -1),
    (1, -1),
];

/// [`Mob::flags`]: zombie sidesteps toward +minor axis (else −).
pub const FLAG_SIDE: u8 = 1;
/// [`Mob::flags`]: passive mob was blocked last tick (re-pick heading).
pub const FLAG_BLOCKED: u8 = 2;

/// Passive walking speed, FP/s (1 block/s).
pub const PASSIVE_SPEED: i64 = FP as i64;
/// Zombie chase speed, FP/s (1.2 blocks/s).
pub const ZOMBIE_SPEED: i64 = 307;
/// `dt` is clamped to this (bounds per-tick movement to ≤ 1.2 blocks).
pub const MAX_DT_MS: u32 = 1000;
/// Largest drop a mob walks down, blocks.
pub const MAX_DROP: i64 = 3;
/// Zombie notices targets within this horizontal distance, FP.
pub const CHASE_RANGE: i64 = 16 * FP as i64;
/// Zombie stops approaching within this horizontal distance, FP.
pub const STOP_RANGE: i64 = 192;
/// Contact: horizontal distance ≤ this, FP.
pub const CONTACT_RANGE: i64 = FP as i64;
/// Contact: `|dy|` ≤ this, FP (1.5 blocks).
pub const CONTACT_DY: i64 = 384;
/// Damage per zombie hit.
pub const ZOMBIE_DAMAGE: u8 = 3;
/// Minimum time between zombie hits.
pub const ATTACK_COOLDOWN_MS: i64 = 1000;
/// Burning: −1 hp per this much sunlit time.
pub const BURN_INTERVAL_MS: i64 = 1000;
/// A zombie with no fresh target within this 3D distance (FP, 32 blocks) is "alone".
pub const DESPAWN_RANGE: i64 = 32 * FP as i64;
/// A zombie alone for this much stepped time despawns (module docs, "Despawn").
pub const DESPAWN_AFTER_MS: u16 = 15_000;
/// Targets considered per call (cost bound).
pub const MAX_TARGETS: usize = 32;
/// Blocks a mob falls per tick at most (cost bound of settle).
pub const MAX_FALL: i64 = 16;

/// Spawn rate gate: one tick in this many (per chunk, by hash) may try to spawn.
pub const SPAWN_GATE: u64 = 30;
/// Spawn candidates per [`try_spawn_zombie`] call.
pub const SPAWN_ATTEMPTS: u32 = 4;
/// Blocks scanned downward per candidate.
pub const SPAWN_SCAN: i64 = 16;
/// Zombies spawn at least this far from every target, FP.
pub const SPAWN_MIN_DIST: i64 = 8 * FP as i64;
/// ...and at most this far from some target, FP.
pub const SPAWN_MAX_DIST: i64 = 24 * FP as i64;
/// No torch within this horizontal Chebyshev radius of the feet block...
pub const TORCH_RADIUS: i64 = 4;
/// ...in the layers `fy + TORCH_DY_MIN ..= fy + TORCH_DY_MAX` (floor to above the head).
pub const TORCH_DY_MIN: i64 = -1;
pub const TORCH_DY_MAX: i64 = 2;

const SALT_WANDER: u32 = 0x4D_0B_00_01;
const SALT_SPAWN: u32 = 0x4D_0B_00_10;
const SALT_DROPS: u32 = 0x4D_0B_00_20;
const SALT_SPAWN_GATE: u32 = 0x4D_0B_00_30;

/// The spawn rate gate of chunk `(cx, cz)` at `tick` (see [`try_spawn_zombie`]).
pub fn spawn_gate_open(seed: &Seed, tick: u64, cx: i32, cz: i32) -> bool {
    seed.h64(cx as i64, cz as i64, tick as i64, SALT_SPAWN_GATE) % SPAWN_GATE == 0
}

const AIR: u8 = Block::Air as u8;
const STONE: u8 = Block::Stone as u8;
const BEDROCK: u8 = Block::Bedrock as u8;
const TORCH: u8 = Block::Torch as u8;
const H: i64 = CHUNK_H as i64;
const CW: i64 = CHUNK_W as i64;
const FPL: i64 = FP as i64;
/// Highest feet block (head at the top layer).
const MAX_FEET: i64 = H - 2;
/// Block x/z magnitude limit (same world bound as player movement).
const MAX_BLOCK: i64 = XZ_LIMIT as i64 / FPL;

/// One mob slot.
///
/// Byte layout (`repr(C)`, little-endian, no implicit padding, [`Self::SIZE`] = 32):
///
/// | off | field | type | meaning |
/// |---|---|---|---|
/// | 0 | `kind` | u8 | 0 empty, 1 pig, 2 cow, 3 sheep, 4 zombie; other → cleared on step |
/// | 1 | `hp` | u8 | 1..=[`max_hp`]; 0 → cleared on step |
/// | 2 | `flags` | u8 | [`FLAG_SIDE`], [`FLAG_BLOCKED`] |
/// | 3 | `dir` | u8 | passive heading 0..8 ([`DIRS8`]) or [`DIR_IDLE`] |
/// | 4 | `pos` | [i32; 3] | world FP feet position (x, y, z) |
/// | 16 | `id` | u32 | stable random id (wander hash) |
/// | 20 | `cooldown_ms` | u16 | zombie: ms until the next hit is allowed |
/// | 22 | `burn_ms` | u16 | zombie: sunlit ms not yet turned into damage |
/// | 24 | `last_tick` | u8 | stamp of the last [`step_mob`] (`tick % 255 + 1`; 0 = never) |
/// | 25 | `_pad` | u8 | 0 (alignment of `alone_ms`) |
/// | 26 | `alone_ms` | u16 | zombie: ms stepped with no target within [`DESPAWN_RANGE`] |
/// | 28 | `_reserved` | [u8; 4] | 0 |
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mob {
    pub kind: u8,
    pub hp: u8,
    pub flags: u8,
    pub dir: u8,
    pub pos: [i32; 3],
    pub id: u32,
    pub cooldown_ms: u16,
    pub burn_ms: u16,
    /// Stamp of the global tick of the last step (`tick % 255 + 1`, 0 = never), so a mob
    /// that crossed into a chunk is not stepped again by that chunk's tick in the same
    /// period. Requires `MobCtx::tick` to be a global clock.
    pub last_tick: u8,
    pub _pad: u8,
    /// Zombie: time stepped with no fresh target within [`DESPAWN_RANGE`] (saturating);
    /// reaching [`DESPAWN_AFTER_MS`] despawns it.
    pub alone_ms: u16,
    pub _reserved: [u8; 4],
}

const _: () = assert!(core::mem::size_of::<Mob>() == Mob::SIZE);
const _: () = assert!(MOB_SLOTS * Mob::SIZE == 256);

impl Mob {
    /// Size in bytes (see the layout table).
    pub const SIZE: usize = 32;
    /// An empty slot (all zero bytes).
    pub const EMPTY: Mob = Mob {
        kind: KIND_NONE,
        hp: 0,
        flags: 0,
        dir: 0,
        pos: [0; 3],
        id: 0,
        cooldown_ms: 0,
        burn_ms: 0,
        last_tick: 0,
        _pad: 0,
        alone_ms: 0,
        _reserved: [0; 4],
    };

    /// An animal from populate (chunk-local block coordinates), centered on its block.
    /// Kinds other than pig/cow/sheep give [`Mob::EMPTY`]. Positions that don't fit `i32`
    /// saturate (and are cleared by the first [`step_mob`]).
    pub fn from_spawn(s: &MobSpawn, cx: i32, cz: i32) -> Mob {
        if !(KIND_PIG..=KIND_SHEEP).contains(&s.kind) {
            return Mob::EMPTY;
        }
        let (lx, lz) = ((s.x & 15) as i64, (s.z & 15) as i64);
        let bx = cx as i64 * CW + lx;
        let bz = cz as i64 * CW + lz;
        let packed = ((s.x as u64) << 16) | ((s.y as u64) << 8) | s.z as u64;
        let id = mix((((cx as u32 as u64) << 32) | cz as u32 as u64) ^ mix(packed ^ 0x5EED));
        Mob {
            kind: s.kind,
            hp: max_hp(s.kind),
            pos: [
                sat_i32(bx * FPL + FPL / 2),
                sat_i32(s.y as i64 * FPL),
                sat_i32(bz * FPL + FPL / 2),
            ],
            id: id as u32,
            ..Mob::EMPTY
        }
    }

    /// Serializes per the layout table.
    pub fn to_bytes(&self) -> [u8; 32] {
        let mut b = [0u8; 32];
        b[0] = self.kind;
        b[1] = self.hp;
        b[2] = self.flags;
        b[3] = self.dir;
        for i in 0..3 {
            b[4 + 4 * i..8 + 4 * i].copy_from_slice(&self.pos[i].to_le_bytes());
        }
        b[16..20].copy_from_slice(&self.id.to_le_bytes());
        b[20..22].copy_from_slice(&self.cooldown_ms.to_le_bytes());
        b[22..24].copy_from_slice(&self.burn_ms.to_le_bytes());
        b[24] = self.last_tick;
        b[25] = self._pad;
        b[26..28].copy_from_slice(&self.alone_ms.to_le_bytes());
        b[28..32].copy_from_slice(&self._reserved);
        b
    }

    /// Parses per the layout table (any bytes are accepted).
    pub fn from_bytes(b: &[u8; 32]) -> Mob {
        let i32_at = |o: usize| i32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
        let mut reserved = [0u8; 4];
        reserved.copy_from_slice(&b[28..32]);
        Mob {
            kind: b[0],
            hp: b[1],
            flags: b[2],
            dir: b[3],
            pos: [i32_at(4), i32_at(8), i32_at(12)],
            id: u32::from_le_bytes([b[16], b[17], b[18], b[19]]),
            cooldown_ms: u16::from_le_bytes([b[20], b[21]]),
            burn_ms: u16::from_le_bytes([b[22], b[23]]),
            last_tick: b[24],
            _pad: b[25],
            alone_ms: u16::from_le_bytes([b[26], b[27]]),
            _reserved: reserved,
        }
    }

    /// Empties the slot.
    #[inline]
    pub fn clear(&mut self) {
        *self = Mob::EMPTY;
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.kind == KIND_NONE
    }
}

/// Max (and spawn) hp per kind: pig 10, cow 10, sheep 8, zombie 20; 0 for invalid kinds.
pub const fn max_hp(kind: u8) -> u8 {
    match kind {
        KIND_PIG | KIND_COW => 10,
        KIND_SHEEP => 8,
        KIND_ZOMBIE => 20,
        _ => 0,
    }
}

/// A fresh player position a zombie may chase (built by the program from presences).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Target {
    /// World FP feet position.
    pub pos: [i32; 3],
    /// Entry index in that chunk's `ChunkPresence`.
    pub idx: u16,
    /// Presence: 0 center, 1..=4 N, S, E, W (the `fluid` slot constants).
    pub chunk: u8,
}

/// Contact damage to add to a presence entry's `pending_damage`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hit {
    pub chunk: u8,
    pub idx: u16,
    pub dmg: u8,
}

/// What a [`step_mob`] did. Several can happen in one tick (move + hit + cross).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MobEvent {
    /// Position changed.
    pub moved: bool,
    /// The slot was cleared (burnt to death, despawned, hp 0, or invalid state).
    pub died: bool,
    /// The slot was cleared because the zombie was alone too long (also sets `died`).
    pub despawned: bool,
    /// Zombie contact damage dealt this tick.
    pub hit: Option<Hit>,
    /// `(Δcx, Δcz)` of the chunk now holding the mob (one of them 0, each in −1..=1);
    /// `(0, 0)` = still in the center chunk.
    pub cross: (i8, i8),
}

/// Per-tick inputs of [`step_mob`].
pub struct MobCtx<'a> {
    pub seed: &'a Seed,
    /// Global mob tick (`chain_ms / mob_tick_ms`): randomness and the double-step guard.
    pub tick: u64,
    /// The chunk holding the slot.
    pub cx: i32,
    pub cz: i32,
    /// Fresh targets (center + neighbor presences); only the first [`MAX_TARGETS`] count.
    pub targets: &'a [Target],
    pub is_day: bool,
    /// Time since the previous tick; clamped to [`MAX_DT_MS`].
    pub dt_ms: u32,
    /// Bit `1 << NORTH/SOUTH/EAST/WEST` set = that neighbor may receive the mob.
    pub enter_mask: u8,
}

#[inline]
fn sat_i32(v: i64) -> i32 {
    v.clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

/// Block read in `i64` block coordinates: `y < 0` Bedrock, `y ≥ 64` Air, x/z outside
/// `i32` Stone.
#[inline]
fn get<W: BlockAccess + ?Sized>(w: &W, x: i64, y: i64, z: i64) -> u8 {
    if y < 0 {
        BEDROCK
    } else if y >= H {
        AIR
    } else if x < i32::MIN as i64
        || x > i32::MAX as i64
        || z < i32::MIN as i64
        || z > i32::MAX as i64
    {
        STONE
    } else {
        w.get(x as i32, y as i32, z as i32)
    }
}

#[inline]
fn solid<W: BlockAccess + ?Sized>(w: &W, x: i64, y: i64, z: i64) -> bool {
    is_solid_u8(get(w, x, y, z))
}

/// Where a step may go.
struct Frame {
    cx: i64,
    cz: i64,
    enter: u8,
}

impl Frame {
    /// Column `(bx, bz)` is in the center chunk or an enterable orthogonal neighbor, and
    /// within the world bound.
    #[inline]
    fn allowed(&self, bx: i64, bz: i64) -> bool {
        if bx.abs() >= MAX_BLOCK || bz.abs() >= MAX_BLOCK {
            return false;
        }
        let slot = match (bx.div_euclid(CW) - self.cx, bz.div_euclid(CW) - self.cz) {
            (0, 0) => return true,
            (0, -1) => NORTH,
            (0, 1) => SOUTH,
            (1, 0) => EAST,
            (-1, 0) => WEST,
            _ => return false,
        };
        self.enter & (1 << slot) != 0
    }

    /// FP position lies in the center chunk and the world's y range.
    #[inline]
    fn holds(&self, p: &[i64; 3]) -> bool {
        let ox = self.cx * CW * FPL;
        let oz = self.cz * CW * FPL;
        (0..CW * FPL).contains(&(p[0] - ox))
            && (0..CW * FPL).contains(&(p[2] - oz))
            && (0..H * FPL).contains(&p[1])
    }
}

/// New feet y when stepping from column `(ox, oz)` into the adjacent column `(bx, bz)` at
/// feet level `fy`, or `None` if blocked (module docs, "Body and collision model").
fn enter_column<W: BlockAccess + ?Sized>(
    w: &W,
    f: &Frame,
    (ox, oz): (i64, i64),
    (bx, bz): (i64, i64),
    fy: i64,
) -> Option<i64> {
    if !f.allowed(bx, bz) {
        return None;
    }
    let feet = get(w, bx, fy, bz);
    if is_solid_u8(feet) {
        let ok = fy < MAX_FEET
            && !solid(w, bx, fy + 1, bz)
            && !solid(w, bx, fy + 2, bz)
            && !solid(w, ox, fy + 2, oz);
        return if ok { Some(fy + 1) } else { None };
    }
    if solid(w, bx, fy + 1, bz) {
        return None;
    }
    if is_fluid_u8(feet) {
        return Some(fy);
    }
    let mut k = 0;
    while k <= MAX_DROP {
        let y = fy - 1 - k;
        let b = get(w, bx, y, bz);
        if is_solid_u8(b) {
            return Some(y + 1);
        }
        if is_fluid_u8(b) {
            return Some(y);
        }
        k += 1;
    }
    None
}

/// Moves `p` by `delta` FP along `axis` (0 = x, 2 = z), crossing block boundaries via
/// [`enter_column`]. Returns the distance actually moved.
fn move_axis<W: BlockAccess + ?Sized>(
    w: &W,
    f: &Frame,
    p: &mut [i64; 3],
    axis: usize,
    delta: i64,
) -> i64 {
    if delta == 0 {
        return 0;
    }
    let start = p[axis];
    let target = start + delta;
    let mut i = 0;
    // |delta| ≤ 307 FP crosses ≤ 2 boundaries; 4 is a safety bound.
    while i < 4 {
        let c = p[axis] >> 8;
        if c == target >> 8 {
            p[axis] = target;
            break;
        }
        let n = if delta > 0 { c + 1 } else { c - 1 };
        let from = (p[0] >> 8, p[2] >> 8);
        let to = if axis == 0 { (n, from.1) } else { (from.0, n) };
        match enter_column(w, f, from, to, p[1] >> 8) {
            Some(ny) => {
                p[axis] = if delta > 0 {
                    n * FPL
                } else {
                    n * FPL + FPL - 1
                };
                p[1] = ny * FPL;
            }
            None => {
                p[axis] = if delta > 0 {
                    c * FPL + FPL - 1
                } else {
                    c * FPL
                };
                break;
            }
        }
        i += 1;
    }
    (p[axis] - start).abs()
}

/// Moves along heading `(dx, dz)` (each −1..=1) by `step` FP (× 181/256 per axis on
/// diagonals). Returns the total distance moved.
fn walk_p<W: BlockAccess + ?Sized>(
    w: &W,
    f: &Frame,
    p: &mut [i64; 3],
    dx: i64,
    dz: i64,
    step: i64,
) -> i64 {
    let s = if dx != 0 && dz != 0 {
        step * 181 / 256
    } else {
        step
    };
    move_axis(w, f, p, 0, dx * s) + move_axis(w, f, p, 2, dz * s)
}

/// Settles the mob vertically (module docs, "Settle"). Falls at most [`MAX_FALL`]
/// blocks per tick (cost bound); a longer fall continues on the next ticks.
fn settle<W: BlockAccess + ?Sized>(w: &W, p: &mut [i64; 3]) {
    let (x, z) = (p[0] >> 8, p[2] >> 8);
    let mut y = p[1] >> 8;
    let feet = get(w, x, y, z);
    if is_solid_u8(feet) || solid(w, x, y + 1, z) {
        let mut k = 1;
        while k <= 3 && y + k <= MAX_FEET {
            if !solid(w, x, y + k, z) && !solid(w, x, y + k + 1, z) {
                y += k;
                break;
            }
            k += 1;
        }
    } else if is_fluid_u8(feet) {
        if y < MAX_FEET && is_fluid_u8(get(w, x, y + 1, z)) && !solid(w, x, y + 2, z) {
            y += 1;
        }
    } else {
        let mut i = 0;
        while y > 0 && i < MAX_FALL {
            let b = get(w, x, y - 1, z);
            if is_solid_u8(b) {
                break;
            }
            y -= 1;
            i += 1;
            if is_fluid_u8(b) {
                break;
            }
        }
    }
    p[1] = y * FPL;
}

/// No solid block from `fy + 2` (above the head) to the world top.
fn sky_exposed_i<W: BlockAccess + ?Sized>(w: &W, x: i64, fy: i64, z: i64) -> bool {
    let mut y = (fy + 2).max(0);
    while y < H {
        let b = get(w, x, y, z);
        if is_solid_u8(b) && !is_transparent_u8(b) {
            return false;
        }
        y += 1;
    }
    true
}

/// Whether a mob whose feet are in block `(bx, fy, bz)` sees the sky: no opaque block
/// (solid and not transparent: glass, leaves and ice let sunlight through) from the block
/// above its head (`fy + 2`) up to the world top.
pub fn sky_exposed<W: BlockAccess + ?Sized>(w: &W, bx: i32, fy: i32, bz: i32) -> bool {
    sky_exposed_i(w, bx as i64, fy as i64, bz as i64)
}

/// Some target within 3D distance `r` (FP) of `p` (first [`MAX_TARGETS`]).
fn near_any(targets: &[Target], p: &[i64; 3], r: i64) -> bool {
    targets.iter().take(MAX_TARGETS).any(|t| {
        let dx = t.pos[0] as i64 - p[0];
        let dy = t.pos[1] as i64 - p[1];
        let dz = t.pos[2] as i64 - p[2];
        dx.abs() <= r && dy.abs() <= r && dz.abs() <= r && dx * dx + dy * dy + dz * dz <= r * r
    })
}

/// Nearest chaseable target (module docs, "Zombie").
fn nearest<'t>(targets: &'t [Target], p: &[i64; 3]) -> Option<&'t Target> {
    let mut best: Option<(&Target, i64)> = None;
    for t in targets.iter().take(MAX_TARGETS) {
        let dx = t.pos[0] as i64 - p[0];
        let dy = t.pos[1] as i64 - p[1];
        let dz = t.pos[2] as i64 - p[2];
        if dx.abs() > CHASE_RANGE || dz.abs() > CHASE_RANGE || dy.abs() > CHASE_RANGE {
            continue;
        }
        let d2 = dx * dx + dz * dz;
        if d2 > CHASE_RANGE * CHASE_RANGE {
            continue;
        }
        if best.is_none_or(|(_, b)| d2 < b) {
            best = Some((t, d2));
        }
    }
    best.map(|(t, _)| t)
}

/// Zombie movement toward `t` (greedy per axis, sidestep when the major axis is blocked).
fn chase<W: BlockAccess + ?Sized>(
    w: &W,
    f: &Frame,
    mob: &mut Mob,
    p: &mut [i64; 3],
    t: &Target,
    step: i64,
) {
    let dx = t.pos[0] as i64 - p[0];
    let dz = t.pos[2] as i64 - p[2];
    if step <= 0 || dx * dx + dz * dz <= STOP_RANGE * STOP_RANGE {
        return;
    }
    let (a, da, b, db) = if dx.abs() >= dz.abs() {
        (0, dx, 2, dz)
    } else {
        (2, dz, 0, dx)
    };
    let s = if da != 0 && db != 0 {
        step * 181 / 256
    } else {
        step
    };
    let moved = move_axis(w, f, p, a, da.signum() * s.min(da.abs()));
    if moved == 0 {
        let side = if mob.flags & FLAG_SIDE != 0 { 1 } else { -1 };
        if move_axis(w, f, p, b, side * step) == 0 {
            mob.flags ^= FLAG_SIDE;
        }
    } else {
        move_axis(w, f, p, b, db.signum() * s.min(db.abs()));
    }
}

/// Random wander (module docs, "Passive"); also idle zombies at half speed.
fn wander<W: BlockAccess + ?Sized>(
    ctx: &MobCtx,
    w: &W,
    f: &Frame,
    mob: &mut Mob,
    p: &mut [i64; 3],
    step: i64,
) {
    let h = ctx.seed.h64(mob.id as i64, ctx.tick as i64, 0, SALT_WANDER);
    if mob.flags & FLAG_BLOCKED != 0 || h & 31 < 2 || mob.dir > DIR_IDLE {
        let r = rand_range(h, 0, 11) as u8;
        mob.dir = if r < 8 { r } else { DIR_IDLE };
        mob.flags &= !FLAG_BLOCKED;
    }
    if (mob.dir as usize) < DIRS8.len() && step > 0 {
        let (dx, dz) = DIRS8[mob.dir as usize];
        if walk_p(w, f, p, dx, dz, step) == 0 {
            mob.flags |= FLAG_BLOCKED;
        }
    }
}

/// Advances one mob by one crank tick. Total: any bytes in `mob`, any ctx, any world.
/// See the module docs for the rules and the caller's duties.
#[inline(never)]
pub fn step_mob<W: BlockAccess + ?Sized>(ctx: &MobCtx, mob: &mut Mob, world: &W) -> MobEvent {
    let mut ev = MobEvent::default();
    if mob.kind == KIND_NONE {
        return ev;
    }
    let f = Frame {
        cx: ctx.cx as i64,
        cz: ctx.cz as i64,
        enter: ctx.enter_mask,
    };
    let stamp = (ctx.tick % 255) as u8 + 1;
    if mob.last_tick == stamp {
        return ev; // already stepped this period (crossed in from a neighbor's tick)
    }
    mob.last_tick = stamp;
    let mut p = [mob.pos[0] as i64, mob.pos[1] as i64, mob.pos[2] as i64];
    let maxhp = max_hp(mob.kind);
    if maxhp == 0 || mob.hp == 0 || !f.holds(&p) {
        mob.clear();
        ev.died = true;
        return ev;
    }
    mob.hp = mob.hp.min(maxhp);
    let dt = ctx.dt_ms.min(MAX_DT_MS) as i64;
    let old = p;

    settle(world, &mut p);
    let (bx, fy, bz) = (p[0] >> 8, p[1] >> 8, p[2] >> 8);
    let in_water = is_fluid_u8(get(world, bx, fy, bz));
    let zombie = mob.kind == KIND_ZOMBIE;

    if zombie {
        if near_any(ctx.targets, &p, DESPAWN_RANGE) {
            mob.alone_ms = 0;
        } else {
            mob.alone_ms = (mob.alone_ms as i64 + dt).min(u16::MAX as i64) as u16;
            if mob.alone_ms >= DESPAWN_AFTER_MS {
                mob.clear();
                ev.died = true;
                ev.despawned = true;
                return ev;
            }
        }
        if ctx.is_day && !in_water && sky_exposed_i(world, bx, fy, bz) {
            let acc = mob.burn_ms as i64 + dt;
            let n = (acc / BURN_INTERVAL_MS).min(255) as u8;
            mob.burn_ms = (acc % BURN_INTERVAL_MS) as u16;
            mob.hp = mob.hp.saturating_sub(n);
            if mob.hp == 0 {
                mob.clear();
                ev.died = true;
                return ev;
            }
        } else {
            mob.burn_ms = 0;
        }
    }

    let speed = if zombie { ZOMBIE_SPEED } else { PASSIVE_SPEED };
    let mut step = speed * dt / 1000;
    if in_water {
        step /= 2;
    }

    if zombie {
        let target = nearest(ctx.targets, &p);
        match target {
            Some(t) => chase(world, &f, mob, &mut p, t, step),
            None => wander(ctx, world, &f, mob, &mut p, step / 2),
        }
        let mut cd = mob.cooldown_ms as i64 - dt;
        if let Some(t) = target {
            let dx = t.pos[0] as i64 - p[0];
            let dy = t.pos[1] as i64 - p[1];
            let dz = t.pos[2] as i64 - p[2];
            if cd <= 0
                && dy.abs() <= CONTACT_DY
                && dx * dx + dz * dz <= CONTACT_RANGE * CONTACT_RANGE
            {
                ev.hit = Some(Hit {
                    chunk: t.chunk,
                    idx: t.idx,
                    dmg: ZOMBIE_DAMAGE,
                });
                // Carry the overshoot only from a running cooldown: a zombie that was
                // already ready (0) gets no credit for idle time.
                cd = if mob.cooldown_ms == 0 { 0 } else { cd } + ATTACK_COOLDOWN_MS;
            }
        }
        mob.cooldown_ms = cd.clamp(0, u16::MAX as i64) as u16;
    } else {
        wander(ctx, world, &f, mob, &mut p, step);
    }

    ev.moved = p != old;
    mob.pos = [sat_i32(p[0]), sat_i32(p[1]), sat_i32(p[2])];
    let dcx = p[0].div_euclid(CW * FPL) - f.cx;
    let dcz = p[2].div_euclid(CW * FPL) - f.cz;
    ev.cross = (dcx.clamp(-1, 1) as i8, dcz.clamp(-1, 1) as i8);
    ev
}

/// Spawn light rule: night, or a spot that does not see the sky.
#[inline]
pub fn light_ok_for_spawn(is_night: bool, sky_exposed: bool) -> bool {
    is_night || !sky_exposed
}

/// Feet y of the first standing spot at or below `y0` (≤ [`SPAWN_SCAN`] blocks down):
/// solid floor, feet and head neither solid nor water.
fn find_floor<W: BlockAccess + ?Sized>(w: &W, x: i64, z: i64, y0: i64) -> Option<i64> {
    let free = |b: u8| !is_solid_u8(b) && !is_fluid_u8(b);
    let mut head = get(w, x, y0 + 1, z);
    let mut feet = get(w, x, y0, z);
    let mut y = y0;
    while y >= 1 && y > y0 - SPAWN_SCAN {
        let below = get(w, x, y - 1, z);
        if free(feet) && free(head) && is_solid_u8(below) {
            return Some(y);
        }
        head = feet;
        feet = below;
        y -= 1;
    }
    None
}

/// ≥ [`SPAWN_MIN_DIST`] from every target, ≤ [`SPAWN_MAX_DIST`] from some.
fn spawn_distance_ok(targets: &[Target], px: i64, pz: i64) -> bool {
    let mut near = false;
    for t in targets.iter().take(MAX_TARGETS) {
        let dx = (t.pos[0] as i64 - px).abs();
        let dz = (t.pos[2] as i64 - pz).abs();
        if dx > SPAWN_MAX_DIST || dz > SPAWN_MAX_DIST {
            continue; // far: neither too close nor near
        }
        let d2 = dx * dx + dz * dz;
        if d2 < SPAWN_MIN_DIST * SPAWN_MIN_DIST {
            return false;
        }
        near |= d2 <= SPAWN_MAX_DIST * SPAWN_MAX_DIST;
    }
    near
}

/// A torch within [`TORCH_RADIUS`] horizontally (Chebyshev) and `fy - 1 ..= fy + 2`
/// vertically (the floor, the body and one above the head): 9×9×4 = 324 reads.
fn torch_near<W: BlockAccess + ?Sized>(w: &W, x: i64, y: i64, z: i64) -> bool {
    let mut dy = TORCH_DY_MIN;
    while dy <= TORCH_DY_MAX {
        let mut dz = -TORCH_RADIUS;
        while dz <= TORCH_RADIUS {
            let mut dx = -TORCH_RADIUS;
            while dx <= TORCH_RADIUS {
                if get(w, x + dx, y + dy, z + dz) == TORCH {
                    return true;
                }
                dx += 1;
            }
            dz += 1;
        }
        dy += 1;
    }
    false
}

/// Tries to spawn a zombie in chunk `(cx, cz)` (module docs, "Spawning"). `mobs` = the
/// center chunk's slots (zombie count, free slot and occupied columns are checked against
/// them). Returns the new mob for the caller to put into a free center slot. Total for any
/// inputs.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
pub fn try_spawn_zombie<W: BlockAccess + ?Sized>(
    seed: &Seed,
    tick: u64,
    cx: i32,
    cz: i32,
    world: &W,
    targets: &[Target],
    mobs: &[Mob],
    is_night: bool,
    cap: u8,
) -> Option<Mob> {
    let slots = &mobs[..mobs.len().min(MOB_SLOTS)];
    let zombies = slots.iter().filter(|m| m.kind == KIND_ZOMBIE).count();
    let free = slots.len() < MOB_SLOTS || slots.iter().any(Mob::is_empty);
    if !free || zombies >= cap.min(MOB_SLOTS as u8) as usize || targets.is_empty() {
        return None;
    }
    if !spawn_gate_open(seed, tick, cx, cz) {
        return None;
    }
    let ox = cx as i64 * CW;
    let oz = cz as i64 * CW;
    if ox.abs() + CW >= MAX_BLOCK || oz.abs() + CW >= MAX_BLOCK {
        return None;
    }
    let mut a = 0;
    while a < SPAWN_ATTEMPTS {
        let h = seed.h64(
            cx as i64,
            cz as i64,
            tick as i64,
            SALT_SPAWN.wrapping_add(a),
        );
        a += 1;
        let bx = ox + (h & 15) as i64;
        let bz = oz + ((h >> 4) & 15) as i64;
        let y0 = rand_range(h, 1, MAX_FEET as i32) as i64;
        let occupied = slots
            .iter()
            .any(|m| !m.is_empty() && (m.pos[0] >> 8) as i64 == bx && (m.pos[2] >> 8) as i64 == bz);
        if occupied {
            continue;
        }
        let Some(fy) = find_floor(world, bx, bz, y0) else {
            continue;
        };
        let (px, pz) = (bx * FPL + FPL / 2, bz * FPL + FPL / 2);
        if !spawn_distance_ok(targets, px, pz) {
            continue;
        }
        if !is_night && !light_ok_for_spawn(false, sky_exposed_i(world, bx, fy, bz)) {
            continue;
        }
        if torch_near(world, bx, fy, bz) {
            return None;
        }
        return Some(Mob {
            kind: KIND_ZOMBIE,
            hp: max_hp(KIND_ZOMBIE),
            pos: [px as i32, (fy * FPL) as i32, pz as i32],
            id: (mix(h) >> 32) as u32,
            ..Mob::EMPTY
        });
    }
    None
}

/// Applies `dmg` (saturating). Returns `true` if this killed it (hp now 0). The slot is
/// **not** cleared, so the caller can roll [`drops`] from `kind`, then [`Mob::clear`] it
/// (a 0-hp mob left in a slot is cleared by the next [`step_mob`] anyway). Empty slots:
/// no-op, `false`.
pub fn damage_mob(mob: &mut Mob, dmg: u8) -> bool {
    if mob.kind == KIND_NONE || mob.hp == 0 {
        return false;
    }
    mob.hp = mob.hp.saturating_sub(dmg);
    mob.hp == 0
}

/// Loot for killing a mob of `kind`; entries with count 0 give nothing.
/// Pig: raw pork 1–3. Cow: raw beef 1–3, leather 0–2. Sheep: raw mutton 1–2, wool 1.
/// Zombie: rotten flesh 0–2. Other kinds: nothing. Deterministic in `(seed, kind, nonce)`
/// (the program passes e.g. a hash of mob id and slot time).
pub fn drops(kind: u8, seed: &Seed, nonce: u64) -> [(Item, u8); 2] {
    let mut st = seed.h64(nonce as i64, kind as i64, 0, SALT_DROPS);
    let a = splitmix_next(&mut st);
    let b = splitmix_next(&mut st);
    let r = |h: u64, lo: i32, hi: i32| rand_range(h, lo, hi) as u8;
    match kind {
        KIND_PIG => [(Item::RawPork, r(a, 1, 3)), (Item::RawPork, 0)],
        KIND_COW => [(Item::RawBeef, r(a, 1, 3)), (Item::Leather, r(b, 0, 2))],
        KIND_SHEEP => [(Item::RawMutton, r(a, 1, 2)), (Item::Wool, 1)],
        KIND_ZOMBIE => [(Item::RottenFlesh, r(a, 0, 2)), (Item::RottenFlesh, 0)],
        _ => [(Item::RottenFlesh, 0); 2],
    }
}

/// Day = the first half of each cycle: `t mod len < ⌈len / 2⌉` (`t = 0` is sunrise).
/// `len == 0` → always day.
pub fn is_day(time_of_day_ms: u64, day_length_ms: u64) -> bool {
    if day_length_ms == 0 {
        return true;
    }
    time_of_day_ms % day_length_ms < day_length_ms.div_ceil(2)
}

/// Distance a hit pushes a mob back, FP (1.2 blocks).
pub const KNOCKBACK: i64 = 307;

/// Pushes a hit mob [`KNOCKBACK`] FP straight away from `from` (the attacker's feet, FP),
/// horizontally, with the walking collision rules (steps up one block, stops at walls and
/// at the border of its chunk `(cx, cz)`: the mob stays in its slot's chunk), then settles
/// it. No push when the attacker stands on the mob's column center. Returns the distance
/// moved.
pub fn knockback<W: BlockAccess + ?Sized>(
    w: &W,
    cx: i32,
    cz: i32,
    mob: &mut Mob,
    from: [i32; 3],
) -> i64 {
    let dx = mob.pos[0] as i64 - from[0] as i64;
    let dz = mob.pos[2] as i64 - from[2] as i64;
    let len = isqrt(dx * dx + dz * dz);
    if len == 0 {
        return 0;
    }
    let f = Frame {
        cx: cx as i64,
        cz: cz as i64,
        enter: 0,
    };
    let mut p = [mob.pos[0] as i64, mob.pos[1] as i64, mob.pos[2] as i64];
    let moved = move_axis(w, &f, &mut p, 0, dx * KNOCKBACK / len)
        + move_axis(w, &f, &mut p, 2, dz * KNOCKBACK / len);
    settle(w, &mut p);
    mob.pos = [sat_i32(p[0]), sat_i32(p[1]), sat_i32(p[2])];
    moved
}

/// Test hook: moves a mob along a heading as the wander step does.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn walk<W: BlockAccess + ?Sized>(
    w: &W,
    cx: i32,
    cz: i32,
    enter: u8,
    mob: &mut Mob,
    dx: i64,
    dz: i64,
    step: i64,
) -> i64 {
    let f = Frame {
        cx: cx as i64,
        cz: cz as i64,
        enter,
    };
    let mut p = [mob.pos[0] as i64, mob.pos[1] as i64, mob.pos[2] as i64];
    let r = walk_p(w, &f, &mut p, dx, dz, step);
    mob.pos = [sat_i32(p[0]), sat_i32(p[1]), sat_i32(p[2])];
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blocks::{is_fluid_u8, is_solid_u8};
    use crate::hash::splitmix_next;

    const AIR: u8 = Block::Air as u8;
    const STONE: u8 = Block::Stone as u8;
    const GRASS: u8 = Block::Grass as u8;
    const TORCH: u8 = Block::Torch as u8;
    const WATER: u8 = Block::WaterSource as u8;

    /// Test world: chunks -1..=1 on both axes (x, z in -16..32), y in 0..64. Outside x/z
    /// reads Stone, y < 0 Bedrock, y >= 64 Air (like `ChunkNeighborhood`).
    struct W {
        b: Vec<u8>,
    }

    const LO: i32 = -16;
    const SPAN: i32 = 48;

    impl W {
        fn new() -> Self {
            W {
                b: vec![AIR; (SPAN * SPAN * 64) as usize],
            }
        }
        /// Flat ground: solid up to `top` inclusive (feet at `top + 1`).
        fn flat(top: i32) -> Self {
            let mut w = W::new();
            for x in LO..LO + SPAN {
                for z in LO..LO + SPAN {
                    w.column(x, z, top);
                }
            }
            w
        }
        fn column(&mut self, x: i32, z: i32, top: i32) {
            for y in 0..64 {
                let b = if y < top {
                    STONE
                } else if y == top {
                    GRASS
                } else {
                    AIR
                };
                self.put(x, y, z, b);
            }
        }
        fn idx(x: i32, y: i32, z: i32) -> Option<usize> {
            let (fx, fz) = (x as i64 - LO as i64, z as i64 - LO as i64);
            let span = SPAN as i64;
            if (0..span).contains(&fx) && (0..span).contains(&fz) && (0..64).contains(&y) {
                Some(((y as i64 * span + fz) * span + fx) as usize)
            } else {
                None
            }
        }
        fn put(&mut self, x: i32, y: i32, z: i32, v: u8) {
            if let Some(i) = W::idx(x, y, z) {
                self.b[i] = v;
            }
        }
    }

    impl BlockAccess for W {
        fn get(&self, x: i32, y: i32, z: i32) -> u8 {
            if y < 0 {
                return Block::Bedrock as u8;
            }
            if y >= 64 {
                return AIR;
            }
            match W::idx(x, y, z) {
                Some(i) => self.b[i],
                None => STONE,
            }
        }
        fn set(&mut self, _x: i32, _y: i32, _z: i32, _b: u8) -> bool {
            false
        }
    }

    fn seed(tag: u8) -> Seed {
        let mut b = [0u8; 32];
        for (i, v) in b.iter_mut().enumerate() {
            *v = (i as u8).wrapping_mul(29).wrapping_add(tag);
        }
        Seed::new(&b)
    }

    /// FP coordinate of a block center.
    fn c(b: i32) -> i32 {
        b * FP + FP / 2
    }

    fn mob(kind: u8, bx: i32, fy: i32, bz: i32) -> Mob {
        Mob {
            kind,
            hp: max_hp(kind),
            id: 7,
            pos: [c(bx), fy * FP, c(bz)],
            ..Mob::EMPTY
        }
    }

    fn target(bx: i32, fy: i32, bz: i32) -> Target {
        Target {
            pos: [c(bx), fy * FP, c(bz)],
            idx: 3,
            chunk: 0,
        }
    }

    /// Owning chunk of a mob position.
    fn home(m: &Mob) -> (i32, i32) {
        (m.pos[0].div_euclid(16 * FP), m.pos[2].div_euclid(16 * FP))
    }

    struct Sim<'a> {
        seed: Seed,
        tick: u64,
        targets: Vec<Target>,
        is_day: bool,
        dt: u32,
        world: &'a W,
    }

    impl Sim<'_> {
        /// One step with the mob re-homed into whichever chunk holds it (like the program).
        fn step(&mut self, m: &mut Mob) -> MobEvent {
            let (cx, cz) = home(m);
            let ctx = MobCtx {
                seed: &self.seed,
                tick: self.tick,
                cx,
                cz,
                targets: &self.targets,
                is_day: self.is_day,
                dt_ms: self.dt,
                enter_mask: ENTER_ALL,
            };
            self.tick += 1;
            let ev = step_mob(&ctx, m, self.world);
            if !m.is_empty() {
                let (ncx, ncz) = home(m);
                assert_eq!((ncx - cx, ncz - cz), (ev.cross.0 as i32, ev.cross.1 as i32));
            }
            ev
        }
    }

    fn sim(world: &W) -> Sim<'_> {
        Sim {
            seed: seed(1),
            tick: 0,
            targets: vec![],
            is_day: false,
            dt: 333,
            world,
        }
    }

    fn feet(m: &Mob) -> (i32, i32, i32) {
        (m.pos[0] >> 8, m.pos[1] >> 8, m.pos[2] >> 8)
    }

    fn assert_free(w: &W, m: &Mob) {
        let (x, y, z) = feet(m);
        assert!(
            (0..64).contains(&y) && m.pos[1] % FP == 0,
            "bad y {:?}",
            m.pos
        );
        assert!(!is_solid_u8(w.get(x, y, z)), "feet in solid at {:?}", m.pos);
        assert!(
            !is_solid_u8(w.get(x, y + 1, z)),
            "head in solid at {:?}",
            m.pos
        );
    }

    fn hdist2(m: &Mob, t: &Target) -> i64 {
        let dx = (m.pos[0] - t.pos[0]) as i64;
        let dz = (m.pos[2] - t.pos[2]) as i64;
        dx * dx + dz * dz
    }

    // ---------------------------------------------------------------- layout

    #[test]
    fn layout_and_bytes() {
        assert_eq!(core::mem::size_of::<Mob>(), Mob::SIZE);
        assert_eq!(Mob::SIZE, 32);
        let m = Mob {
            kind: 4,
            hp: 17,
            flags: 0x81,
            dir: 5,
            pos: [-123_456, 5 * FP, 0x0102_0304],
            id: 0xDEAD_BEEF,
            cooldown_ms: 999,
            burn_ms: 0x1234,
            last_tick: 77,
            _pad: 3,
            alone_ms: 0x0A0B,
            _reserved: [9; 4],
        };
        let b = m.to_bytes();
        assert_eq!(&b[0..4], &[4, 17, 0x81, 5]);
        assert_eq!(&b[4..8], &(-123_456i32).to_le_bytes());
        assert_eq!(&b[8..12], &(5 * FP).to_le_bytes());
        assert_eq!(&b[12..16], &0x0102_0304i32.to_le_bytes());
        assert_eq!(&b[16..20], &0xDEAD_BEEFu32.to_le_bytes());
        assert_eq!(&b[20..22], &999u16.to_le_bytes());
        assert_eq!(&b[22..24], &0x1234u16.to_le_bytes());
        assert_eq!(b[24], 77);
        assert_eq!(b[25], 3);
        assert_eq!(&b[26..28], &0x0A0Bu16.to_le_bytes());
        assert_eq!(&b[28..32], &[9; 4]);
        assert_eq!(Mob::from_bytes(&b), m);
        assert_eq!(Mob::EMPTY.to_bytes(), [0; 32]);
    }

    #[test]
    fn max_hp_and_from_spawn() {
        assert_eq!(
            [0, 1, 2, 3, 4, 5, 255].map(max_hp),
            [0, 10, 10, 8, 20, 0, 0]
        );
        let s = MobSpawn {
            kind: KIND_COW,
            x: 3,
            y: 30,
            z: 15,
        };
        let m = Mob::from_spawn(&s, -2, 5);
        assert_eq!(m.kind, KIND_COW);
        assert_eq!(m.hp, 10);
        assert_eq!(m.pos, [c(-32 + 3), 30 * FP, c(80 + 15)]);
        assert_eq!(home(&m), (-2, 5));
        // Different spawns get different ids; same spawn the same id.
        let m2 = Mob::from_spawn(&MobSpawn { x: 4, ..s }, -2, 5);
        assert_ne!(m.id, m2.id);
        assert_eq!(m, Mob::from_spawn(&s, -2, 5));
        // Bad kind -> empty slot; extreme chunk does not panic.
        assert!(Mob::from_spawn(&MobSpawn { kind: 9, ..s }, 0, 0).is_empty());
        let _ = Mob::from_spawn(&s, i32::MAX, i32::MIN);
    }

    // ---------------------------------------------------------------- passive movement

    #[test]
    fn pig_never_walks_off_cliff() {
        // Plateau x < 8 with feet at 20; below it feet at 15 (5-block drop).
        let mut w = W::flat(14);
        for x in LO..8 {
            for z in LO..LO + SPAN {
                w.column(x, z, 19);
            }
        }
        let mut reached_edge = 0;
        for s in 0..5u8 {
            let mut sm = sim(&w);
            sm.seed = seed(s);
            let mut m = mob(KIND_PIG, 4, 20, 8);
            m.id = s as u32;
            let start = m.pos;
            let mut moved = false;
            for _ in 0..1000 {
                let ev = sm.step(&mut m);
                moved |= ev.moved;
                assert_eq!(m.pos[1], 20 * FP, "pig fell: {:?}", m.pos);
                assert!(m.pos[0] < 8 * FP);
                assert_free(&w, &m);
                if m.pos[0] >> 8 == 7 {
                    reached_edge += 1;
                }
            }
            assert!(moved && m.pos != start);
        }
        assert!(reached_edge > 0, "pig never reached the cliff edge");
    }

    #[test]
    fn pig_drops_three_but_not_four() {
        for (drop, ok) in [(1, true), (3, true), (4, false)] {
            let mut w = W::flat(20 - drop);
            for x in LO..3 {
                for z in LO..LO + SPAN {
                    w.column(x, z, 20);
                }
            }
            let mut m = mob(KIND_PIG, 2, 21, 0);
            for _ in 0..10 {
                walk(&w, 0, 0, ENTER_ALL, &mut m, 1, 0, 100);
            }
            assert_free(&w, &m);
            if ok {
                assert_eq!(m.pos[1] >> 8, 21 - drop, "drop {drop}");
                assert!(m.pos[0] > 3 * FP);
            } else {
                assert_eq!(m.pos[1] >> 8, 21);
                assert_eq!(m.pos[0], 3 * FP - 1);
            }
        }
    }

    #[test]
    fn pig_climbs_one_block_step_not_two() {
        let mut w = W::flat(10);
        for x in 4..LO + SPAN {
            for z in LO..LO + SPAN {
                w.column(x, z, 11);
            }
        }
        let mut m = mob(KIND_PIG, 2, 11, 0);
        for _ in 0..20 {
            walk(&w, 0, 0, ENTER_ALL, &mut m, 1, 0, 85);
            assert_free(&w, &m);
        }
        assert_eq!(m.pos[1], 12 * FP, "did not climb");
        assert!(m.pos[0] >> 8 >= 6);

        // 2-block wall: blocked at the boundary.
        let mut w = W::flat(10);
        for z in LO..LO + SPAN {
            w.column(4, z, 12);
        }
        let mut m = mob(KIND_PIG, 2, 11, 0);
        for _ in 0..20 {
            walk(&w, 0, 0, ENTER_ALL, &mut m, 1, 0, 85);
            assert_free(&w, &m);
        }
        assert_eq!(m.pos[1], 11 * FP);
        assert_eq!(m.pos[0], 4 * FP - 1);

        // No headroom: a ceiling right above the current head blocks the jump.
        let mut w = W::flat(10);
        for z in LO..LO + SPAN {
            w.column(4, z, 11);
            w.put(3, 13, z, STONE);
        }
        let mut m = mob(KIND_PIG, 3, 11, 0);
        for _ in 0..10 {
            walk(&w, 0, 0, ENTER_ALL, &mut m, 1, 0, 85);
        }
        assert_eq!(m.pos[1], 11 * FP);
    }

    #[test]
    fn falls_and_floats() {
        // Unsupported mob falls to the ground in one tick.
        let w = W::flat(10);
        let mut sm = sim(&w);
        let mut m = mob(KIND_COW, 0, 60, 0);
        sm.step(&mut m);
        assert_eq!(
            m.pos[1],
            (60 - MAX_FALL as i32) * FP,
            "falls MAX_FALL per tick"
        );
        for _ in 0..3 {
            sm.step(&mut m);
        }
        assert_eq!(m.pos[1], 11 * FP);
        // In deep water: floats up one block per tick until the head is out.
        let mut w = W::flat(5);
        for x in LO..LO + SPAN {
            for z in LO..LO + SPAN {
                for y in 6..=12 {
                    w.put(x, y, z, WATER);
                }
            }
        }
        let mut sm = sim(&w);
        let mut m = mob(KIND_SHEEP, 0, 6, 0);
        for _ in 0..20 {
            sm.step(&mut m);
            assert_free(&w, &m);
        }
        assert_eq!(m.pos[1], 12 * FP, "should float with head above water");
        assert!(is_fluid_u8(w.get(feet(&m).0, 12, feet(&m).2)));
    }

    /// Random terrain fuzz: 200 runs × 200 steps, all kinds, random targets/day.
    #[test]
    fn never_inside_solid_fuzz() {
        let mut st = 99u64;
        for run in 0..200 {
            let mut w = W::new();
            let base = 8 + (splitmix_next(&mut st) % 30) as i32;
            for x in LO..LO + SPAN {
                for z in LO..LO + SPAN {
                    let h = base + (splitmix_next(&mut st) % 4) as i32 - 1;
                    w.column(x, z, h);
                    let r = splitmix_next(&mut st);
                    if r.is_multiple_of(7) {
                        // pillars, overhangs, water, torches
                        w.put(x, h + 1 + (r >> 8) as i32 % 3, z, STONE);
                    }
                    if r % 23 == 1 {
                        w.put(x, h + 1, z, WATER);
                    }
                    if r % 31 == 2 {
                        w.put(x, h + 1, z, TORCH);
                    }
                }
            }
            let mut sm = sim(&w);
            sm.seed = seed(run as u8);
            sm.is_day = run % 2 == 0;
            sm.dt = [100, 333, 1000, 5000][run % 4];
            for _ in 0..(run % 4) {
                sm.targets.push(Target {
                    pos: [
                        (splitmix_next(&mut st) % (48 * 256)) as i32 - 16 * 256,
                        base * FP,
                        (splitmix_next(&mut st) % (48 * 256)) as i32 - 16 * 256,
                    ],
                    idx: 0,
                    chunk: 0,
                });
            }
            let kind = 1 + (run % 4) as u8;
            // Start on a free spot near the center chunk.
            let mut m = mob(kind, 8, 0, 8);
            m.pos[1] = 63 * FP;
            m.id = run as u32;
            for _ in 0..200 {
                sm.step(&mut m);
                if m.is_empty() {
                    break;
                }
                assert_free(&w, &m);
                let (hx, hz) = home(&m);
                assert!((-1..=1).contains(&hx) && (-1..=1).contains(&hz));
            }
        }
    }

    // ---------------------------------------------------------------- zombie

    #[test]
    fn zombie_approaches_monotonically() {
        let w = W::flat(10);
        for (tx, tz) in [(12, 9), (-10, 3), (0, -14), (11, 11), (5, 0)] {
            let mut sm = sim(&w);
            let t = target(tx, 11, tz);
            sm.targets = vec![t];
            let mut m = mob(KIND_ZOMBIE, 0, 11, 0);
            let mut d = hdist2(&m, &t);
            let mut contact = false;
            for _ in 0..200 {
                let ev = sm.step(&mut m);
                let nd = hdist2(&m, &t);
                assert!(nd <= d, "distance increased {d} -> {nd}");
                d = nd;
                if ev.hit.is_some() {
                    contact = true;
                }
            }
            assert!(contact, "never reached target ({tx},{tz})");
            assert!(d <= (FP as i64) * (FP as i64));
        }
    }

    #[test]
    fn zombie_ignores_far_targets() {
        let w = W::flat(10);
        let run = |targets: Vec<Target>| {
            let mut sm = sim(&w);
            sm.targets = targets;
            let mut m = mob(KIND_ZOMBIE, 0, 11, 0);
            for _ in 0..30 {
                assert!(sm.step(&mut m).hit.is_none());
            }
            m
        };
        // (The 17-block target is within the despawn range: only `alone_ms` differs.)
        let near = run(vec![target(0, 11, 17)]);
        let none = run(vec![]);
        assert_eq!(near.alone_ms, 0);
        assert_eq!(
            near,
            Mob {
                alone_ms: 0,
                ..none
            }
        );
    }

    #[test]
    fn idle_zombie_wanders_at_half_speed() {
        let w = W::flat(10);
        let mut sm = sim(&w);
        // A target beyond the chase range but within the despawn range keeps it around.
        sm.targets = vec![target(8, 11, 8 + 24)];
        let mut m = mob(KIND_ZOMBIE, 8, 11, 8);
        let start = m.pos;
        let max = (ZOMBIE_SPEED * 333 / 1000 / 2) as i32;
        for _ in 0..300 {
            let before = m.pos;
            sm.step(&mut m);
            assert!((m.pos[0] - before[0]).abs() <= max && (m.pos[2] - before[2]).abs() <= max);
        }
        assert_ne!(m.pos, start, "idle zombie should wander");
    }

    #[test]
    fn no_double_step_in_one_tick() {
        let w = W::flat(10);
        let s = seed(1);
        let targets = [target(12, 11, 8)];
        let mk = |tick| MobCtx {
            seed: &s,
            tick,
            cx: 0,
            cz: 0,
            targets: &targets,
            is_day: false,
            dt_ms: 333,
            enter_mask: ENTER_ALL,
        };
        let mut m = mob(KIND_ZOMBIE, 8, 11, 8);
        assert!(step_mob(&mk(5), &mut m, &w).moved);
        let after = m;
        // Same global tick again (e.g. the neighbor it crossed into): no-op.
        assert_eq!(step_mob(&mk(5), &mut m, &w), MobEvent::default());
        assert_eq!(m, after);
        assert!(step_mob(&mk(6), &mut m, &w).moved);
    }

    #[test]
    fn zombie_sidesteps_pillar() {
        let mut w = W::flat(10);
        for y in 11..14 {
            w.put(5, y, 0, STONE);
        }
        let mut sm = sim(&w);
        let t = target(10, 11, 0);
        sm.targets = vec![t];
        let mut m = mob(KIND_ZOMBIE, 0, 11, 0);
        let mut hit = false;
        for _ in 0..150 {
            hit |= sm.step(&mut m).hit.is_some();
            assert_free(&w, &m);
        }
        assert!(hit, "stuck behind pillar at {:?}", m.pos);
    }

    #[test]
    fn zombie_damage_cooldown() {
        let w = W::flat(10);
        for (dt, ticks, want) in [
            (250u32, 40, 10),
            (333, 30, 10),
            (1000, 7, 7),
            (100, 100, 10),
        ] {
            let mut sm = sim(&w);
            sm.dt = dt;
            let mut t = target(3, 11, 3);
            t.chunk = 2;
            t.idx = 41;
            sm.targets = vec![target(9, 11, 9), t];
            let mut m = mob(KIND_ZOMBIE, 3, 11, 3);
            m.pos[0] += 100;
            let mut hits = 0;
            for _ in 0..ticks {
                if let Some(h) = sm.step(&mut m).hit {
                    assert_eq!(
                        h,
                        Hit {
                            chunk: 2,
                            idx: 41,
                            dmg: 3
                        }
                    );
                    hits += 1;
                }
            }
            assert_eq!(hits, want, "dt {dt}");
            assert_eq!(m.hp, 20);
        }
        // Out of vertical reach: no hits.
        let mut sm = sim(&w);
        sm.targets = vec![Target {
            pos: [c(3), 11 * FP + 400, c(3)],
            idx: 0,
            chunk: 0,
        }];
        let mut m = mob(KIND_ZOMBIE, 3, 11, 3);
        for _ in 0..10 {
            assert!(sm.step(&mut m).hit.is_none());
        }
    }

    #[test]
    fn zombie_despawns_when_alone() {
        let w = W::flat(10);
        // Alone (no targets): 15 s of stepped time, then cleared; dt sums exactly.
        for dt in [250u32, 333, 1000] {
            let mut sm = sim(&w);
            sm.dt = dt;
            let mut m = mob(KIND_ZOMBIE, 2, 11, 2);
            let mut t = 0u32;
            loop {
                let ev = sm.step(&mut m);
                t += dt;
                if ev.died {
                    assert!(ev.despawned && m.is_empty());
                    break;
                }
                assert!(!ev.despawned);
                assert_eq!(m.alone_ms as u32, t);
            }
            assert!(t >= DESPAWN_AFTER_MS as u32 && t < DESPAWN_AFTER_MS as u32 + dt);
        }
        // A target within 32 blocks (beyond the 16-block chase range) resets the timer.
        let mut sm = sim(&w);
        sm.dt = 1000;
        let mut m = mob(KIND_ZOMBIE, 2, 11, 2);
        for i in 0..40 {
            // 25 blocks from wherever the wandering zombie is.
            let far = Target {
                pos: [m.pos[0], m.pos[1], m.pos[2] + 25 * FP],
                idx: 0,
                chunk: 0,
            };
            sm.targets = if i % 10 == 9 { vec![far] } else { vec![] };
            let ev = sm.step(&mut m);
            assert!(!ev.died, "despawned at step {i}");
            if i % 10 == 9 {
                assert_eq!(m.alone_ms, 0, "step {i} at {:?}", m.pos);
            }
        }
        // ...one 39 blocks away (3D) does not.
        let mut sm = sim(&w);
        sm.dt = 1000;
        sm.targets = vec![target(2 + 30, 11 + 25, 2)];
        let mut m = mob(KIND_ZOMBIE, 2, 11, 2);
        let n = (0..30).take_while(|_| !sm.step(&mut m).died).count();
        assert_eq!(n, 14);
        // Passive mobs never despawn.
        let mut sm = sim(&w);
        sm.dt = 1000;
        let mut m = mob(KIND_PIG, 2, 11, 2);
        for _ in 0..60 {
            assert!(!sm.step(&mut m).died);
        }
        assert_eq!(m.alone_ms, 0);
    }

    #[test]
    fn zombie_burns_by_day_on_surface_only() {
        let w = W::flat(10);
        let mut sm = sim(&w);
        sm.targets = vec![target(2, 11, 2 + 24)]; // not alone (no despawn)
        sm.is_day = true;
        sm.dt = 1000;
        let mut m = mob(KIND_ZOMBIE, 2, 11, 2);
        for i in 1..20 {
            let ev = sm.step(&mut m);
            assert!(!ev.died);
            assert_eq!(m.hp, 20 - i as u8);
        }
        let ev = sm.step(&mut m);
        assert!(ev.died);
        assert!(m.is_empty());

        // Sub-second ticks accumulate: 3 × 333 ms < 1 s, the 4th tick burns.
        let mut sm = sim(&w);
        sm.targets = vec![target(2, 11, 2 + 24)]; // not alone (no despawn)
        sm.is_day = true;
        let mut m = mob(KIND_ZOMBIE, 2, 11, 2);
        for _ in 0..3 {
            sm.step(&mut m);
        }
        assert_eq!(m.hp, 20);
        sm.step(&mut m);
        assert_eq!(m.hp, 19);

        // Night: no burn.
        let mut sm = sim(&w);
        sm.targets = vec![target(2, 11, 2 + 24)]; // not alone (no despawn)
        sm.dt = 1000;
        let mut m = mob(KIND_ZOMBIE, 2, 11, 2);
        for _ in 0..30 {
            sm.step(&mut m);
        }
        assert_eq!(m.hp, 20);

        // Underground (roof far above): no burn by day.
        let mut w = W::flat(10);
        for x in LO..LO + SPAN {
            for z in LO..LO + SPAN {
                w.put(x, 50, z, STONE);
            }
        }
        let mut sm = sim(&w);
        sm.targets = vec![target(2, 11, 2 + 24)]; // not alone (no despawn)
        sm.is_day = true;
        sm.dt = 1000;
        let mut m = mob(KIND_ZOMBIE, 2, 11, 2);
        for _ in 0..30 {
            sm.step(&mut m);
        }
        assert_eq!(m.hp, 20);
        // Glass, leaves and ice let sunlight through.
        for roof in [Block::Glass, Block::Leaves, Block::Ice] {
            let mut w = W::flat(10);
            for x in LO..LO + SPAN {
                for z in LO..LO + SPAN {
                    w.put(x, 14, z, roof as u8);
                }
            }
            let mut sm = sim(&w);
            sm.targets = vec![target(2, 11, 2 + 24)]; // not alone (no despawn)
            sm.is_day = true;
            sm.dt = 1000;
            let mut m = mob(KIND_ZOMBIE, 2, 11, 2);
            for _ in 0..5 {
                sm.step(&mut m);
            }
            assert_eq!(m.hp, 15, "{roof:?} shaded");
        }
        // Passive mobs never burn.
        let w = W::flat(10);
        let mut sm = sim(&w);
        sm.targets = vec![target(2, 11, 2 + 24)]; // not alone (no despawn)
        sm.is_day = true;
        sm.dt = 1000;
        let mut m = mob(KIND_PIG, 2, 11, 2);
        for _ in 0..30 {
            sm.step(&mut m);
        }
        assert_eq!(m.hp, 10);
    }

    #[test]
    fn crossing_border() {
        let w = W::flat(10);
        // (start block, target block, expected cross)
        let cases = [
            ((15, 8), (20, 8), (1, 0)),
            ((0, 8), (-5, 8), (-1, 0)),
            ((8, 15), (8, 20), (0, 1)),
            ((8, 0), (8, -5), (0, -1)),
        ];
        for ((sx, sz), (tx, tz), want) in cases {
            let mut m = mob(KIND_ZOMBIE, sx, 11, sz);
            let ctx_targets = [target(tx, 11, tz)];
            let s = seed(1);
            let mut crossed = None;
            for tick in 0..10 {
                let ctx = MobCtx {
                    seed: &s,
                    tick,
                    cx: 0,
                    cz: 0,
                    targets: &ctx_targets,
                    is_day: false,
                    dt_ms: 333,
                    enter_mask: ENTER_ALL,
                };
                let ev = step_mob(&ctx, &mut m, &w);
                if ev.cross != (0, 0) {
                    crossed = Some(ev.cross);
                    break;
                }
            }
            assert_eq!(crossed, Some(want));
            assert_eq!(home(&m), (want.0 as i32, want.1 as i32));

            // Neighbor not enterable (no free slot / missing): treated as a wall.
            let mut m = mob(KIND_ZOMBIE, sx, 11, sz);
            for tick in 0..10 {
                let ctx = MobCtx {
                    seed: &s,
                    tick,
                    cx: 0,
                    cz: 0,
                    targets: &ctx_targets,
                    is_day: false,
                    dt_ms: 333,
                    enter_mask: 0,
                };
                let ev = step_mob(&ctx, &mut m, &w);
                assert_eq!(ev.cross, (0, 0));
                assert_eq!(home(&m), (0, 0));
            }
        }
    }

    #[test]
    fn never_enters_diagonal_chunk() {
        let w = W::flat(10);
        let mut sm = sim(&w);
        sm.targets = vec![target(17, 11, 17)];
        let mut m = mob(KIND_ZOMBIE, 15, 11, 15);
        for _ in 0..40 {
            let (cx, cz) = home(&m);
            sm.tick += 1;
            let ctx = MobCtx {
                seed: &sm.seed,
                tick: sm.tick,
                cx,
                cz,
                targets: &sm.targets,
                is_day: false,
                dt_ms: 333,
                enter_mask: ENTER_ALL,
            };
            let ev = step_mob(&ctx, &mut m, &w);
            assert!(
                ev.cross.0 == 0 || ev.cross.1 == 0,
                "diagonal {:?}",
                ev.cross
            );
        }
        assert_eq!(
            home(&m),
            (1, 1),
            "should get there via an orthogonal neighbor"
        );
    }

    #[test]
    fn invalid_mobs_are_cleared() {
        let w = W::flat(10);
        let s = seed(1);
        let ctx = MobCtx {
            seed: &s,
            tick: 0,
            cx: 0,
            cz: 0,
            targets: &[],
            is_day: false,
            dt_ms: 333,
            enter_mask: ENTER_ALL,
        };
        for mut m in [
            Mob {
                kind: 9,
                ..mob(KIND_PIG, 3, 11, 3)
            },
            Mob {
                hp: 0,
                ..mob(KIND_PIG, 3, 11, 3)
            },
            mob(KIND_PIG, 30, 11, 3), // outside own chunk
            mob(KIND_PIG, 3, -2, 3),  // below the world
            mob(KIND_PIG, 3, 70, 3),  // above the world
        ] {
            let ev = step_mob(&ctx, &mut m, &w);
            assert!(ev.died && m.is_empty());
        }
        let mut m = Mob::EMPTY;
        assert_eq!(step_mob(&ctx, &mut m, &w), MobEvent::default());
        // hp above max is clamped.
        let mut m = Mob {
            hp: 200,
            ..mob(KIND_SHEEP, 3, 11, 3)
        };
        step_mob(&ctx, &mut m, &w);
        assert_eq!(m.hp, 8);
    }

    // ---------------------------------------------------------------- spawning

    fn spawn_ok(w: &W, m: &Mob, targets: &[Target]) {
        assert_eq!(m.kind, KIND_ZOMBIE);
        assert_eq!(m.hp, 20);
        let (x, y, z) = feet(m);
        assert!(is_solid_u8(w.get(x, y - 1, z)));
        for dy in 0..2 {
            let b = w.get(x, y + dy, z);
            assert!(!is_solid_u8(b) && !is_fluid_u8(b));
        }
        let mut near = false;
        for t in targets {
            let d = hdist2(m, t);
            assert!(d >= (8 * FP as i64).pow(2), "too close");
            near |= d <= (24 * FP as i64).pow(2);
        }
        assert!(near, "too far from all targets");
        for dx in -4..=4 {
            for dy in -1..=2 {
                for dz in -4..=4 {
                    assert_ne!(w.get(x + dx, y + dy, z + dz), TORCH, "torch nearby");
                }
            }
        }
    }

    /// `count` zombies already in the center slots (standing in column (15, 15)).
    fn spawn_many(w: &W, targets: &[Target], night: bool, count: u8, cap: u8) -> Vec<Mob> {
        let mut slots = [Mob::EMPTY; MOB_SLOTS];
        for m in slots.iter_mut().take(count as usize) {
            *m = mob(KIND_ZOMBIE, 15, 21, 15);
        }
        spawn_with(w, targets, night, &slots, cap)
    }

    fn spawn_with(w: &W, targets: &[Target], night: bool, slots: &[Mob], cap: u8) -> Vec<Mob> {
        let s = seed(5);
        // 400 gated-open ticks' worth (≈ 1 in SPAWN_GATE ticks passes the gate).
        (0..400 * SPAWN_GATE)
            .filter_map(|t| try_spawn_zombie(&s, t, 0, 0, w, targets, slots, night, cap))
            .collect()
    }

    #[test]
    fn spawn_at_night_respects_distance_and_floor() {
        let mut w = W::flat(20);
        // Some 1-high gaps and water to reject.
        for x in 0..16 {
            w.put(x, 22, 5, STONE);
            w.put(x, 21, 9, WATER);
        }
        let targets = [target(2, 21, 2), target(40, 21, 40)];
        let got = spawn_many(&w, &targets, true, 0, 4);
        assert!(got.len() > 20, "too few spawns: {}", got.len());
        for m in &got {
            spawn_ok(&w, m, &targets);
            assert_eq!(home(m), (0, 0));
        }
        // Deterministic.
        assert_eq!(got, spawn_many(&w, &targets, true, 0, 4));
        // No targets / targets all far / all near: nothing.
        assert!(spawn_many(&w, &[], true, 0, 4).is_empty());
        assert!(spawn_many(&w, &[target(100, 21, 0)], true, 0, 4).is_empty());
        let around: Vec<Target> = (0..4).map(|i| target(i * 4 + 2, 21, 8)).collect();
        let near = spawn_many(&w, &around, true, 0, 4);
        for m in &near {
            spawn_ok(&w, m, &around);
        }
    }

    #[test]
    fn spawn_rate_gate() {
        let s = seed(9);
        for (cx, cz) in [(0, 0), (3, -7), (-100, 42)] {
            let open = (0..30_000u64)
                .filter(|&t| spawn_gate_open(&s, t, cx, cz))
                .count();
            // ≈ 1000 expected (1 in 30).
            assert!((800..1200).contains(&open), "{cx},{cz}: {open}");
        }
        // Closed gate: no spawn even where every other rule allows one.
        let w = W::flat(20);
        let targets = [target(2, 21, 2)];
        let slots = [Mob::EMPTY; MOB_SLOTS];
        for t in 0..3000u64 {
            if !spawn_gate_open(&s, t, 0, 0) {
                assert_eq!(
                    try_spawn_zombie(&s, t, 0, 0, &w, &targets, &slots, true, 4),
                    None
                );
            }
        }
    }

    #[test]
    fn spawn_cap_and_light() {
        let w = W::flat(20);
        let targets = [target(2, 21, 2)];
        assert!(spawn_many(&w, &targets, true, 4, 4).is_empty());
        assert!(spawn_many(&w, &targets, true, 0, 0).is_empty());
        assert!(!spawn_many(&w, &targets, true, 3, 4).is_empty());
        // No free slot: never. Occupied columns are never chosen.
        let full = [mob(KIND_PIG, 15, 21, 15); MOB_SLOTS];
        assert!(spawn_with(&w, &targets, true, &full, 8).is_empty());
        let mut slots = [Mob::EMPTY; MOB_SLOTS];
        for (i, m) in slots.iter_mut().take(7).enumerate() {
            *m = mob(KIND_COW, 9 + i as i32, 21, 3 + i as i32);
        }
        let got = spawn_with(&w, &targets, true, &slots, 4);
        assert!(!got.is_empty());
        for z in &got {
            assert!(slots
                .iter()
                .all(|m| (m.pos[0] >> 8, m.pos[2] >> 8) != (z.pos[0] >> 8, z.pos[2] >> 8)));
        }
        // More than 8 "slots" are clamped to the first 8 (all full here) -> nothing.
        let many: Vec<Mob> = (0..256)
            .map(|i| mob(KIND_PIG, i % 16, 21, i / 16))
            .collect();
        assert!(spawn_with(&w, &targets, true, &many, 4).is_empty());
        // Day on the open surface: never.
        assert!(spawn_many(&w, &targets, false, 0, 4).is_empty());
        // Day under a roof: yes.
        let mut w = W::flat(20);
        for x in LO..LO + SPAN {
            for z in LO..LO + SPAN {
                w.put(x, 40, z, STONE);
            }
        }
        let got = spawn_many(&w, &targets, false, 0, 4);
        assert!(!got.is_empty());
        for m in &got {
            spawn_ok(&w, m, &targets);
        }
    }

    #[test]
    fn spawn_torch_rule() {
        // Torches on a 9-block grid in the chunk: every spot within 4 of one -> never.
        let mut w = W::flat(20);
        for x in (-16..32).step_by(9) {
            for z in (-16..32).step_by(9) {
                w.put(x, 21, z, TORCH);
            }
        }
        let targets = [target(2, 21, 2)];
        assert!(spawn_many(&w, &targets, true, 0, 4).is_empty());
        // A single torch: spawns happen but never within 4 of it.
        let mut w = W::flat(20);
        w.put(12, 21, 12, TORCH);
        let got = spawn_many(&w, &targets, true, 0, 4);
        assert!(!got.is_empty());
        for m in &got {
            spawn_ok(&w, m, &targets);
        }
    }

    // ---------------------------------------------------------------- drops, damage, time

    /// `(kind, [(item, min, max); 2])`.
    type Ranges = (u8, [(Item, u8, u8); 2]);

    #[test]
    fn drops_ranges_and_determinism() {
        let s = seed(3);
        let ranges: [Ranges; 4] = [
            (KIND_PIG, [(Item::RawPork, 1, 3), (Item::RawPork, 0, 0)]),
            (KIND_COW, [(Item::RawBeef, 1, 3), (Item::Leather, 0, 2)]),
            (KIND_SHEEP, [(Item::RawMutton, 1, 2), (Item::Wool, 1, 1)]),
            (
                KIND_ZOMBIE,
                [(Item::RottenFlesh, 0, 2), (Item::RottenFlesh, 0, 0)],
            ),
        ];
        for (kind, r) in ranges {
            let mut seen = [[false; 4]; 2];
            for n in 0..500u64 {
                let d = drops(kind, &s, n);
                assert_eq!(d, drops(kind, &s, n));
                for i in 0..2 {
                    assert_eq!(d[i].0, r[i].0);
                    assert!((r[i].1..=r[i].2).contains(&d[i].1), "{kind} {d:?}");
                    seen[i][d[i].1 as usize] = true;
                }
            }
            for i in 0..2 {
                for v in r[i].1..=r[i].2 {
                    assert!(seen[i][v as usize], "kind {kind} slot {i} never {v}");
                }
            }
        }
        for k in [0u8, 5, 255] {
            assert!(drops(k, &s, 1).iter().all(|d| d.1 == 0));
        }
    }

    #[test]
    fn damage_mob_rules() {
        let mut m = mob(KIND_SHEEP, 0, 11, 0);
        assert!(!damage_mob(&mut m, 5));
        assert_eq!(m.hp, 3);
        assert!(damage_mob(&mut m, 200));
        assert_eq!(m.hp, 0);
        assert_eq!(m.kind, KIND_SHEEP, "kind kept so the caller can roll drops");
        let mut e = Mob::EMPTY;
        assert!(!damage_mob(&mut e, 5));
        assert!(e.is_empty());
        let mut m = mob(KIND_PIG, 0, 11, 0);
        assert!(!damage_mob(&mut m, 0));
        assert_eq!(m.hp, 10);
    }

    #[test]
    fn day_night() {
        assert!(is_day(0, 1000));
        assert!(is_day(499, 1000));
        assert!(!is_day(500, 1000));
        assert!(!is_day(999, 1000));
        assert!(is_day(1000, 1000));
        assert!(is_day(5, 0));
        assert!(is_day(u64::MAX, u64::MAX));
        assert!(light_ok_for_spawn(true, true));
        assert!(light_ok_for_spawn(false, false));
        assert!(!light_ok_for_spawn(false, true));
        let w = W::flat(10);
        assert!(sky_exposed(&w, 0, 11, 0));
        let mut w2 = W::flat(10);
        w2.put(0, 60, 0, STONE);
        assert!(!sky_exposed(&w2, 0, 11, 0));
        assert!(sky_exposed(&w2, 1, 11, 0));
    }

    // ---------------------------------------------------------------- determinism, fuzz

    #[test]
    fn deterministic() {
        let w = W::flat(10);
        let run = || {
            let mut sm = sim(&w);
            sm.targets = vec![target(9, 11, 4)];
            let mut ms = [
                mob(KIND_PIG, 1, 11, 1),
                mob(KIND_COW, 5, 11, 12),
                mob(KIND_ZOMBIE, 14, 11, 2),
            ];
            let mut log = vec![];
            for _ in 0..300 {
                for m in ms.iter_mut() {
                    let ev = sm.step(m);
                    log.push((m.to_bytes(), ev));
                }
            }
            log
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn garbage_fuzz_no_panic() {
        let mut st = 0xF00Du64;
        let w = W::flat(10);
        let mut wr = W::new();
        for v in wr.b.iter_mut() {
            *v = splitmix_next(&mut st) as u8;
        }
        let extremes = [i32::MIN, i32::MIN + 1, -1, 0, 1, i32::MAX - 1, i32::MAX];
        for i in 0..20_000u32 {
            let mut b = [0u8; 32];
            for chunk in b.chunks_mut(8) {
                chunk.copy_from_slice(&splitmix_next(&mut st).to_le_bytes());
            }
            let mut m = Mob::from_bytes(&b);
            m.kind %= 6;
            if i % 3 == 0 {
                // Valid-ish position, garbage everything else.
                m.pos = [
                    (splitmix_next(&mut st) % (16 * 256)) as i32,
                    (splitmix_next(&mut st) % (70 * 256)) as i32 - 3 * 256,
                    (splitmix_next(&mut st) % (16 * 256)) as i32,
                ];
            }
            let r = splitmix_next(&mut st);
            let pick = |k: u64| extremes[(k % extremes.len() as u64) as usize];
            let (cx, cz) = if i % 5 == 0 {
                (pick(r), pick(r >> 8))
            } else {
                (0, 0)
            };
            let mut targets = vec![];
            for _ in 0..(r >> 16) % 5 {
                let t = splitmix_next(&mut st);
                targets.push(Target {
                    pos: if t.is_multiple_of(2) {
                        [pick(t >> 3), pick(t >> 9), pick(t >> 15)]
                    } else {
                        [(t >> 8) as i32 % 8192, 11 * FP, (t >> 32) as i32 % 8192]
                    },
                    idx: t as u16,
                    chunk: (t >> 40) as u8,
                });
            }
            let s = seed(i as u8);
            let ctx = MobCtx {
                seed: &s,
                tick: splitmix_next(&mut st),
                cx,
                cz,
                targets: &targets,
                is_day: r & 1 == 0,
                dt_ms: if i % 7 == 0 {
                    u32::MAX
                } else {
                    (r >> 24) as u32 % 3000
                },
                enter_mask: (r >> 56) as u8,
            };
            let world: &W = if i % 2 == 0 { &w } else { &wr };
            let _ = step_mob(&ctx, &mut m, world);
            let _ = try_spawn_zombie(
                &s,
                ctx.tick,
                cx,
                cz,
                world,
                &targets,
                &[m, Mob::from_bytes(&b)][..(r >> 3) as usize % 3],
                r & 2 == 0,
                (r >> 11) as u8,
            );
            let _ = drops(m.kind, &s, ctx.tick);
            let _ = damage_mob(&mut m, r as u8);
            let _ = is_day(ctx.tick, r >> 3);
            let _ = Mob::from_spawn(
                &MobSpawn {
                    kind: r as u8,
                    x: (r >> 8) as u8,
                    y: (r >> 16) as u8,
                    z: (r >> 24) as u8,
                },
                cx,
                cz,
            );
            let _ = sky_exposed(world, pick(r), pick(r >> 5), pick(r >> 10));
        }
    }

    #[test]
    #[ignore]
    fn bench_mobs() {
        let w = W::flat(10);
        let s = seed(1);
        let targets: Vec<Target> = (0..8).map(|i| target(i * 3, 11, 30 - i * 2)).collect();
        let n = 200_000u64;
        let mut m0 = [mob(KIND_PIG, 1, 11, 1), mob(KIND_ZOMBIE, 8, 11, 8)];
        let t = std::time::Instant::now();
        for i in 0..n {
            let m = &mut m0[(i % 2) as usize];
            let (cx, cz) = home(m);
            let ctx = MobCtx {
                seed: &s,
                tick: i,
                cx,
                cz,
                targets: &targets,
                is_day: false,
                dt_ms: 333,
                enter_mask: ENTER_ALL,
            };
            std::hint::black_box(step_mob(&ctx, m, &w));
        }
        println!("step_mob: {:?}/call", t.elapsed() / n as u32);
        let t = std::time::Instant::now();
        for i in 0..n {
            std::hint::black_box(try_spawn_zombie(
                &s,
                i,
                0,
                0,
                &w,
                &targets,
                &[Mob::EMPTY; MOB_SLOTS],
                true,
                4,
            ));
        }
        println!("try_spawn_zombie: {:?}/call", t.elapsed() / n as u32);
    }

    #[test]
    fn knockback_pushes_away_from_the_attacker() {
        let w = W::flat(10);
        // Attacker west of the mob: pushed +x by KNOCKBACK.
        let mut m = mob(KIND_ZOMBIE, 5, 11, 5);
        let from = [c(3), 11 * FP, c(5)];
        assert_eq!(knockback(&w, 0, 0, &mut m, from), KNOCKBACK);
        assert_eq!(m.pos, [c(5) + KNOCKBACK as i32, 11 * FP, c(5)]);
        // Diagonal: same length, split over both axes.
        let mut m = mob(KIND_PIG, 8, 11, 8);
        knockback(&w, 0, 0, &mut m, [c(6), 11 * FP, c(6)]);
        assert_eq!(m.pos[0] - c(8), 217);
        assert_eq!(m.pos[2] - c(8), 217);
        // Attacker on the mob: no push.
        let mut m = mob(KIND_PIG, 5, 11, 5);
        let at = m.pos;
        assert_eq!(knockback(&w, 0, 0, &mut m, at), 0);
    }

    #[test]
    fn knockback_respects_walls_steps_and_the_chunk_border() {
        // A 2-block wall at x = 6: stops at the boundary.
        let mut w = W::flat(10);
        for z in LO..LO + SPAN {
            w.column(6, z, 12);
        }
        let mut m = mob(KIND_ZOMBIE, 5, 11, 5);
        knockback(&w, 0, 0, &mut m, [c(4), 11 * FP, c(5)]);
        assert_eq!(m.pos[0], 6 * FP - 1);
        assert_free(&w, &m);
        // A 1-block step: climbs it.
        let mut w = W::flat(10);
        for z in LO..LO + SPAN {
            w.column(6, z, 11);
        }
        let mut m = mob(KIND_ZOMBIE, 5, 11, 5);
        knockback(&w, 0, 0, &mut m, [c(4), 11 * FP, c(5)]);
        assert_eq!(m.pos[1], 12 * FP);
        assert_free(&w, &m);
        // The chunk's east border (x = 16): stays inside the chunk.
        let w = W::flat(10);
        let mut m = mob(KIND_PIG, 15, 11, 5);
        knockback(&w, 0, 0, &mut m, [c(14), 11 * FP, c(5)]);
        assert_eq!(m.pos[0], 16 * FP - 1);
        // Pushed off a 2-block ledge: lands below; a 4-block cliff stops it at the edge
        // (mobs never drop more than MAX_DROP).
        for (low, feet, x) in [
            (8, 9 * FP, c(5) + KNOCKBACK as i32),
            (6, 11 * FP, 6 * FP - 1),
        ] {
            let mut w = W::flat(low);
            for x in LO..6 {
                for z in LO..LO + SPAN {
                    w.column(x, z, 10);
                }
            }
            let mut m = mob(KIND_PIG, 5, 11, 5);
            knockback(&w, 0, 0, &mut m, [c(4), 11 * FP, c(5)]);
            assert_eq!((m.pos[1], m.pos[0]), (feet, x));
        }
    }

    #[test]
    fn isqrt_floors() {
        for v in [0i64, 1, 2, 3, 4, 15, 16, 17, 99_999, 1 << 40] {
            let r = isqrt(v);
            assert!(r * r <= v && (r + 1) * (r + 1) > v, "{v}");
        }
    }
}
