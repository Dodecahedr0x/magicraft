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
//! | 162 | `spawn` | [i32; 3] (block coordinates of the feet block) |
//! | 174 | `spawn_set` | bool |
//! | 175 | `time_of_day_ms` | u64 (0 ..< day_length_secs·1000) |
//! | 183 | `day_task_id` | i64 (0 = not scheduled) |
//! | 191 | `last_tick_ms` | i64 (chain ms of the last `tick_day`) |
//! | 199 | `chunk_count` | u32 |
//! | 203 | `clock` | [`TimeAnchor`]: `anchor_slot` u64 @203, `anchor_ms` i64 @211, `ms_per_slot` u32 @219 |
//! | 223 | `_reserved` | [u8; 42] |
//!
//! # `PlayerState` (ephemeral), PDA `["pstate", world, player]`, 432 bytes
//! | off | field | type |
//! |---|---|---|
//! | 0 | discriminator | [u8; 8] |
//! | 8 | `player` | Pubkey (Player PDA) |
//! | 40 | `world` | Pubkey |
//! | 72 | `bump` | u8 |
//! | 73 | `move_state` | [u8; 72] (`core::physics::MoveState` layout) |
//! | 145 | `health` | u8 (0..=20; 0 = dead) |
//! | 146 | `food` | u8 (0..=20) |
//! | 147 | `exhaustion` | u16 (hunger accumulator) |
//! | 149 | `inventory` | [u8; 216] (`core::inventory::Inventory` layout) |
//! | 365 | `held_slot` | u8 |
//! | 366 | `dead` | bool |
//! | 367 | `cx`, `cz` | i32, i32 (current chunk) @367, @371 |
//! | 375 | `break_until_ms` | i64 |
//! | 383 | `attack_until_ms` | i64 |
//! | 391 | `food_tick_ms` | i64 (last hunger / regen step) |
//! | 399 | `_reserved` | [u8; 33] |
//!
//! # `Chunk` (ephemeral), PDA `["chunk", world, cx i32 LE, cz i32 LE]`
//! Created at [`CHUNK_INITIAL_LEN`] (10 240) bytes, then resized to [`CHUNK_FULL_LEN`]
//! (17 152) by `grow_chunk`. Blocks start at [`CHUNK_BLOCKS_OFFSET`] (768), index
//! `y * 256 + z * 16 + x`.
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
//! | 83 | `crank_armed` | u8 (0/1) |
//! | 84 | `task_id` | i64 (tick crank id, 0 = never armed) |
//! | 92 | `last_tick_ms` | i64 |
//! | 100 | `tick_count` | u64 |
//! | 108 | `biomes` | [u8; 256] (`core::terrain::Biome`, index `lz * 16 + lx`) |
//! | 364 | `mobs` | [u8; 256] (8 × `core::mobs::Mob`, 32 B each) |
//! | 620 | `fluid` | [u8; 134] (`core::fluid::FluidQueue` repr(C) layout) |
//! | 754 | `_reserved` | [u8; 14] |
//! | 768 | blocks | [u8; 16 384] |
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

/// Default slot duration used until the first re-anchor refines it, ms.
pub const DEFAULT_MS_PER_SLOT: u32 = 50;
/// Re-anchor when the slot-based estimate drifts this far from `unix_timestamp`, ms.
pub const REANCHOR_DRIFT_MS: i64 = 2_000;
/// A re-anchor also re-estimates `ms_per_slot` when the old anchor is at least this old
/// (keeps the 1 s `unix_timestamp` resolution error ≤ 5 %).
pub const RATE_MIN_SPAN_MS: i64 = 20_000;

/// Chain time estimate with ms resolution (`Clock::unix_timestamp` has 1 s).
/// See `magicraft_core::physics` "Time model": `chain_ms = anchor_ms + (slot − anchor_slot) ·
/// ms_per_slot`, re-anchored to (`slot`, `unix_timestamp · 1000`) when the estimate drifts
/// more than [`REANCHOR_DRIFT_MS`]. All-zero = not yet anchored.
#[derive(
    AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, Default, PartialEq, Eq,
)]
pub struct TimeAnchor {
    pub anchor_slot: u64,
    pub anchor_ms: i64,
    pub ms_per_slot: u32,
}

impl TimeAnchor {
    /// Slot-based estimate without re-anchoring.
    pub fn estimate(&self, slot: u64) -> i64 {
        let dslot = slot.saturating_sub(self.anchor_slot).min(i64::MAX as u64) as i64;
        self.anchor_ms
            .saturating_add(dslot.saturating_mul(self.ms_per_slot as i64))
    }

    /// Pure: current chain ms and the anchor to store if it changed (`None` = unchanged, so
    /// callers only need to write the account on a re-anchor).
    pub fn chain_ms(&self, slot: u64, unix_timestamp: i64) -> (i64, Option<TimeAnchor>) {
        let wall = unix_timestamp.saturating_mul(1000);
        if self.ms_per_slot == 0 {
            // Never anchored.
            let a = TimeAnchor {
                anchor_slot: slot,
                anchor_ms: wall,
                ms_per_slot: DEFAULT_MS_PER_SLOT,
            };
            return (wall, Some(a));
        }
        let est = self.estimate(slot);
        if est.saturating_sub(wall).saturating_abs() <= REANCHOR_DRIFT_MS {
            return (est, None);
        }
        let mut ms_per_slot = self.ms_per_slot;
        let dslot = slot.saturating_sub(self.anchor_slot);
        let dms = wall.saturating_sub(self.anchor_ms);
        if dslot > 0 && dms >= RATE_MIN_SPAN_MS {
            ms_per_slot = (dms as u64 / dslot).clamp(1, 1_000) as u32;
        }
        let a = TimeAnchor {
            anchor_slot: slot,
            anchor_ms: wall,
            ms_per_slot,
        };
        (wall, Some(a))
    }
}

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
    /// Block coordinates of the spawn feet block.
    pub spawn: [i32; 3],
    pub spawn_set: bool,
    pub time_of_day_ms: u64,
    pub day_task_id: i64,
    pub last_tick_ms: i64,
    pub chunk_count: u32,
    pub clock: TimeAnchor,
    pub _reserved: [u8; 42],
}

// `create_world` creates the World in one CPI (≤ 10 240 bytes).
const _: () = assert!(8 + World::INIT_SPACE <= 10_240);

impl World {
    /// Current chain ms; re-anchors `self.clock` in place when needed (the caller must
    /// hold the World mutably for the write to persist).
    pub fn chain_ms(&mut self, clock: &Clock) -> i64 {
        let (ms, anchor) = self.clock.chain_ms(clock.slot, clock.unix_timestamp);
        if let Some(a) = anchor {
            self.clock = a;
        }
        ms
    }

    /// Read-only chain ms (no re-anchor written).
    pub fn chain_ms_ro(&self, clock: &Clock) -> i64 {
        self.clock.chain_ms(clock.slot, clock.unix_timestamp).0
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
    pub dead: bool,
    /// Current chunk.
    pub cx: i32,
    pub cz: i32,
    pub break_until_ms: i64,
    pub attack_until_ms: i64,
    /// Last hunger / regeneration step, chain ms.
    pub food_tick_ms: i64,
    pub _reserved: [u8; 33],
}

const _: () = assert!(MoveState::SIZE == 72 && Inventory::SIZE == 216);

impl PlayerState {
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
pub const CHUNK_FULL_LEN: usize = CHUNK_BLOCKS_OFFSET + CHUNK_VOL;

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
    pub _reserved: [u8; 14],
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
    assert!(core::mem::offset_of!(ChunkHeader, _reserved) == 754);
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
        (0..MOB_SLOTS).any(|i| !self.mob(i).is_empty())
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
    require!(data.len() >= CHUNK_FULL_LEN, MagicraftError::ChunkNotReady);
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
pub fn chunk_blocks_mut<'a>(ai: &'a AccountInfo) -> Result<RefMut<'a, [u8; CHUNK_VOL]>> {
    Ok(chunk_parts_mut(ai)?.1)
}

/// Header + blocks of a grown chunk (generation stage not checked: for `grow_chunk` /
/// `populate_chunk`; gameplay uses [`ready_chunk_mut`]).
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
                ms_per_slot: 12,
            },
            _reserved: [0; 42],
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
            dead: false,
            cx: -2,
            cz: 5,
            break_until_ms: 100,
            attack_until_ms: 200,
            food_tick_ms: 300,
            _reserved: [0; 33],
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
        assert_eq!((b[365], b[366]), (4, 0));
        assert_eq!(&b[367..371], &(-2i32).to_le_bytes());
        assert_eq!(&b[371..375], &5i32.to_le_bytes());
        assert_eq!(&b[375..383], &100i64.to_le_bytes());
        assert_eq!(&b[383..391], &200i64.to_le_bytes());
        assert_eq!(&b[391..399], &300i64.to_le_bytes());
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
        data.resize(CHUNK_FULL_LEN, 0);
        let (h, blocks) = chunk_parts_from_mut(&mut data).unwrap();
        assert_eq!(h.cx.get(), 0);
        blocks[CHUNK_VOL - 1] = 42;
        assert_eq!(data[CHUNK_FULL_LEN - 1], 42);
        assert_eq!(CHUNK_FULL_LEN, 17_152);
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
    fn time_anchor_first_call_anchors() {
        let t = TimeAnchor::default();
        let (ms, a) = t.chain_ms(100, 1_700_000_000);
        assert_eq!(ms, 1_700_000_000_000);
        let a = a.unwrap();
        assert_eq!((a.anchor_slot, a.ms_per_slot), (100, DEFAULT_MS_PER_SLOT));
    }

    #[test]
    fn time_anchor_estimates_between_seconds() {
        let t = TimeAnchor {
            anchor_slot: 100,
            anchor_ms: 1_000_000,
            ms_per_slot: 50,
        };
        // 7 slots later, unix still in the same second: ms resolution from slots.
        let (ms, a) = t.chain_ms(107, 1_000);
        assert_eq!((ms, a), (1_000_350, None));
        // Within the 2 s tolerance: no write.
        assert_eq!(t.chain_ms(140, 1_002).1, None);
    }

    #[test]
    fn time_anchor_reanchors_on_drift_and_refines_rate() {
        // Real slots are 40 ms but we assume 50: after 1000 slots (40 s) the estimate is
        // 10 s ahead → re-anchor to wall time and learn 40 ms/slot.
        let t = TimeAnchor {
            anchor_slot: 0,
            anchor_ms: 1_000_000,
            ms_per_slot: 50,
        };
        let (ms, a) = t.chain_ms(1_000, 1_040);
        assert_eq!(ms, 1_040_000);
        let a = a.unwrap();
        assert_eq!(
            a,
            TimeAnchor {
                anchor_slot: 1_000,
                anchor_ms: 1_040_000,
                ms_per_slot: 40
            }
        );
        // Short span: re-anchor without touching the rate.
        let t = TimeAnchor {
            anchor_slot: 0,
            anchor_ms: 1_000_000,
            ms_per_slot: 1_000,
        };
        let (_, a) = t.chain_ms(10, 1_005);
        assert_eq!(a.unwrap().ms_per_slot, 1_000);
    }

    #[test]
    fn time_anchor_is_total() {
        let t = TimeAnchor {
            anchor_slot: u64::MAX,
            anchor_ms: i64::MAX,
            ms_per_slot: u32::MAX,
        };
        let _ = t.chain_ms(0, i64::MIN);
        let _ = t.chain_ms(u64::MAX, i64::MAX);
        let t = TimeAnchor {
            anchor_slot: 0,
            anchor_ms: i64::MIN,
            ms_per_slot: u32::MAX,
        };
        let _ = t.chain_ms(u64::MAX, i64::MAX);
    }
}
