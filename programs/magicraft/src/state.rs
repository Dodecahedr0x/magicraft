//! Account state and byte layouts.
//!
//! Two kinds of accounts:
//! - **Borsh accounts** (`#[account]`, 8-byte Anchor discriminator + Borsh fields): [`Player`],
//!   [`World`], [`PlayerState`]. Every field is fixed-size, so Borsh gives a fixed little-endian
//!   layout with no padding; the tables below list offsets *including* the discriminator.
//!   Embedded `magicraft-core` types are stored as their documented byte layouts
//!   (`[u8; N]`) and converted with their `to_bytes` / `from_bytes`.
//! - **Manual zero-copy accounts** (ephemeral, read through `AccountInfo`): `Chunk` =
//!   [`ChunkHeader`] + 16 384 block bytes, and `ChunkPresence` = [`PresenceHeader`] +
//!   [`PresenceEntry`]s. Every type is `repr(C)` with alignment 1 (multi-byte integers are
//!   little-endian byte arrays, [`LeI32`] etc.), so a header can be cast from any byte offset
//!   with `bytemuck` and there is no padding. Their 8-byte discriminators are Anchor-style
//!   (`sha256("account:<Name>")[..8]`) but the types are not in the IDL; clients decode them
//!   from these tables.
//!
//! # Sponsoring
//! Every ix that makes the Player pay ephemeral rent on the ER (create / grow / presence
//! resize) must first call [`ensure_sponsor_reserve`]: after paying, the Player must keep
//! `rent_exempt(Player) +` [`SPONSOR_RESERVE_MARGIN`] lamports, else
//! `InsufficientSponsorFunds` (the client then prompts a top-up).
//!
//! # `Player` (base layer, delegated), PDA `["player", authority]`, 105 bytes
//! | off | field | type |
//! |---|---|---|
//! | 0 | discriminator | [u8; 8] |
//! | 8 | `authority` | Pubkey |
//! | 40 | `bump` | u8 |
//! | 41 | `open_chunks` | u32 |
//! | 45 | `_reserved` | [u8; 60] |
//!
//! # `World` (ephemeral), PDA `["world", creator, nonce u64 LE]`, 265 bytes
//! | off | field | type |
//! |---|---|---|
//! | 0 | discriminator | [u8; 8] |
//! | 8 | `creator` | Pubkey (wallet = `Player.authority`) |
//! | 40 | `nonce` | u64 |
//! | 48 | `bump` | u8 |
//! | 49 | `name` | [u8; 32] (UTF-8, zero padded) |
//! | 81 | `params` | [`WorldParams`] (48 B, identical to `core::physics::WorldParams::to_bytes`) |
//! | 129 | `seed` | [u8; 32] |
//! | 161 | `seed_set` | bool |
//! | 162 | `spawn` | [i32; 3] (**block** coordinates of the feet block, not FP; `set_spawn`) |
//! | 174 | `spawn_set` | bool |
//! | 175 | `time_of_day_ms` | u64 (0 ..< day_length_secs·1000) |
//! | 183 | `day_task_id` | i64 (0 = not scheduled) |
//! | 191 | `last_tick_ms` | i64 (chain ms of the last `tick_day`) |
//! | 199 | `chunk_count` | u32 |
//! | 203 | `clock` | [`TimeAnchor`]: `anchor_slot` u64 @203, `anchor_ms` i64 @211, `us_per_slot` u32 @219, `base_us_per_slot` u32 @223 (µs per slot), `sync_slot` u64 @227, `sync_ms` i64 @235 |
//! | 243 | `day_ticks` | u32 (wrapping count of `tick_day` executions; diagnostics) |
//! | 247 | `day_epoch` | u8 (day-crank task id epoch, bumped by a stale re-arm) |
//! | 248 | `first_join_ms` | i64 (chain ms of the first `join_world`; 0 = none: the clock may still step back) |
//! | 256 | `players_online` | u32 (players with `PlayerState.in_world` set) |
//! | 260 | `entries` | u32 (wrapping count of entries into the world) |
//! | 264 | `_reserved` | [u8; 1] |
//!
//! # `PlayerState` (ephemeral), PDA `["pstate", world, player]`, 432 bytes
//! | off | field | type |
//! |---|---|---|
//! | 0 | discriminator | [u8; 8] |
//! | 8 | `player` | Pubkey (Player PDA) |
//! | 40 | `world` | Pubkey |
//! | 72 | `bump` | u8 |
//! | 73 | `move_state` | [u8; 72] (`core::physics::MoveState` layout) |
//! | 145 | `health` | u8 (0..=20; **0 ⇔ dead**, the only death state) |
//! | 146 | `food` | u8 (0..=20) |
//! | 147 | `exhaustion` | u16 (hunger accumulator) |
//! | 149 | `inventory` | [u8; 216] (`core::inventory::Inventory` layout) |
//! | 365 | `held_slot` | u8 |
//! | 366 | `cx`, `cz` | i32, i32 (current chunk) @366, @370 |
//! | 374 | `break_until_ms` | i64 |
//! | 382 | `attack_until_ms` | i64 |
//! | 390 | `food_tick_ms` | i64 (last hunger / regen step) |
//! | 398 | `respawn_ms` | i64 (chain ms of the last `respawn`, 0 = never; own presence entries last seen before it lose their `pending_damage`) |
//! | 406 | `in_world` | u8 (1 = in the world, counted in `World.players_online`) |
//! | 407 | `_reserved` | [u8; 25] |
//!
//! # `Chunk` (ephemeral), PDA `["chunk", world, cx i32 LE, cz i32 LE]`
//! Created at [`CHUNK_INITIAL_LEN`] (10 240) bytes, then resized to [`CHUNK_FULL_LEN`]
//! (17 536) by `grow_chunk`. Blocks start at [`CHUNK_BLOCKS_OFFSET`] (768), index
//! `y * 256 + z * 16 + x`; ground items (`core::ground`, 16 × 24 B) at
//! [`CHUNK_GROUND_OFFSET`] (17 152). A chunk grown before ground items existed is 17 152
//! bytes long: still playable, but its drops go straight to the inventory.
//!
//! | off | field | type |
//! |---|---|---|
//! | 0 | `discriminator` | [u8; 8] = [`CHUNK_DISCRIMINATOR`] |
//! | 8 | `payer` | Pubkey (sponsoring Player PDA) |
//! | 40 | `world` | Pubkey |
//! | 72 | `cx` | i32 |
//! | 76 | `cz` | i32 |
//! | 80 | `bump` | u8 |
//! | 81 | `edited` | u8 (0/1) |
//! | 82 | `gen_stage` | u8 ([`GEN_CREATED`], [`GEN_STAGE1`], [`GEN_DONE`]) |
//! | 83 | `crank_armed` | u8 (0/1: a tick crank should be live; see `instructions::crank`) |
//! | 84 | `task_id` | i64 (tick crank id `sha256("tick" ‖ chunk)`, set by `create_chunk`) |
//! | 92 | `last_tick_ms` | i64 (chain ms of the last accepted `tick_chunk` **or arm**) |
//! | 100 | `tick_count` | u64 (accepted non-idle `tick_chunk`s; diagnostics + renewal) |
//! | 108 | `biomes` | [u8; 256] (`core::terrain::Biome`, index `lz * 16 + lx`) |
//! | 364 | `mobs` | [u8; 256] (8 × `core::mobs::Mob`, 32 B each) |
//! | 620 | `fluid` | [u8; 134] (`core::fluid::FluidQueue` repr(C) layout) |
//! | 754 | `presence_bump` | u8 (bump of `["presence", chunk]`) |
//! | 755 | `nbr_bumps` | [u8; 8] (bumps of the N, S, E, W chunk PDAs, then of their presence PDAs; `create_chunk`) |
//! | 763 | `arm_tick` | u8 (low byte of `tick_count` at the last (re)arm with a write) |
//! | 764 | `nbr_mask` | u8 (bit `i` set ⇔ neighbor `i` (N, S, E, W) exists; `create_chunk` / `close_chunk`) |
//! | 765 | `task_epoch` | u8 (epoch mixed into `task_id`; bumped by a stale re-arm with a write) |
//! | 766 | `repair_s` | u16 (chain seconds mod 2^16 of the last list repair; throttle) |
//! | 768 | blocks | [u8; 16 384] |
//! | 17 152 | `ground` | [u8; 384] (16 × `core::ground::GroundItem`, 24 B each) |
//!
//! # `ChunkPresence` (ephemeral), PDA `["presence", chunk]`, `48 + 56·n` bytes
//! | off | field | type |
//! |---|---|---|
//! | 0 | `discriminator` | [u8; 8] = [`PRESENCE_DISCRIMINATOR`] |
//! | 8 | `chunk` | Pubkey |
//! | 40 | `bump` | u8 |
//! | 41 | `_pad` | u8 |
//! | 42 | `count` | u16 (must equal `(len − 48) / 56`) |
//! | 44 | `_reserved` | [u8; 4] |
//! | 48 + 56·i | entry `i` | [`PresenceEntry`] |
//!
//! [`PresenceEntry`]: `player` Pubkey @0, `pos` [i32; 3] FP @32, `last_seen_ms` i64 @44,
//! `pending_damage` u8 @52, `_pad` [u8; 3] @53.

use core::cell::RefMut;

use anchor_lang::prelude::*;
use bytemuck::{Pod, Zeroable};
use magicraft_core::consts::CHUNK_VOL;
use magicraft_core::fluid::FluidQueue;
use magicraft_core::ground::GroundItems;
use magicraft_core::inventory::Inventory;
use magicraft_core::mobs::{Mob, MOB_SLOTS};
use magicraft_core::physics::{self as phys, MoveState};

use crate::errors::MagicraftError;

pub const PLAYER_SEED: &[u8] = b"player";
pub const WORLD_SEED: &[u8] = b"world";
pub const CHUNK_SEED: &[u8] = b"chunk";
pub const PRESENCE_SEED: &[u8] = b"presence";
pub const PSTATE_SEED: &[u8] = b"pstate";

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

/// Per-wallet account. Holds the SOL that sponsors every ephemeral account the
/// player creates. Created, funded and delegated on the base layer.
#[account]
#[derive(InitSpace)]
pub struct Player {
    pub authority: Pubkey,
    pub bump: u8,
    /// Chunks this Player sponsors that are still open (`create_chunk` +1,
    /// `close_chunk` −1). UI warnings only: `withdraw` is never blocked by it.
    pub open_chunks: u32,
    /// Padding for future fields (keeps the account size stable).
    pub _reserved: [u8; 60],
}

/// Lamports a sponsoring Player keeps above its rent-exempt minimum on the ER (a safety
/// margin, so commits/undelegation never see an under-funded Player).
pub const SPONSOR_RESERVE_MARGIN: u64 = 100_000;

/// Pure check: can a Player with `lamports` pay `cost` and keep `rent_min + margin`?
pub fn sponsor_can_pay(lamports: u64, rent_min: u64, cost: u64) -> bool {
    lamports.checked_sub(cost).is_some_and(|left| {
        rent_min
            .checked_add(SPONSOR_RESERVE_MARGIN)
            .is_some_and(|need| left >= need)
    })
}

/// `InsufficientSponsorFunds` unless the Player can pay `cost` lamports of ephemeral rent
/// and keep its reserve (see the module docs).
pub fn ensure_sponsor_reserve(player: &AccountInfo, cost: u64) -> Result<()> {
    let rent_min = Rent::get()?.minimum_balance(player.data_len());
    require!(
        sponsor_can_pay(player.lamports(), rent_min, cost),
        MagicraftError::InsufficientSponsorFunds
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/// Anchor/IDL mirror of `magicraft_core::physics::WorldParams`. Same fields in the
/// same order, so its Borsh bytes equal the core `to_bytes` layout (48 B).
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorldParams {
    pub walk_speed: u32,
    pub sprint_speed: u32,
    pub swim_speed: u32,
    pub jump_velocity: u32,
    pub gravity: u32,
    pub max_fall_speed: u32,
    pub reach: u32,
    pub attack_cooldown_ms: u32,
    pub day_length_secs: u32,
    pub mob_tick_ms: u32,
    pub fluid_tick_ms: u32,
    pub fall_damage: u8,
    pub hunger: u8,
    pub zombie_cap_per_chunk: u8,
    /// Must be 0 (`validate` rejects anything else).
    pub pad: u8,
}

impl From<phys::WorldParams> for WorldParams {
    fn from(p: phys::WorldParams) -> Self {
        WorldParams {
            walk_speed: p.walk_speed,
            sprint_speed: p.sprint_speed,
            swim_speed: p.swim_speed,
            jump_velocity: p.jump_velocity,
            gravity: p.gravity,
            max_fall_speed: p.max_fall_speed,
            reach: p.reach,
            attack_cooldown_ms: p.attack_cooldown_ms,
            day_length_secs: p.day_length_secs,
            mob_tick_ms: p.mob_tick_ms,
            fluid_tick_ms: p.fluid_tick_ms,
            fall_damage: p.fall_damage,
            hunger: p.hunger,
            zombie_cap_per_chunk: p.zombie_cap_per_chunk,
            pad: p._pad,
        }
    }
}

impl From<WorldParams> for phys::WorldParams {
    fn from(p: WorldParams) -> Self {
        phys::WorldParams {
            walk_speed: p.walk_speed,
            sprint_speed: p.sprint_speed,
            swim_speed: p.swim_speed,
            jump_velocity: p.jump_velocity,
            gravity: p.gravity,
            max_fall_speed: p.max_fall_speed,
            reach: p.reach,
            attack_cooldown_ms: p.attack_cooldown_ms,
            day_length_secs: p.day_length_secs,
            mob_tick_ms: p.mob_tick_ms,
            fluid_tick_ms: p.fluid_tick_ms,
            fall_damage: p.fall_damage,
            hunger: p.hunger,
            zombie_cap_per_chunk: p.zombie_cap_per_chunk,
            _pad: p.pad,
        }
    }
}

impl WorldParams {
    /// Range check via core (`InvalidParams` on any out-of-range field).
    pub fn validate(&self) -> Result<()> {
        phys::WorldParams::from(*self)
            .validate()
            .map_err(|_| error!(MagicraftError::InvalidParams))
    }
}

/// Default slot duration (µs) when `create_world` gets no hint (`us_per_slot_hint == 0`):
/// the local ER's 50 ms. Devnet ERs run ~10 ms slots, so clients pass a measured hint.
pub const DEFAULT_US_PER_SLOT: u32 = 50_000;
/// Bounds of every stored slot rate (hint, measurement, slewed rate), µs per slot.
pub const MIN_US_PER_SLOT: u32 = 1_000;
pub const MAX_US_PER_SLOT: u32 = 1_000_000;
/// [`TimeAnchor::reanchor`] jumps forward when the estimate lags wall time by more than
/// this, ms (< 1 s; wall time is `unix_timestamp · 1000 + 500`, the midpoint of its second).
pub const REANCHOR_DRIFT_MS: i64 = 750;
/// Offsets within this of wall time are left alone (wall time is only ±500 ms exact), ms.
pub const RATE_DEADBAND_MS: i64 = 500;
/// The slot rate is re-measured from wall time over spans at least this long, ms
/// (the 1 s `unix_timestamp` resolution then gives ≤ ~3 % rate error).
pub const RATE_SPAN_MS: i64 = 30_000;
/// [`TimeAnchor::read`] falls back to coarse wall time when the anchor is older than this
/// (the writer stopped re-anchoring) or the estimate is this far off wall time, ms.
pub const STALE_MS: i64 = 10_000;

/// Clamps a slot rate to [`MIN_US_PER_SLOT`]`..=`[`MAX_US_PER_SLOT`].
pub fn clamp_us_per_slot(us: u64) -> u32 {
    us.clamp(MIN_US_PER_SLOT as u64, MAX_US_PER_SLOT as u64) as u32
}

/// A chain-time reading.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChainTime {
    /// Chain time, ms.
    pub ms: i64,
    /// `true`: anchor unset or stale, `ms` is `unix_timestamp · 1000` (1 s resolution, not
    /// monotonic with earlier fine readings). Callers widen their tolerance (e.g. a move
    /// lead of 1000 ms instead of `physics::LEAD_MS`).
    pub coarse: bool,
}

/// Chain time with ms resolution (`Clock::unix_timestamp` has 1 s): `chain_ms = anchor_ms +
/// ⌊(slot − anchor_slot) · us_per_slot / 1000⌋`.
///
/// - **Readers** (gameplay ixs) call [`Self::read`] on a read-only World: never writes.
/// - **The writer** is `tick_day` (every ~1 s) plus the initial anchor in `create_world`
///   (rate = the client's measured hint, clamped, or [`DEFAULT_US_PER_SLOT`]); only it calls
///   [`Self::reanchor`].
///   - Rate: `base_us_per_slot` is measured from wall time since the sync point
///     (`sync_slot` / `sync_ms`). Before [`RATE_SPAN_MS`] every re-anchor checks the current
///     rate against the observed span (known to ±1 000 ms: `unix_timestamp` has 1 s
///     resolution) and replaces it by the measurement only when they are inconsistent, so
///     a good client hint is kept and a wrong one is replaced within a tick or two. Over
///     every [`RATE_SPAN_MS`] the measurement is adopted and the sync point moves.
///   - Offset, **after the first join** (`allow_back == false`): monotonic — the new anchor
///     is never below the estimate readers saw at that slot, so fine readings never go
///     backwards. Lagging by > [`REANCHOR_DRIFT_MS`] → jump forward to wall time; lagging
///     by more than [`RATE_DEADBAND_MS`] → run 1/8 fast; ahead by more than the deadband →
///     hold continuity and run 1/8 slow until wall time catches up (slew, never back).
///   - Offset, **before the first join** (`allow_back == true`, `World.first_join_ms == 0`:
///     no `PlayerState` holds a stamp from this clock yet): off by more than the deadband
///     in either direction → step to wall time, so a wrong initial rate is repaired within
///     a tick instead of slewing for minutes. The first `join_world` re-anchors this way
///     once more right before it stamps the new `PlayerState`.
///   - `us_per_slot` is the effective (slewed) rate readers use.
///
/// All-zero (`us_per_slot == 0`) = not anchored yet.
#[derive(
    AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, Default, PartialEq, Eq,
)]
pub struct TimeAnchor {
    pub anchor_slot: u64,
    pub anchor_ms: i64,
    /// Effective rate (base ± slew), µs per slot.
    pub us_per_slot: u32,
    /// Measured rate, µs per slot.
    pub base_us_per_slot: u32,
    /// Start of the current rate measurement: slot and wall ms.
    pub sync_slot: u64,
    pub sync_ms: i64,
}

fn wall_ms(unix_timestamp: i64) -> i64 {
    unix_timestamp.saturating_mul(1000)
}

impl TimeAnchor {
    /// First anchor (`create_world`), rate from the client's hint (µs per slot, clamped;
    /// 0 = [`DEFAULT_US_PER_SLOT`]).
    pub fn new(slot: u64, unix_timestamp: i64, us_per_slot_hint: u32) -> Self {
        let us = if us_per_slot_hint == 0 {
            DEFAULT_US_PER_SLOT
        } else {
            clamp_us_per_slot(us_per_slot_hint as u64)
        };
        TimeAnchor {
            anchor_slot: slot,
            anchor_ms: wall_ms(unix_timestamp).saturating_add(500),
            us_per_slot: us,
            base_us_per_slot: us,
            sync_slot: slot,
            sync_ms: wall_ms(unix_timestamp),
        }
    }

    /// Slot-based estimate (`anchor_ms` for slots before the anchor).
    pub fn estimate(&self, slot: u64) -> i64 {
        let dslot = slot.saturating_sub(self.anchor_slot) as i128;
        let d_ms = (dslot * self.us_per_slot as i128 / 1000).min(i64::MAX as i128) as i64;
        self.anchor_ms.saturating_add(d_ms)
    }

    /// Read-only chain time: the estimate, or coarse wall time if the anchor is unset or
    /// stale (see [`ChainTime::coarse`]).
    pub fn read(&self, slot: u64, unix_timestamp: i64) -> ChainTime {
        let wall = wall_ms(unix_timestamp);
        let coarse = ChainTime {
            ms: wall,
            coarse: true,
        };
        if self.us_per_slot == 0 {
            return coarse;
        }
        let est = self.estimate(slot);
        let age = est.saturating_sub(self.anchor_ms);
        if age > STALE_MS || est.saturating_sub(wall).saturating_abs() > STALE_MS {
            return coarse;
        }
        ChainTime {
            ms: est,
            coarse: false,
        }
    }

    /// Writer only: re-anchors at `slot` and returns the new chain time. Monotonic unless
    /// `allow_back` (no reader has stamped a `PlayerState` yet; see the type docs).
    pub fn reanchor(&mut self, slot: u64, unix_timestamp: i64, allow_back: bool) -> i64 {
        if self.us_per_slot == 0 {
            *self = Self::new(slot, unix_timestamp, 0);
            return self.anchor_ms;
        }
        let wall = wall_ms(unix_timestamp);
        let mut base = clamp_us_per_slot(self.base_us_per_slot as u64);
        let dslot = slot.saturating_sub(self.sync_slot);
        let dms = wall.saturating_sub(self.sync_ms);
        if dms >= 0 && dslot > 0 {
            let measured = clamp_us_per_slot(
                (dms as u128 * 1000 / dslot as u128).min(u64::MAX as u128) as u64,
            );
            if dms >= RATE_SPAN_MS {
                base = measured;
                self.sync_slot = slot;
                self.sync_ms = wall;
            } else {
                // Early check: the span the current rate predicts vs the observed one (±1 s).
                let predicted = base as i128 * dslot as i128 / 1000;
                if (predicted - dms as i128).abs() > 1_000 {
                    base = measured;
                }
            }
        } else if dms < 0 || slot < self.sync_slot {
            // Clock or slot went backwards: restart the measurement.
            self.sync_slot = slot;
            self.sync_ms = wall;
        }
        let est = self.estimate(slot);
        let target = wall.saturating_add(500);
        let err = target.saturating_sub(est); // > 0: the estimate lags
        let step_back = allow_back && err < -RATE_DEADBAND_MS;
        let slew = (base / 8).max(1);
        let ups = if step_back {
            base
        } else if err > RATE_DEADBAND_MS {
            base.saturating_add(slew).min(MAX_US_PER_SLOT)
        } else if err < -RATE_DEADBAND_MS {
            base.saturating_sub(slew).max(MIN_US_PER_SLOT)
        } else {
            base
        };
        let ms = if err > REANCHOR_DRIFT_MS || step_back {
            target
        } else {
            est
        };
        self.anchor_slot = self.anchor_slot.max(slot);
        self.anchor_ms = ms;
        self.us_per_slot = ups;
        self.base_us_per_slot = base;
        ms
    }
}

/// A crank (day or chunk tick) counts as stalled, and may be re-armed, when its last tick
/// is older than this, ms (3 ticks at the 1 s day cadence).
pub const CRANK_STALE_MS: i64 = 3_000;

/// Largest day advance per `tick_day`, ms (see [`World::advance_day`]).
pub const DAY_MAX_STEP_MS: i64 = STALE_MS;

/// A world. Ephemeral, ≤ 10 240 bytes so `create_world` needs one ix.
#[account]
#[derive(InitSpace)]
pub struct World {
    /// Wallet that created the world (`Player.authority`; seeds use it).
    pub creator: Pubkey,
    pub nonce: u64,
    pub bump: u8,
    pub name: [u8; 32],
    pub params: WorldParams,
    pub seed: [u8; 32],
    pub seed_set: bool,
    /// **Block** coordinates (not fixed-point) of the spawn feet block, set once by
    /// `set_spawn` from chunk (0,0). `join_world` / `respawn` convert to the FP feet
    /// position: `x·256 + 128, y·256, z·256 + 128` (block center).
    pub spawn: [i32; 3],
    pub spawn_set: bool,
    pub time_of_day_ms: u64,
    pub day_task_id: i64,
    pub last_tick_ms: i64,
    pub chunk_count: u32,
    pub clock: TimeAnchor,
    /// Wrapping count of `tick_day` executions (diagnostics: crank liveness / rate).
    pub day_ticks: u32,
    /// Epoch mixed into the day crank's task id (`scheduler::task_id`); a stale re-arm
    /// bumps it, so a squatted id is abandoned.
    pub day_epoch: u8,
    /// Chain ms of the first `join_world` (0 = nobody joined yet). Until then the day crank
    /// may step the clock backward (see [`TimeAnchor`]); afterwards it is monotonic.
    pub first_join_ms: i64,
    /// Players in the world now: `PlayerState.in_world` set (`join_world` / `enter_world`
    /// +1; `leave_world` / `expire_players` −1). See `instructions::play` ("Players in the
    /// world").
    pub players_online: u32,
    /// Wrapping count of entries (`join_world` + `enter_world` that set `in_world`).
    pub entries: u32,
    pub _reserved: [u8; 1],
}

// `create_world` creates the World in one CPI (≤ 10 240 bytes).
const _: () = assert!(8 + World::INIT_SPACE <= 10_240);

impl World {
    /// Writer path (`tick_day`, which holds the World mutably): monotonic re-anchor,
    /// returns chain ms.
    pub fn tick_clock(&mut self, clock: &Clock) -> i64 {
        let allow_back = self.first_join_ms == 0;
        self.clock
            .reanchor(clock.slot, clock.unix_timestamp, allow_back)
    }

    /// `join_world`: records the first join (from then on the clock never steps back).
    pub fn note_join(&mut self, now_ms: i64) {
        if self.first_join_ms == 0 {
            self.first_join_ms = now_ms.max(1);
        }
    }

    /// `callback_seed`: stores the VRF output once (`SeedAlreadySet` afterwards, so a
    /// second fulfilment cannot re-roll the world).
    pub fn set_seed(&mut self, randomness: [u8; 32]) -> Result<()> {
        require!(!self.seed_set, MagicraftError::SeedAlreadySet);
        self.seed = randomness;
        self.seed_set = true;
        Ok(())
    }

    /// `tick_day`. Seeded world: re-anchors the clock and advances the day. Unseeded
    /// (VRF pending, nobody can play yet): cheap liveness only — records `last_tick_ms`
    /// (read-only clock estimate) and `day_ticks`, no re-anchor, `time_of_day_ms` stays 0
    /// (the first day starts at sunrise once the seed lands).
    pub fn tick(&mut self, clock: &Clock) {
        if self.seed_set {
            let now = self.tick_clock(clock);
            self.advance_day(now);
        } else {
            let now = self.chain_ms_ro(clock).ms;
            self.last_tick_ms = self.last_tick_ms.max(now);
            self.day_ticks = self.day_ticks.wrapping_add(1);
        }
    }

    /// `schedule_day_crank` re-arms only when this is true (a replace restarts the task's
    /// timer and executes at once, so unconditional re-arms would let callers drive the tick
    /// rate): no tick for more than [`CRANK_STALE_MS`], or never ticked and created more
    /// than that ago (`clock.anchor_ms` is the creation anchor until the first re-anchor).
    pub fn day_crank_stale(&self, now_ms: i64) -> bool {
        let since = if self.last_tick_ms == 0 {
            self.clock.anchor_ms
        } else {
            self.last_tick_ms
        };
        now_ms.saturating_sub(since) > CRANK_STALE_MS
    }

    /// `tick_day`: advances `time_of_day_ms` by the chain time since the last tick (at
    /// most [`DAY_MAX_STEP_MS`], so a stalled crank pauses the day instead of jumping it;
    /// the first tick only records `last_tick_ms`), modulo the day length. Total: never
    /// panics or fails, whatever the stored state.
    pub fn advance_day(&mut self, now_ms: i64) {
        let day_ms = self.params.day_length_secs as u64 * 1000;
        if day_ms == 0 {
            self.time_of_day_ms = 0;
        } else if self.last_tick_ms > 0 {
            let step = now_ms
                .saturating_sub(self.last_tick_ms)
                .clamp(0, DAY_MAX_STEP_MS) as u64;
            self.time_of_day_ms = (self.time_of_day_ms % day_ms + step) % day_ms;
        } else {
            self.time_of_day_ms %= day_ms;
        }
        self.last_tick_ms = self.last_tick_ms.max(now_ms);
        self.day_ticks = self.day_ticks.wrapping_add(1);
    }

    /// Read-only chain time for gameplay ixs (never writes the World).
    pub fn chain_ms_ro(&self, clock: &Clock) -> ChainTime {
        self.clock.read(clock.slot, clock.unix_timestamp)
    }

    pub fn core_params(&self) -> phys::WorldParams {
        self.params.into()
    }
}

// ---------------------------------------------------------------------------
// PlayerState
// ---------------------------------------------------------------------------

pub const MAX_HEALTH: u8 = 20;

/// A player's state inside one world. Ephemeral.
#[account]
#[derive(InitSpace)]
pub struct PlayerState {
    /// The Player PDA.
    pub player: Pubkey,
    pub world: Pubkey,
    pub bump: u8,
    /// `core::physics::MoveState` bytes.
    pub move_state: [u8; 72],
    pub health: u8,
    pub food: u8,
    /// Food exhaustion accumulator (hunger drains one food point per threshold).
    pub exhaustion: u16,
    /// `core::inventory::Inventory` bytes.
    pub inventory: [u8; 216],
    pub held_slot: u8,
    /// Current chunk.
    pub cx: i32,
    pub cz: i32,
    pub break_until_ms: i64,
    pub attack_until_ms: i64,
    /// Last hunger / regeneration step, chain ms.
    pub food_tick_ms: i64,
    /// Chain ms of the last `respawn` (0 = never). Pending damage on an own presence entry
    /// last seen before it hit the dead body and is dropped (`presence::upsert`).
    pub respawn_ms: i64,
    /// 1 while the player is in the world (counted in `World.players_online`): set by
    /// `join_world` / `enter_world`, cleared by `leave_world` / `expire_players`.
    /// `move_player` requires it (`NotInWorld`).
    pub in_world: u8,
    pub _reserved: [u8; 25],
}

const _: () = assert!(MoveState::SIZE == 72 && Inventory::SIZE == 216);

impl PlayerState {
    /// Death has a single source of truth: `health == 0` (there is no separate flag).
    pub fn is_dead(&self) -> bool {
        self.health == 0
    }

    pub fn move_state(&self) -> Result<MoveState> {
        MoveState::from_bytes(&self.move_state)
            .map_err(|_| error!(MagicraftError::InvalidMoveState))
    }

    pub fn set_move_state(&mut self, s: &MoveState) {
        self.move_state = s.to_bytes();
    }

    /// Normalized inventory (never fails).
    pub fn inventory(&self) -> Inventory {
        Inventory::from_bytes(&self.inventory)
    }

    pub fn set_inventory(&mut self, inv: &Inventory) {
        self.inventory = inv.to_bytes();
    }
}

// ---------------------------------------------------------------------------
// Little-endian, alignment-1 integers for the manual layouts
// ---------------------------------------------------------------------------

macro_rules! le_int {
    ($name:ident, $t:ty, $n:expr) => {
        #[doc = concat!("Little-endian `", stringify!($t), "` with alignment 1.")]
        #[repr(transparent)]
        #[derive(Clone, Copy, Default, PartialEq, Eq, Pod, Zeroable)]
        pub struct $name(pub [u8; $n]);

        impl $name {
            #[inline]
            pub fn new(v: $t) -> Self {
                Self(v.to_le_bytes())
            }
            #[inline]
            pub fn get(self) -> $t {
                <$t>::from_le_bytes(self.0)
            }
            #[inline]
            pub fn set(&mut self, v: $t) {
                self.0 = v.to_le_bytes();
            }
        }

        impl core::fmt::Debug for $name {
            fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                self.get().fmt(f)
            }
        }
    };
}

le_int!(LeU16, u16, 2);
le_int!(LeI32, i32, 4);
le_int!(LeU64, u64, 8);
le_int!(LeI64, i64, 8);

// ---------------------------------------------------------------------------
// Chunk
// ---------------------------------------------------------------------------

/// `sha256("account:Chunk")[..8]`.
pub const CHUNK_DISCRIMINATOR: [u8; 8] = [0x86, 0x43, 0x50, 0x41, 0x87, 0x8f, 0x9c, 0xc4];
/// `sha256("account:ChunkPresence")[..8]`.
pub const PRESENCE_DISCRIMINATOR: [u8; 8] = [0x9b, 0xc2, 0x1d, 0x51, 0xbf, 0xfc, 0x83, 0x6b];

/// `gen_stage`: created at 10 240 bytes, not grown.
pub const GEN_CREATED: u8 = 0;
/// `gen_stage`: grown, stage-1 terrain written.
pub const GEN_STAGE1: u8 = 1;
/// `gen_stage`: populated; the chunk is playable.
pub const GEN_DONE: u8 = 2;

pub const CHUNK_HEADER_SIZE: usize = 768;
pub const CHUNK_BLOCKS_OFFSET: usize = CHUNK_HEADER_SIZE;
/// Length at creation (max growth of one CPI).
pub const CHUNK_INITIAL_LEN: usize = 10_240;
/// Length after `grow_chunk`.
pub const CHUNK_FULL_LEN: usize = CHUNK_GROUND_OFFSET + GroundItems::SIZE;
/// End of the block region: a chunk at least this long is playable. Chunks grown before
/// ground items existed end here (no ground region: their drops go to the inventory).
pub const CHUNK_BLOCKS_END: usize = CHUNK_BLOCKS_OFFSET + CHUNK_VOL;
/// Ground items (`core::ground::GroundItems` layout, 16 × 24 B) after the blocks.
pub const CHUNK_GROUND_OFFSET: usize = CHUNK_BLOCKS_END;

/// Fixed header of a `Chunk` account (layout table in the module docs).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct ChunkHeader {
    pub discriminator: [u8; 8],
    pub payer: Pubkey,
    pub world: Pubkey,
    pub cx: LeI32,
    pub cz: LeI32,
    pub bump: u8,
    pub edited: u8,
    pub gen_stage: u8,
    pub crank_armed: u8,
    pub task_id: LeI64,
    pub last_tick_ms: LeI64,
    pub tick_count: LeU64,
    pub biomes: [u8; 256],
    pub mobs: [u8; MOB_SLOTS * Mob::SIZE],
    pub fluid: [u8; FluidQueue::SIZE],
    pub presence_bump: u8,
    /// Bumps of the N, S, E, W neighbor chunk PDAs (`fluid` slot order), then of their
    /// presence PDAs: the tick crank's account list is derived without bump searches.
    pub nbr_bumps: [u8; 8],
    pub arm_tick: u8,
    /// Bit `i` set ⇔ neighbor `i` (N, S, E, W) exists (any generation stage); the tick
    /// crank's account list depends on it (missing neighbors are placeholders).
    pub nbr_mask: u8,
    /// Epoch mixed into the tick crank's task id; bumped when a writable arm finds the
    /// crank armed but stale (abandons a possibly squatted id).
    pub task_epoch: u8,
    /// Chain seconds (mod 2^16) of the last account-list repair (≤ 1 per 3 s).
    pub repair_s: LeU16,
}

const _: () = {
    assert!(core::mem::size_of::<ChunkHeader>() == CHUNK_HEADER_SIZE);
    assert!(core::mem::align_of::<ChunkHeader>() == 1);
    assert!(core::mem::offset_of!(ChunkHeader, payer) == 8);
    assert!(core::mem::offset_of!(ChunkHeader, world) == 40);
    assert!(core::mem::offset_of!(ChunkHeader, cx) == 72);
    assert!(core::mem::offset_of!(ChunkHeader, cz) == 76);
    assert!(core::mem::offset_of!(ChunkHeader, bump) == 80);
    assert!(core::mem::offset_of!(ChunkHeader, edited) == 81);
    assert!(core::mem::offset_of!(ChunkHeader, gen_stage) == 82);
    assert!(core::mem::offset_of!(ChunkHeader, crank_armed) == 83);
    assert!(core::mem::offset_of!(ChunkHeader, task_id) == 84);
    assert!(core::mem::offset_of!(ChunkHeader, last_tick_ms) == 92);
    assert!(core::mem::offset_of!(ChunkHeader, tick_count) == 100);
    assert!(core::mem::offset_of!(ChunkHeader, biomes) == 108);
    assert!(core::mem::offset_of!(ChunkHeader, mobs) == 364);
    assert!(core::mem::offset_of!(ChunkHeader, fluid) == 620);
    assert!(core::mem::offset_of!(ChunkHeader, presence_bump) == 754);
    assert!(core::mem::offset_of!(ChunkHeader, nbr_bumps) == 755);
    assert!(core::mem::offset_of!(ChunkHeader, arm_tick) == 763);
    assert!(core::mem::offset_of!(ChunkHeader, nbr_mask) == 764);
    assert!(core::mem::offset_of!(ChunkHeader, task_epoch) == 765);
    assert!(core::mem::offset_of!(ChunkHeader, repair_s) == 766);
    // The header must fit the creation size; the whole chunk must fit one resize.
    assert!(CHUNK_HEADER_SIZE <= CHUNK_INITIAL_LEN);
    assert!(CHUNK_FULL_LEN - CHUNK_INITIAL_LEN <= 10_240);
};

impl ChunkHeader {
    pub fn mob(&self, i: usize) -> Mob {
        let o = i * Mob::SIZE;
        Mob::from_bytes(self.mobs[o..o + Mob::SIZE].try_into().unwrap())
    }

    pub fn set_mob(&mut self, i: usize, m: &Mob) {
        let o = i * Mob::SIZE;
        self.mobs[o..o + Mob::SIZE].copy_from_slice(&m.to_bytes());
    }

    pub fn has_mobs(&self) -> bool {
        // `kind` is byte 0 of each slot (0 = empty).
        (0..MOB_SLOTS).any(|i| self.mobs[i * Mob::SIZE] != 0)
    }

    /// First empty mob slot.
    pub fn free_mob_slot(&self) -> Option<usize> {
        (0..MOB_SLOTS).find(|&i| self.mobs[i * Mob::SIZE] == 0)
    }

    /// `FluidQueue::has_work` straight from the bytes (`len` @131 non-zero or `overflow`
    /// @132 not clean), without decoding the queue.
    pub fn fluid_has_work(&self) -> bool {
        self.fluid[131] != 0 || self.fluid[132] != 0
    }

    /// The fluid queue (copied out; LE `repr(C)` layout: `buf` u16 × 64 @0,
    /// `rescan_cursor` u16 @128, `head` @130, `len` @131, `overflow` @132, `high_water` @133).
    pub fn fluid_queue(&self) -> FluidQueue {
        let b = &self.fluid;
        let mut q = FluidQueue::new();
        for (i, v) in q.buf.iter_mut().enumerate() {
            *v = u16::from_le_bytes([b[2 * i], b[2 * i + 1]]);
        }
        q.rescan_cursor = u16::from_le_bytes([b[128], b[129]]);
        q.head = b[130];
        q.len = b[131];
        q.overflow = b[132];
        q.high_water = b[133];
        q
    }

    pub fn set_fluid_queue(&mut self, q: &FluidQueue) {
        let b = &mut self.fluid;
        for (i, v) in q.buf.iter().enumerate() {
            b[2 * i..2 * i + 2].copy_from_slice(&v.to_le_bytes());
        }
        b[128..130].copy_from_slice(&q.rescan_cursor.to_le_bytes());
        b[130] = q.head;
        b[131] = q.len;
        b[132] = q.overflow;
        b[133] = q.high_water;
    }

    /// At full size (checked by the caller) and fully generated.
    pub fn is_done(&self) -> bool {
        self.gen_stage == GEN_DONE
    }
}

/// Header of `data` (any length ≥ the header; discriminator checked).
pub fn chunk_header_from(data: &[u8]) -> Result<&ChunkHeader> {
    let h = data
        .get(..CHUNK_HEADER_SIZE)
        .ok_or(error!(MagicraftError::InvalidChunk))?;
    let h: &ChunkHeader = bytemuck::from_bytes(h);
    require!(
        h.discriminator == CHUNK_DISCRIMINATOR,
        MagicraftError::InvalidChunk
    );
    Ok(h)
}

/// Mutable header of `data` (any length ≥ the header; discriminator checked).
pub fn chunk_header_from_mut(data: &mut [u8]) -> Result<&mut ChunkHeader> {
    let h = data
        .get_mut(..CHUNK_HEADER_SIZE)
        .ok_or(error!(MagicraftError::InvalidChunk))?;
    let h: &mut ChunkHeader = bytemuck::from_bytes_mut(h);
    require!(
        h.discriminator == CHUNK_DISCRIMINATOR,
        MagicraftError::InvalidChunk
    );
    Ok(h)
}

/// Header + blocks of a grown chunk (`ChunkNotReady` while the data is shorter than
/// [`CHUNK_FULL_LEN`]; generation stage not checked).
pub fn chunk_parts_from_mut(data: &mut [u8]) -> Result<(&mut ChunkHeader, &mut [u8; CHUNK_VOL])> {
    chunk_header_from(data)?;
    require!(
        data.len() >= CHUNK_BLOCKS_END,
        MagicraftError::ChunkNotReady
    );
    let (h, rest) = data.split_at_mut(CHUNK_BLOCKS_OFFSET);
    let blocks: &mut [u8; CHUNK_VOL] = (&mut rest[..CHUNK_VOL]).try_into().unwrap();
    Ok((bytemuck::from_bytes_mut(h), blocks))
}

/// Writes a fresh header into a just-created chunk (any prior bytes overwritten).
pub fn init_chunk_header(
    data: &mut [u8],
    payer: Pubkey,
    world: Pubkey,
    cx: i32,
    cz: i32,
    bump: u8,
) -> Result<&mut ChunkHeader> {
    let h = data
        .get_mut(..CHUNK_HEADER_SIZE)
        .ok_or(error!(MagicraftError::InvalidChunk))?;
    h.fill(0);
    let h: &mut ChunkHeader = bytemuck::from_bytes_mut(h);
    h.discriminator = CHUNK_DISCRIMINATOR;
    h.payer = payer;
    h.world = world;
    h.cx.set(cx);
    h.cz.set(cz);
    h.bump = bump;
    h.gen_stage = GEN_CREATED;
    h.set_fluid_queue(&FluidQueue::new());
    Ok(h)
}

fn check_owner(ai: &AccountInfo) -> Result<()> {
    require_keys_eq!(*ai.owner, crate::ID, MagicraftError::InvalidChunk);
    Ok(())
}

/// Borrowed header of a chunk account (owner + discriminator checked; any length).
pub fn chunk_header<'a>(ai: &'a AccountInfo) -> Result<core::cell::Ref<'a, ChunkHeader>> {
    check_owner(ai)?;
    let data = ai.try_borrow_data()?;
    chunk_header_from(&data)?;
    Ok(core::cell::Ref::map(data, |d| {
        bytemuck::from_bytes(&d[..CHUNK_HEADER_SIZE])
    }))
}

/// Mutably borrowed header of a chunk account (owner + discriminator checked; any length,
/// so it works on a not-yet-grown chunk).
pub fn chunk_header_mut<'a>(ai: &'a AccountInfo) -> Result<RefMut<'a, ChunkHeader>> {
    check_owner(ai)?;
    let mut data = ai.try_borrow_mut_data()?;
    chunk_header_from_mut(&mut data)?;
    Ok(RefMut::map(data, |d| {
        bytemuck::from_bytes_mut(&mut d[..CHUNK_HEADER_SIZE])
    }))
}

/// Mutably borrowed blocks of a grown chunk (`ChunkNotReady` before `grow_chunk`).
/// **Generation only** (`grow_chunk` / `populate_chunk`): the stage is not checked, and
/// `magicraft_core::terrain::stage1_info_from_blocks` relies on stage-1 blocks staying
/// untouched until populate. Gameplay must use [`ready_chunk_mut`] (`GEN_DONE`).
pub fn chunk_blocks_mut<'a>(ai: &'a AccountInfo) -> Result<RefMut<'a, [u8; CHUNK_VOL]>> {
    Ok(chunk_parts_mut(ai)?.1)
}

/// Header + blocks of a grown chunk (generation stage not checked: for `grow_chunk` /
/// `populate_chunk` only — `stage1_info_from_blocks` relies on stage-1 blocks staying
/// untouched until populate; gameplay uses [`ready_chunk_mut`]).
pub fn chunk_parts_mut<'a>(
    ai: &'a AccountInfo,
) -> Result<(RefMut<'a, ChunkHeader>, RefMut<'a, [u8; CHUNK_VOL]>)> {
    check_owner(ai)?;
    let mut data = ai.try_borrow_mut_data()?;
    chunk_parts_from_mut(&mut data)?;
    Ok(RefMut::map_split(data, |d| {
        let (h, rest) = d.split_at_mut(CHUNK_BLOCKS_OFFSET);
        let blocks: &mut [u8; CHUNK_VOL] = (&mut rest[..CHUNK_VOL]).try_into().unwrap();
        (bytemuck::from_bytes_mut::<ChunkHeader>(h), blocks)
    }))
}

/// Header + blocks of a playable chunk: full size **and** `GEN_DONE`, else `ChunkNotReady`.
pub fn ready_chunk_mut<'a>(
    ai: &'a AccountInfo,
) -> Result<(RefMut<'a, ChunkHeader>, RefMut<'a, [u8; CHUNK_VOL]>)> {
    let (h, b) = chunk_parts_mut(ai)?;
    require!(h.is_done(), MagicraftError::ChunkNotReady);
    Ok((h, b))
}

/// Header + blocks of the playable chunk `(cx, cz)` of `world` for gameplay writes (block
/// edits): [`ready_chunk_mut`] plus the stored world / coordinates (`InvalidChunk`),
/// **without** re-deriving the PDA (sound for the reason given at
/// [`ready_chunk_blocks_ro`]).
pub fn ready_chunk_mut_for<'a>(
    ai: &'a AccountInfo,
    world: &Pubkey,
    cx: i32,
    cz: i32,
) -> Result<(RefMut<'a, ChunkHeader>, RefMut<'a, [u8; CHUNK_VOL]>)> {
    let (h, b) = ready_chunk_mut(ai)?;
    require!(
        h.world == *world && h.cx.get() == cx && h.cz.get() == cz,
        MagicraftError::InvalidChunk
    );
    Ok((h, b))
}

/// Pure identity check of a chunk header against the expected world / coordinates and
/// its address (PDA from the stored bump).
pub fn check_chunk_identity(
    h: &ChunkHeader,
    key: &Pubkey,
    world: &Pubkey,
    cx: i32,
    cz: i32,
) -> Result<()> {
    require!(
        h.world == *world && h.cx.get() == cx && h.cz.get() == cz,
        MagicraftError::InvalidChunk
    );
    let (cxb, czb, bump) = (cx.to_le_bytes(), cz.to_le_bytes(), [h.bump]);
    let pda = Pubkey::create_program_address(
        &crate::auth::chunk_seeds(world, &cxb, &czb, &bump),
        &crate::ID,
    )
    .map_err(|_| error!(MagicraftError::InvalidChunk))?;
    require_keys_eq!(pda, *key, MagicraftError::InvalidChunk);
    Ok(())
}

/// The chunk `(cx, cz)` of `world`: owner, discriminator, stored world/cx/cz and the PDA
/// (stored bump) are checked, else `InvalidChunk`. Any length (not-yet-grown OK); use
/// [`ready_chunk_mut`] / [`chunk_parts_mut`] afterwards for blocks.
pub fn chunk_for<'a>(
    ai: &'a AccountInfo,
    world: &Pubkey,
    cx: i32,
    cz: i32,
) -> Result<RefMut<'a, ChunkHeader>> {
    let h = chunk_header_mut(ai)?;
    check_chunk_identity(&h, ai.key, world, cx, cz)?;
    Ok(h)
}

/// Read-only blocks of the playable chunk `(cx, cz)` of `world` for hot gameplay paths
/// (`move_player`): owner, discriminator, stored world / coordinates, full size and
/// `GEN_DONE` are checked (`InvalidChunk` / `ChunkNotReady`), **without** re-deriving the
/// PDA (a `create_program_address` costs ~1.5k CU per account). Sound because only this
/// program can own an account whose data starts with [`CHUNK_DISCRIMINATOR`], and the only
/// writer of a chunk header is `create_chunk`, which creates the account at the PDA of the
/// `(world, cx, cz)` it stores; no ix lets a user write header bytes. So stored identity ⇒
/// PDA identity.
pub fn ready_chunk_blocks_ro<'a>(
    ai: &'a AccountInfo,
    world: &Pubkey,
    cx: i32,
    cz: i32,
) -> Result<core::cell::Ref<'a, [u8; CHUNK_VOL]>> {
    check_owner(ai)?;
    let data = ai.try_borrow_data()?;
    let h = chunk_header_from(&data)?;
    require!(
        h.world == *world && h.cx.get() == cx && h.cz.get() == cz,
        MagicraftError::InvalidChunk
    );
    require!(
        h.is_done() && data.len() >= CHUNK_BLOCKS_END,
        MagicraftError::ChunkNotReady
    );
    Ok(core::cell::Ref::map(data, |d| {
        <&[u8; CHUNK_VOL]>::try_from(&d[CHUNK_BLOCKS_OFFSET..CHUNK_BLOCKS_END]).unwrap()
    }))
}

/// Blocks + ground items of a chunk account (owner + discriminator checked), `None` for a
/// chunk without the ground region (grown before it existed, or not grown yet).
#[allow(clippy::type_complexity)]
pub fn chunk_ground_mut<'a>(
    ai: &'a AccountInfo,
) -> Result<
    Option<(
        RefMut<'a, [u8; CHUNK_VOL]>,
        RefMut<'a, [u8; GroundItems::SIZE]>,
    )>,
> {
    check_owner(ai)?;
    let mut data = ai.try_borrow_mut_data()?;
    chunk_header_from_mut(&mut data)?;
    if data.len() < CHUNK_FULL_LEN {
        return Ok(None);
    }
    Ok(Some(RefMut::map_split(data, |d| {
        let (blocks, ground) = d[CHUNK_BLOCKS_OFFSET..CHUNK_FULL_LEN].split_at_mut(CHUNK_VOL);
        (
            <&mut [u8; CHUNK_VOL]>::try_from(blocks).unwrap(),
            <&mut [u8; GroundItems::SIZE]>::try_from(ground).unwrap(),
        )
    })))
}

// ---------------------------------------------------------------------------
// ChunkPresence
// ---------------------------------------------------------------------------

pub const PRESENCE_HEADER_SIZE: usize = 48;
pub const PRESENCE_ENTRY_SIZE: usize = 56;

/// Fixed header of a `ChunkPresence` account.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct PresenceHeader {
    pub discriminator: [u8; 8],
    pub chunk: Pubkey,
    pub bump: u8,
    pub _pad: u8,
    pub count: LeU16,
    pub _reserved: [u8; 4],
}

/// One player present in a chunk.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Debug, PartialEq, Eq)]
pub struct PresenceEntry {
    /// Player PDA.
    pub player: Pubkey,
    /// Feet position, FP.
    pub pos: [LeI32; 3],
    pub last_seen_ms: LeI64,
    /// Damage dealt by mobs, applied (and zeroed) by the player's next move.
    pub pending_damage: u8,
    pub _pad: [u8; 3],
}

const _: () = {
    assert!(core::mem::size_of::<PresenceHeader>() == PRESENCE_HEADER_SIZE);
    assert!(core::mem::size_of::<PresenceEntry>() == PRESENCE_ENTRY_SIZE);
    assert!(core::mem::align_of::<PresenceHeader>() == 1);
    assert!(core::mem::align_of::<PresenceEntry>() == 1);
    assert!(core::mem::offset_of!(PresenceHeader, bump) == 40);
    assert!(core::mem::offset_of!(PresenceHeader, count) == 42);
    assert!(core::mem::offset_of!(PresenceEntry, pos) == 32);
    assert!(core::mem::offset_of!(PresenceEntry, last_seen_ms) == 44);
    assert!(core::mem::offset_of!(PresenceEntry, pending_damage) == 52);
};

/// Account length for `n` entries.
pub const fn presence_len(n: usize) -> usize {
    PRESENCE_HEADER_SIZE + n * PRESENCE_ENTRY_SIZE
}

/// Writes a fresh, empty presence header.
pub fn init_presence_header(data: &mut [u8], chunk: Pubkey, bump: u8) -> Result<()> {
    let h = data
        .get_mut(..PRESENCE_HEADER_SIZE)
        .ok_or(error!(MagicraftError::InvalidPresence))?;
    h.fill(0);
    let h: &mut PresenceHeader = bytemuck::from_bytes_mut(h);
    h.discriminator = PRESENCE_DISCRIMINATOR;
    h.chunk = chunk;
    h.bump = bump;
    Ok(())
}

/// Header + entries of presence data. The length must be exactly `presence_len(count)`.
pub fn presence_parts_from_mut(
    data: &mut [u8],
) -> Result<(&mut PresenceHeader, &mut [PresenceEntry])> {
    require!(
        data.len() >= PRESENCE_HEADER_SIZE
            && (data.len() - PRESENCE_HEADER_SIZE).is_multiple_of(PRESENCE_ENTRY_SIZE),
        MagicraftError::InvalidPresence
    );
    let (h, rest) = data.split_at_mut(PRESENCE_HEADER_SIZE);
    let h: &mut PresenceHeader = bytemuck::from_bytes_mut(h);
    require!(
        h.discriminator == PRESENCE_DISCRIMINATOR
            && h.count.get() as usize == rest.len() / PRESENCE_ENTRY_SIZE,
        MagicraftError::InvalidPresence
    );
    Ok((h, bytemuck::cast_slice_mut(rest)))
}

/// Header + entries of a presence account (owner checked).
pub fn presence_mut<'a>(
    ai: &'a AccountInfo,
) -> Result<(RefMut<'a, PresenceHeader>, RefMut<'a, [PresenceEntry]>)> {
    require_keys_eq!(*ai.owner, crate::ID, MagicraftError::InvalidPresence);
    let mut data = ai.try_borrow_mut_data()?;
    presence_parts_from_mut(&mut data)?;
    Ok(RefMut::map_split(data, |d| {
        let (h, rest) = d.split_at_mut(PRESENCE_HEADER_SIZE);
        (
            bytemuck::from_bytes_mut::<PresenceHeader>(h),
            bytemuck::cast_slice_mut::<u8, PresenceEntry>(rest),
        )
    }))
}

/// Pure identity check of a presence header against its chunk and address.
pub fn check_presence_identity(h: &PresenceHeader, key: &Pubkey, chunk: &Pubkey) -> Result<()> {
    require_keys_eq!(h.chunk, *chunk, MagicraftError::InvalidPresence);
    let bump = [h.bump];
    let pda =
        Pubkey::create_program_address(&crate::auth::presence_seeds(chunk, &bump), &crate::ID)
            .map_err(|_| error!(MagicraftError::InvalidPresence))?;
    require_keys_eq!(pda, *key, MagicraftError::InvalidPresence);
    Ok(())
}

/// The presence list of `chunk`: owner, discriminator, length/count, stored chunk and the
/// PDA (stored bump) are checked, else `InvalidPresence`.
pub fn presence_for<'a>(
    ai: &'a AccountInfo,
    chunk: &Pubkey,
) -> Result<(RefMut<'a, PresenceHeader>, RefMut<'a, [PresenceEntry]>)> {
    let (h, e) = presence_mut(ai)?;
    check_presence_identity(&h, ai.key, chunk)?;
    Ok((h, e))
}

/// Like [`presence_for`] but without re-deriving the PDA (hot path, `move_player`): owner,
/// discriminator, length/count and the stored `chunk` are checked. Sound for the same
/// reason as [`ready_chunk_blocks_ro`]: only `create_chunk` writes a presence header, at
/// the PDA `["presence", chunk]` of the chunk it stores.
pub fn presence_of<'a>(
    ai: &'a AccountInfo,
    chunk: &Pubkey,
) -> Result<(RefMut<'a, PresenceHeader>, RefMut<'a, [PresenceEntry]>)> {
    let (h, e) = presence_mut(ai)?;
    require_keys_eq!(h.chunk, *chunk, MagicraftError::InvalidPresence);
    Ok((h, e))
}

/// Read-only entries of the presence list of `chunk` (same checks as [`presence_of`]:
/// owner, discriminator, length/count, stored `chunk`; no PDA derivation).
pub fn presence_entries_ro<'a>(
    ai: &'a AccountInfo,
    chunk: &Pubkey,
) -> Result<core::cell::Ref<'a, [PresenceEntry]>> {
    require_keys_eq!(*ai.owner, crate::ID, MagicraftError::InvalidPresence);
    let data = ai.try_borrow_data()?;
    require!(
        data.len() >= PRESENCE_HEADER_SIZE
            && (data.len() - PRESENCE_HEADER_SIZE).is_multiple_of(PRESENCE_ENTRY_SIZE),
        MagicraftError::InvalidPresence
    );
    let h: &PresenceHeader = bytemuck::from_bytes(&data[..PRESENCE_HEADER_SIZE]);
    require!(
        h.discriminator == PRESENCE_DISCRIMINATOR
            && h.count.get() as usize == (data.len() - PRESENCE_HEADER_SIZE) / PRESENCE_ENTRY_SIZE
            && h.chunk == *chunk,
        MagicraftError::InvalidPresence
    );
    Ok(core::cell::Ref::map(data, |d| {
        bytemuck::cast_slice::<u8, PresenceEntry>(&d[PRESENCE_HEADER_SIZE..])
    }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::{AnchorSerialize, Discriminator};
    use magicraft_core::inventory::Inventory;
    use magicraft_core::items::Item;

    fn borsh<T: AnchorSerialize>(v: &T) -> Vec<u8> {
        let mut b = Vec::new();
        v.serialize(&mut b).unwrap();
        b
    }

    #[test]
    fn borsh_account_sizes() {
        assert_eq!(8 + Player::INIT_SPACE, 105);
        assert_eq!(8 + World::INIT_SPACE, 265);
        assert_eq!(8 + PlayerState::INIT_SPACE, 432);
    }

    #[test]
    fn player_open_chunks_offset() {
        let p = Player {
            authority: Pubkey::new_from_array([7; 32]),
            bump: 254,
            open_chunks: 0x0102_0304,
            _reserved: [0; 60],
        };
        let b = borsh(&p);
        assert_eq!(b.len(), Player::INIT_SPACE);
        // Account offsets are these + 8 (discriminator): bump @40, open_chunks @41.
        assert_eq!(b[32], 254);
        assert_eq!(&b[33..37], &0x0102_0304u32.to_le_bytes());
    }

    #[test]
    fn world_params_mirror_matches_core_bytes() {
        let core = phys::WorldParams::default();
        let mirror = WorldParams::from(core);
        assert_eq!(borsh(&mirror), core.to_bytes().to_vec());
        assert_eq!(phys::WorldParams::from(mirror), core);
        assert!(mirror.validate().is_ok());
        let bad = WorldParams {
            walk_speed: 0,
            ..mirror
        };
        assert!(bad.validate().is_err());
    }

    #[test]
    fn world_field_offsets() {
        let w = World {
            creator: Pubkey::new_from_array([1; 32]),
            nonce: 0x1122_3344_5566_7788,
            bump: 9,
            name: [b'n'; 32],
            params: phys::WorldParams::default().into(),
            seed: [3; 32],
            seed_set: true,
            spawn: [-1, 40, 2],
            spawn_set: true,
            time_of_day_ms: 5,
            day_task_id: 6,
            last_tick_ms: 7,
            chunk_count: 8,
            clock: TimeAnchor {
                anchor_slot: 10,
                anchor_ms: 11,
                us_per_slot: 12,
                base_us_per_slot: 13,
                sync_slot: 14,
                sync_ms: 15,
            },
            day_ticks: 16,
            day_epoch: 0,
            first_join_ms: 17,
            players_online: 0,
            entries: 0,
            _reserved: [0; 1],
        };
        let mut b = World::DISCRIMINATOR.to_vec();
        b.extend(borsh(&w));
        assert_eq!(b.len(), 265);
        assert_eq!(&b[40..48], &w.nonce.to_le_bytes());
        assert_eq!(b[48], 9);
        assert_eq!(&b[81..129], &phys::WorldParams::default().to_bytes());
        assert_eq!(b[161], 1);
        assert_eq!(&b[162..166], &(-1i32).to_le_bytes());
        assert_eq!(b[174], 1);
        assert_eq!(&b[175..183], &5u64.to_le_bytes());
        assert_eq!(&b[183..191], &6i64.to_le_bytes());
        assert_eq!(&b[191..199], &7i64.to_le_bytes());
        assert_eq!(&b[199..203], &8u32.to_le_bytes());
        assert_eq!(&b[203..211], &10u64.to_le_bytes());
        assert_eq!(&b[211..219], &11i64.to_le_bytes());
        assert_eq!(&b[219..223], &12u32.to_le_bytes());
        assert_eq!(&b[223..227], &13u32.to_le_bytes());
        assert_eq!(&b[227..235], &14u64.to_le_bytes());
        assert_eq!(&b[235..243], &15i64.to_le_bytes());
        assert_eq!(&b[243..247], &16u32.to_le_bytes());
        assert_eq!(&b[248..256], &17i64.to_le_bytes());
    }

    #[test]
    fn player_state_offsets_and_roundtrips() {
        let ms = MoveState::spawn([256 * 8, 256 * 40, -256 * 3], 123_456);
        let mut inv = Inventory::new();
        assert_eq!(inv.add(Item::Log, 5), 0);
        let mut s = PlayerState {
            player: Pubkey::new_from_array([1; 32]),
            world: Pubkey::new_from_array([2; 32]),
            bump: 3,
            move_state: [0; 72],
            health: 20,
            food: 19,
            exhaustion: 0xABCD,
            inventory: [0; 216],
            held_slot: 4,
            cx: -2,
            cz: 5,
            break_until_ms: 100,
            attack_until_ms: 200,
            food_tick_ms: 300,
            respawn_ms: 400,
            in_world: 0,
            _reserved: [0; 25],
        };
        s.set_move_state(&ms);
        s.set_inventory(&inv);
        assert_eq!(s.move_state().unwrap(), ms);
        assert_eq!(s.inventory(), inv);
        let mut b = PlayerState::DISCRIMINATOR.to_vec();
        b.extend(borsh(&s));
        assert_eq!(b.len(), 432);
        assert_eq!(b[72], 3);
        assert_eq!(&b[73..145], &ms.to_bytes());
        assert_eq!((b[145], b[146]), (20, 19));
        assert_eq!(&b[147..149], &0xABCDu16.to_le_bytes());
        assert_eq!(&b[149..365], &inv.to_bytes());
        assert_eq!(b[365], 4);
        assert_eq!(&b[366..370], &(-2i32).to_le_bytes());
        assert_eq!(&b[370..374], &5i32.to_le_bytes());
        assert_eq!(&b[374..382], &100i64.to_le_bytes());
        assert_eq!(&b[382..390], &200i64.to_le_bytes());
        assert_eq!(&b[390..398], &300i64.to_le_bytes());
        assert_eq!(&b[398..406], &400i64.to_le_bytes());
        assert!(!s.is_dead());
        s.health = 0;
        assert!(s.is_dead());
        // Corrupt bool byte in MoveState → error, not panic.
        s.move_state[48] = 2;
        assert!(s.move_state().is_err());
    }

    #[test]
    fn chunk_header_layout_and_roundtrips() {
        let mut data = vec![0xEEu8; CHUNK_INITIAL_LEN];
        let payer = Pubkey::new_from_array([4; 32]);
        let world = Pubkey::new_from_array([5; 32]);
        {
            let h = init_chunk_header(&mut data, payer, world, -3, 7, 250).unwrap();
            h.task_id.set(-9);
            let mut m = Mob::EMPTY;
            m.kind = magicraft_core::mobs::KIND_PIG;
            m.hp = 10;
            m.pos = [1, 2, 3];
            h.set_mob(7, &m);
            assert!(h.has_mobs());
            let mut q = FluidQueue::new();
            assert!(q.push(300) && q.push(1234));
            q.pop();
            h.set_fluid_queue(&q);
            assert_eq!(h.fluid_queue(), q);
        }
        assert_eq!(&data[..8], &CHUNK_DISCRIMINATOR);
        assert_eq!(&data[8..40], payer.as_ref());
        assert_eq!(&data[40..72], world.as_ref());
        assert_eq!(&data[72..76], &(-3i32).to_le_bytes());
        assert_eq!(&data[76..80], &7i32.to_le_bytes());
        assert_eq!((data[80], data[81], data[82]), (250, 0, GEN_CREATED));
        assert_eq!(&data[84..92], &(-9i64).to_le_bytes());
        assert_eq!(data[364 + 7 * 32], magicraft_core::mobs::KIND_PIG);
        // Fluid queue bytes equal the core repr(C) layout (LE target).
        let h = chunk_header_from(&data).unwrap();
        let q = h.fluid_queue();
        let raw: [u8; FluidQueue::SIZE] =
            unsafe { core::mem::transmute::<FluidQueue, [u8; FluidQueue::SIZE]>(q) };
        assert_eq!(&data[620..754], &raw);
        // Header area ends at 768; block bytes untouched.
        assert!(data[CHUNK_HEADER_SIZE..].iter().all(|&b| b == 0xEE));
    }

    #[test]
    fn chunk_not_grown_is_not_ready() {
        let mut data = vec![0u8; CHUNK_INITIAL_LEN];
        init_chunk_header(&mut data, Pubkey::default(), Pubkey::default(), 0, 0, 1).unwrap();
        assert!(chunk_header_from_mut(&mut data).is_ok());
        let e = chunk_parts_from_mut(&mut data).err().unwrap();
        assert_eq!(e, error!(MagicraftError::ChunkNotReady));
        // A legacy chunk (blocks, no ground region) is playable.
        data.resize(CHUNK_BLOCKS_END, 0);
        let (h, blocks) = chunk_parts_from_mut(&mut data).unwrap();
        assert_eq!(h.cx.get(), 0);
        blocks[CHUNK_VOL - 1] = 42;
        assert_eq!(data[CHUNK_BLOCKS_END - 1], 42);
        assert_eq!(CHUNK_BLOCKS_END, 17_152);
        assert_eq!(CHUNK_FULL_LEN, 17_536);
    }

    #[test]
    fn chunk_rejects_short_or_foreign_data() {
        let mut short = vec![0u8; CHUNK_HEADER_SIZE - 1];
        assert_eq!(
            chunk_header_from_mut(&mut short).err().unwrap(),
            error!(MagicraftError::InvalidChunk)
        );
        let mut other = vec![0u8; CHUNK_FULL_LEN];
        other[..8].copy_from_slice(&PlayerState::DISCRIMINATOR[..8]);
        assert!(chunk_header_from(&other).is_err());
        assert!(chunk_parts_from_mut(&mut other).is_err());
    }

    #[test]
    fn presence_layout() {
        let chunk = Pubkey::new_from_array([6; 32]);
        let mut data = vec![0u8; presence_len(0)];
        init_presence_header(&mut data, chunk, 200).unwrap();
        {
            let (h, e) = presence_parts_from_mut(&mut data).unwrap();
            assert_eq!(e.len(), 0);
            h.count.set(2);
        }
        // count says 2 but there is no room → rejected.
        assert!(presence_parts_from_mut(&mut data).is_err());
        data.resize(presence_len(2), 0);
        {
            let (_, e) = presence_parts_from_mut(&mut data).unwrap();
            e[1].player = Pubkey::new_from_array([9; 32]);
            e[1].pos = [LeI32::new(-1), LeI32::new(2), LeI32::new(3)];
            e[1].last_seen_ms.set(77);
            e[1].pending_damage = 5;
        }
        let o = PRESENCE_HEADER_SIZE + PRESENCE_ENTRY_SIZE;
        assert_eq!(&data[40..44], &[200, 0, 2, 0]);
        assert_eq!(data[o], 9);
        assert_eq!(&data[o + 32..o + 36], &(-1i32).to_le_bytes());
        assert_eq!(&data[o + 44..o + 52], &77i64.to_le_bytes());
        assert_eq!(data[o + 52], 5);
        // Misaligned length rejected.
        data.push(0);
        assert!(presence_parts_from_mut(&mut data).is_err());
    }

    #[test]
    fn chunk_and_presence_identity() {
        let world = Pubkey::new_unique();
        let (cx, cz) = (-4i32, 9i32);
        let (key, bump) = Pubkey::find_program_address(
            &[
                CHUNK_SEED,
                world.as_ref(),
                &cx.to_le_bytes(),
                &cz.to_le_bytes(),
            ],
            &crate::ID,
        );
        let mut data = vec![0u8; CHUNK_INITIAL_LEN];
        let h = init_chunk_header(&mut data, Pubkey::new_unique(), world, cx, cz, bump).unwrap();
        assert!(check_chunk_identity(h, &key, &world, cx, cz).is_ok());
        let bad = error!(MagicraftError::InvalidChunk);
        assert_eq!(
            check_chunk_identity(h, &key, &world, cx + 1, cz).err(),
            Some(bad)
        );
        assert!(check_chunk_identity(h, &key, &Pubkey::new_unique(), cx, cz).is_err());
        assert!(check_chunk_identity(h, &Pubkey::new_unique(), &world, cx, cz).is_err());
        h.bump = h.bump.wrapping_sub(1);
        assert!(check_chunk_identity(h, &key, &world, cx, cz).is_err());

        let (pkey, pbump) =
            Pubkey::find_program_address(&[PRESENCE_SEED, key.as_ref()], &crate::ID);
        let mut pd = vec![0u8; presence_len(0)];
        init_presence_header(&mut pd, key, pbump).unwrap();
        let (ph, _) = presence_parts_from_mut(&mut pd).unwrap();
        assert!(check_presence_identity(ph, &pkey, &key).is_ok());
        assert!(check_presence_identity(ph, &pkey, &Pubkey::new_unique()).is_err());
        assert!(check_presence_identity(ph, &key, &key).is_err());
    }

    #[test]
    fn sponsor_reserve() {
        let rent = 1_000_000;
        let need = rent + SPONSOR_RESERVE_MARGIN;
        assert!(sponsor_can_pay(need + 500, rent, 500));
        assert!(!sponsor_can_pay(need + 499, rent, 500));
        assert!(!sponsor_can_pay(100, rent, 500));
        assert!(!sponsor_can_pay(u64::MAX, u64::MAX, 0));
    }

    fn test_world() -> World {
        World {
            creator: Pubkey::default(),
            nonce: 0,
            bump: 0,
            name: [0; 32],
            params: phys::WorldParams::default().into(),
            seed: [0; 32],
            seed_set: false,
            spawn: [0; 3],
            spawn_set: false,
            time_of_day_ms: 0,
            day_task_id: 0,
            last_tick_ms: 0,
            chunk_count: 0,
            clock: TimeAnchor::default(),
            day_ticks: 0,
            day_epoch: 0,
            first_join_ms: 0,
            players_online: 0,
            entries: 0,
            _reserved: [0; 1],
        }
    }

    #[test]
    fn set_seed_only_once() {
        let mut w = test_world();
        w.set_seed([7; 32]).unwrap();
        assert!(w.seed_set);
        assert_eq!(
            w.set_seed([9; 32]).unwrap_err(),
            error!(MagicraftError::SeedAlreadySet)
        );
        assert_eq!(w.seed, [7; 32]);
    }

    #[test]
    fn day_crank_staleness() {
        let mut w = test_world();
        w.clock = TimeAnchor::new(0, 1_000, 0); // anchor_ms = 1_000_500
        assert!(!w.day_crank_stale(1_000_500 + CRANK_STALE_MS));
        assert!(w.day_crank_stale(1_000_501 + CRANK_STALE_MS));
        w.last_tick_ms = 2_000_000;
        assert!(!w.day_crank_stale(2_000_000 + CRANK_STALE_MS));
        assert!(w.day_crank_stale(2_000_001 + CRANK_STALE_MS));
        assert!(!w.day_crank_stale(i64::MIN));
    }

    #[test]
    fn unseeded_tick_is_liveness_only() {
        let mut w = test_world();
        w.clock = TimeAnchor::new(100, 1_000, 0);
        let before = w.clock;
        let clock = Clock {
            slot: 120,
            unix_timestamp: 1_001,
            ..Default::default()
        };
        w.tick(&clock);
        assert_eq!(w.clock, before);
        assert_eq!(w.time_of_day_ms, 0);
        assert_eq!(w.day_ticks, 1);
        assert_eq!(w.last_tick_ms, before.estimate(120));
        w.seed_set = true;
        w.tick(&clock);
        assert_ne!(w.clock, before);
        assert_eq!(w.day_ticks, 2);
    }

    #[test]
    fn advance_day_wraps_clamps_and_is_total() {
        let mut w = test_world();
        w.params.day_length_secs = 60;
        // First tick: only records the time.
        w.advance_day(1_000_000);
        assert_eq!((w.time_of_day_ms, w.last_tick_ms), (0, 1_000_000));
        w.advance_day(1_001_000);
        assert_eq!(w.time_of_day_ms, 1_000);
        // Wraps modulo the day.
        w.time_of_day_ms = 59_500;
        w.advance_day(1_002_000);
        assert_eq!(w.time_of_day_ms, 500);
        // A long stall advances at most DAY_MAX_STEP_MS.
        w.advance_day(1_002_000 + 3_600_000);
        assert_eq!(w.time_of_day_ms, 500 + DAY_MAX_STEP_MS as u64);
        // Time going backwards: no advance, last_tick_ms stays monotonic.
        let (t, l) = (w.time_of_day_ms, w.last_tick_ms);
        w.advance_day(5);
        assert_eq!((w.time_of_day_ms, w.last_tick_ms), (t, l));
        // Garbage state never panics.
        w.time_of_day_ms = u64::MAX;
        w.last_tick_ms = i64::MIN + 1;
        w.advance_day(i64::MAX);
        assert!(w.time_of_day_ms < 60_000);
        w.params.day_length_secs = 0;
        w.advance_day(0);
        assert_eq!(w.time_of_day_ms, 0);
    }

    #[test]
    fn time_anchor_unset_reads_coarse_and_first_write_anchors() {
        let mut t = TimeAnchor::default();
        assert_eq!(
            t.read(100, 1_700_000_000),
            ChainTime {
                ms: 1_700_000_000_000,
                coarse: true
            }
        );
        assert_eq!(t.reanchor(100, 1_700_000_000, false), 1_700_000_000_500);
        assert_eq!((t.anchor_slot, t.us_per_slot), (100, DEFAULT_US_PER_SLOT));
        assert_eq!(t, TimeAnchor::new(100, 1_700_000_000, 0));
    }

    #[test]
    fn time_anchor_hint_is_clamped() {
        let us = |h| TimeAnchor::new(0, 1_000, h).us_per_slot;
        assert_eq!(us(0), DEFAULT_US_PER_SLOT);
        assert_eq!(us(9_800), 9_800);
        assert_eq!(us(1), MIN_US_PER_SLOT);
        assert_eq!(us(u32::MAX), MAX_US_PER_SLOT);
        assert_eq!(TimeAnchor::new(0, 1_000, 9_800).base_us_per_slot, 9_800);
    }

    #[test]
    fn time_anchor_read_estimates_between_seconds() {
        let t = TimeAnchor {
            anchor_slot: 100,
            anchor_ms: 1_000_000,
            us_per_slot: 9_750,
            ..Default::default()
        };
        assert_eq!(
            t.read(107, 1_000),
            ChainTime {
                ms: 1_000_068, // ⌊7 · 9 750 / 1 000⌋
                coarse: false
            }
        );
    }

    #[test]
    fn time_anchor_stale_falls_back_to_coarse() {
        let t = TimeAnchor {
            anchor_slot: 0,
            anchor_ms: 1_000_000,
            us_per_slot: 50_000,
            ..Default::default()
        };
        // 10 s after the anchor: still fine.
        assert!(!t.read(200, 1_010).coarse);
        // Writer stopped for > 10 s.
        assert_eq!(
            t.read(201, 1_010),
            ChainTime {
                ms: 1_010_000,
                coarse: true
            }
        );
        // Estimate far from wall time.
        assert!(t.read(10, 1_020).coarse);
    }

    /// Simulates a validator with `real_us` µs slots: `create_world` at slot 0 with
    /// `hint` (0 = default), `tick_day` re-anchoring once per wall second, a reader at every
    /// slot, and the first join `join_ms` after creation (None = never). Checks: after the
    /// first join no reading or re-anchor ever goes back; fine readings from `join_s`
    /// on. Returns the worst |estimate − truth| from 10 s on and the final base rate.
    fn simulate(real_us: i64, hint: u32, join_ms: Option<i64>) -> (i64, u32) {
        let t0: i64 = 1_700_000_000_123; // true ms at slot 0
        let truth = |slot: u64| t0 + slot as i64 * real_us / 1000;
        let unix = |slot: u64| truth(slot).div_euclid(1000);
        let mut a = TimeAnchor::new(0, unix(0), hint);
        let per_sec = (1_000_000 / real_us) as u64; // slots per tick
        let end = per_sec * 600; // 10 minutes
        let mut joined = false;
        let mut last = i64::MIN;
        let mut worst = 0i64;
        for slot in 1..=end {
            let secs = (truth(slot) - t0) / 1000;
            if !joined && join_ms.is_some_and(|j| truth(slot) - t0 >= j) {
                // join_world: a last backward-capable re-anchor, then the first stamp.
                a.reanchor(slot, unix(slot), true);
                joined = true;
                last = a.read(slot, unix(slot)).ms;
            }
            if slot % per_sec == 0 {
                let ms = a.reanchor(slot, unix(slot), !joined);
                if joined {
                    assert!(ms >= last, "reanchor went back at slot {slot}");
                    last = ms;
                }
            }
            let r = a.read(slot, unix(slot));
            if joined {
                assert!(!r.coarse, "coarse at slot {slot} ({secs} s)");
                assert!(
                    r.ms >= last,
                    "read went back at slot {slot}: {} < {last}",
                    r.ms
                );
                last = r.ms;
            }
            if secs >= 10 {
                worst = worst.max((r.ms - truth(slot)).abs());
            }
        }
        (worst, a.base_us_per_slot)
    }

    #[test]
    fn time_anchor_converges_for_10_50_100_ms_slots_with_any_hint() {
        let mut bad = vec![];
        for real_us in [10_000i64, 9_750, 50_000, 100_000] {
            for hint in [0u32, real_us as u32, 50_000, 10_000, 100_000, 1, u32::MAX] {
                for join_ms in [
                    None,
                    Some(300),
                    Some(900),
                    Some(1_500),
                    Some(6_000),
                    Some(12_000),
                ] {
                    let (err, base) = simulate(real_us, hint, join_ms);
                    let rel = (base as i64 - real_us).abs() * 100 / real_us;
                    if err >= 1_000 || rel > 5 {
                        bad.push(format!(
                            "real {real_us} hint {hint} join {join_ms:?}: err {err} base {base}"
                        ));
                    }
                }
            }
        }
        assert!(bad.is_empty(), "{}", bad.join("\n"));
    }

    #[test]
    fn time_anchor_steps_back_only_before_the_first_join() {
        // 10 ms slots, default 50 ms rate: one second later the estimate is ~4 s ahead.
        let mut t = TimeAnchor::new(0, 1_000, 0);
        let est = t.estimate(100);
        assert!(est > 1_004_000);
        let mut joined = t;
        // Before the first join: steps back to wall time.
        assert_eq!(t.reanchor(100, 1_001, true), 1_001_500);
        // After it: holds the estimate and slews.
        assert_eq!(joined.reanchor(100, 1_001, false), est);
        assert!(joined.us_per_slot < DEFAULT_US_PER_SLOT);
    }

    #[test]
    fn world_first_join_freezes_backward_steps() {
        let mut w = test_world();
        w.seed_set = true;
        w.clock = TimeAnchor::new(0, 1_000, 0);
        let clock = |slot, unix_timestamp| Clock {
            slot,
            unix_timestamp,
            ..Default::default()
        };
        w.tick(&clock(100, 1_001));
        assert_eq!(w.clock.anchor_ms, 1_001_500); // stepped back (10 ms slots)
        w.note_join(1_001_600);
        w.note_join(9_999_999);
        assert_eq!(w.first_join_ms, 1_001_600);
        let before = w.clock.estimate(200);
        w.tick(&clock(200, 1_002));
        assert!(w.clock.anchor_ms >= before);
    }

    #[test]
    fn time_anchor_is_total() {
        let edge = [
            TimeAnchor {
                anchor_slot: u64::MAX,
                anchor_ms: i64::MAX,
                us_per_slot: u32::MAX,
                ..Default::default()
            },
            TimeAnchor {
                anchor_slot: 0,
                anchor_ms: i64::MIN,
                us_per_slot: u32::MAX,
                ..Default::default()
            },
            TimeAnchor {
                anchor_slot: 5,
                anchor_ms: 0,
                us_per_slot: 1,
                ..Default::default()
            },
        ];
        for t in edge {
            for (slot, unix) in [(0, i64::MIN), (u64::MAX, i64::MAX), (3, 0), (7, -5)] {
                let _ = t.read(slot, unix);
                let mut w = t;
                let before = w.estimate(slot);
                let ms = w.reanchor(slot, unix, false);
                assert!(ms >= before, "reanchor went back");
                let mut w = t;
                let _ = w.reanchor(slot, unix, true);
            }
        }
    }
}
