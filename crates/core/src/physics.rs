//! Movement validation: client-authoritative physics with onchain plausibility checks.
//!
//! Runs onchain inside `move_player` (~8 Hz per player), so [`check_move`] is total: no
//! panics for any input (every coordinate/time/param is range-checked first, all math is
//! `i64` on bounded values), no floats, no heap. The browser client runs its own 60 fps
//! physics with the same [`WorldParams`]; this module only checks that each reported
//! position is *plausible* and must accept anything a correct client produces.
//!
//! # Units
//! Positions are FP (`FP` = 256 units per block), `pos` = feet center. Speeds are FP/s,
//! gravity FP/s², times are milliseconds (the caller must pass **millisecond** onchain
//! time, e.g. derived from the slot; `Clock::unix_timestamp` is whole seconds).
//!
//! # Rules (in check order) and tolerances
//! 0. Params must [`WorldParams::validate`]; `prev`/new coordinates must be within
//!    [`XZ_LIMIT`] / [`Y_MIN`]..=[`Y_MAX`]; reported velocity components within 2× the
//!    largest relevant param speed. Otherwise [`MoveError::InvalidState`].
//! 1. `dt = now − prev.last_ms`, `now < last` counts as `dt = 0` (and `last_ms` never moves
//!    backwards); `dt` is capped at [`MAX_DT_MS`] = 2 s, so a long gap grants at most 2 s
//!    of travel.
//! 2. Horizontal: `|Δxz| ≤ speed·dt·5/4 + 0.25 block` (squared, `i64`, no sqrt) where
//!    `speed` = `swim_speed` if both the previous and the new position are in water, else
//!    `sprint_speed`. → [`MoveError::MoveTooFast`].
//! 3. Down: `−Δy ≤ max_fall_speed·dt·5/4 + 0.25 block` → `MoveTooFast`.
//!    Up: `Δy ≤ (H + 0.25 block) · (1 + dt / (2·t_apex))` (one jump of height
//!    `H = v²/2g` per jump cycle that fits in `dt`), plus `swim_speed·dt·5/4` if either end
//!    is in water. → [`MoveError::Flying`].
//! 4. The collision box at the destination must not overlap a solid block
//!    → [`MoveError::Collision`]. Box: half-width [`HALF_W`] (0.289; client 0.3), from
//!    `y + FEET_EPS` to `y + BODY_H` (1.78; client 1.8). Slightly smaller than the
//!    client's box = rounding slack in the client's favour.
//! 5. `on_ground` claim: some column under the [`GROUND_HALF_W`] footprint must have a
//!    solid block whose top is within [`GROUND_EPS`] (0.05 block) below the feet (or
//!    [`FEET_EPS`] above) **and** a non-solid block on top of it (a real surface, so
//!    pressing against a wall is not ground) → [`MoveError::NotOnGround`].
//! 6. Airborne ceiling (no flying): if the new position is neither on ground nor in water,
//!    `y ≤ support_y + rise(t) + 0.25 block`, where `support_y`/`support_ms` are the y and
//!    time of the last update that was on ground or in water, `t = now − support_ms −`
//!    [`AIR_SLACK_MS`], and `rise(t)` is the highest point of a jump at time `t`: `H` up to
//!    the apex, then `H` minus the ballistic fall (gravity, capped at `max_fall_speed`).
//!    → `Flying`.
//! 7. Swept path (cheap anti-wall-phase): an L-shaped path is checked — vertical at the
//!    old xz up to `top = max(y_old, y_new)`, horizontal at `top`, vertical down at the new
//!    xz. Vertical legs are one tall box (exact); the horizontal leg samples the box every
//!    ≤ [`SAMPLE_STEP`] (0.5 block, per axis) — at most [`MAX_SAMPLES`] samples. If the
//!    box at the *old* position is already obstructed (a block was placed into the
//!    player), the sweep is skipped so the player can step out. → `Collision`.
//! 8. Outcome: `in_water` = the feet or head voxel (at the xz center) is water. Fall
//!    damage on a grounded update: `max(0, fall_start_y − y − 3 blocks)` in whole blocks
//!    (floor), 0 if in water or `params.fall_damage == 0`, capped at 255. `fall_start_y` =
//!    highest y since the last on-ground / in-water update.
//!
//! # What is caught / not caught
//! Caught: speed hacks (> 1.25× sprint + 0.25 block per update), teleports, walking into
//! or through full-block walls/floors/ceilings, claiming ground in mid-air (incl. wall
//! hugging), flying/hovering (after `t_apex + 0.5 s` the ceiling falls ballistically),
//! climbing faster than repeated jumps allow, fall-damage avoidance by never landing (the
//! ceiling eventually forces the player down to the ground, and the first grounded update
//! pays the damage from the remembered `fall_start_y`).
//! Not caught: ~25 % speed boost (+0.25 block per update, ≈ +2 b/s at 8 Hz); up to
//! `t_apex + 0.5 s` (≈ 0.78 s) of hover per jump; slightly higher jumps (+0.25 block);
//! clipping a corner diagonally between horizontal samples; sweeping through a block
//! when params make the horizontal leg longer than `MAX_SAMPLES × 0.5` blocks (never with
//! default params); passing a block placed *into* the player; no air-control limits
//! (a player may change direction mid-air); reported velocity is only loosely bounded.
//!
//! # Client parity requirements
//! - Horizontal speed ≤ `sprint_speed` (≤ `swim_speed` while in water by the rule above:
//!   feet voxel at `y + FEET_EPS` or head voxel at `y + BODY_H − 1` is water); no water
//!   currents/knockback that would exceed it.
//! - Jump: `vy = jump_velocity` only from ground; gravity `gravity`, fall capped at
//!   `max_fall_speed`; clamp frame dt (≤ 50 ms). No auto step-up without a jump.
//! - Box 0.6 × 1.8 × 0.6; snap y exactly to the block top on landing; send FP positions
//!   rounded to nearest.
//! - Send updates at ≥ 8 Hz **plus one in every frame `on_ground` changes** (landing and
//!   lift-off). The airborne ceiling is measured from the last *reported* support, so a
//!   bunny-hopping client (grounded for one frame per hop) that only sends at 8 Hz gets
//!   `Flying` within a few hops (test `simulated_bunny_hop_accepted`). Long gaps
//!   (> ~0.5 s) can be rejected (hop over an obstacle inside one update, multi-jump
//!   climbs); on any rejection the client snaps back to the last accepted state.
//! - `on_ground` true only when resting on a block top.
//!
//! # Block access
//! Any [`BlockAccess`] works. `fluid::ChunkNeighborhood` lacks the diagonal chunks
//! (reads Stone → false `Collision` near chunk corners), so the program should use
//! [`ChunkQuad`] with the 2×2 window from [`move_window`]; moves spanning more chunks
//! read Stone outside and are rejected (fail closed; impossible with default params).
//!
//! # Cost (hand count of SBF ops ≈ CU; not measured on SBF yet)
//! A block read through [`ChunkQuad`] ≈ 25 CU (range checks, div/rem by 16, index, load,
//! flags lookup). Validation + arithmetic ≈ 400 CU. A box check is ≤ 12 reads
//! (2 × 3 × 2 voxels).
//! - Typical 8 Hz sprint step: 14 reads mid-block, ≤ ~60 near block edges
//!   (test `worst_case_reads_bounded`) → **≈ 0.8–2 k CU**.
//! - Worst case with default params (2 s gap, 14-block diagonal + 40-block fall): 270
//!   reads → **≈ 7.5 k CU**.
//! - Absolute bound (any valid params): vertical leg ≤ 84 rows × 4 = 336 reads, horizontal
//!   leg ≤ [`MAX_SAMPLES`] × 12 = 768, plus destination/origin/ground/water ≈ 40 →
//!   ≈ 1.15 k reads → **≈ 29 k CU**.
//!
//! `bench_check_move` (native release, ignored): typical step ≈ 40 ns, default-params
//! worst case ≈ 570 ns.
//!
//! # SBF stack
//! No arrays besides `[i32; 3]`s; `check_move` frame holds two `MoveState`s (56 B each)
//! and scalars, well under 512 B.

use crate::blocks::{is_fluid_u8, is_solid_u8, Block};
use crate::consts::{CHUNK_H, CHUNK_VOL, CHUNK_W, FP};
use crate::coords::block_index;
use crate::fluid::BlockAccess;

/// FP units per block as `i64`.
const FPL: i64 = FP as i64;

/// Collision box half-width (x and z), FP. 74 ≈ 0.289 block (client: 0.3 = 76.8 FP).
pub const HALF_W: i32 = 74;
/// Collision box bottom offset above the feet, FP (≈ 0.016 block of rounding slack).
pub const FEET_EPS: i32 = 4;
/// Collision box top offset above the feet, FP. 456 ≈ 1.78 block (client: 1.8 = 460.8 FP).
pub const BODY_H: i32 = 456;
/// Ground-probe footprint half-width, FP. 78 ≈ 0.305 block (≥ the client's 0.3).
pub const GROUND_HALF_W: i32 = 78;
/// How far below the feet a supporting block top may be, FP (0.05 block).
pub const GROUND_EPS: i32 = 13;
/// Speed allowances are capped at this much elapsed time.
pub const MAX_DT_MS: i64 = 2000;
/// Speed tolerance factor `SPEED_NUM / SPEED_DEN` (1.25).
pub const SPEED_NUM: i64 = 5;
/// See [`SPEED_NUM`].
pub const SPEED_DEN: i64 = 4;
/// Additive distance tolerance per update (horizontal and vertical), FP: 0.25 block.
pub const DIST_TOL: i64 = 64;
/// Grace between the last supported update and the actual lift-off (jitter, one 8 Hz
/// interval, tx latency), ms.
pub const AIR_SLACK_MS: i64 = 500;
/// Airborne time beyond this is treated as this (the ceiling is long gone by then), ms.
pub const MAX_AIR_MS: i64 = 60_000;
/// Horizontal sweep sample spacing per axis, FP (0.5 block).
pub const SAMPLE_STEP: i64 = 128;
/// Maximum horizontal sweep samples per update.
pub const MAX_SAMPLES: i64 = 64;
/// `|x|, |z|` limit for positions, FP (2^27 FP = 524 288 blocks).
pub const XZ_LIMIT: i32 = 1 << 27;
/// Lowest valid y, FP (4 blocks below the world).
pub const Y_MIN: i32 = -4 * FP;
/// Highest valid y, FP (16 blocks above the world).
pub const Y_MAX: i32 = (CHUNK_H as i32 + 16) * FP;

/// Immutable per-world rules, stored in the `World` account and read by the client.
///
/// Byte layout (`repr(C)`, little-endian, no implicit padding, [`Self::SIZE`] = 48):
///
/// | off | field | type | unit | valid range |
/// |---|---|---|---|---|
/// | 0 | `walk_speed` | u32 | FP/s | 256..=12 800 (1–50 b/s) |
/// | 4 | `sprint_speed` | u32 | FP/s | `walk_speed`..=12 800 |
/// | 8 | `swim_speed` | u32 | FP/s | 256..=12 800 |
/// | 12 | `jump_velocity` | u32 | FP/s | 256..=12 800, and jump height `v²/2g` ≤ 8 blocks |
/// | 16 | `gravity` | u32 | FP/s² | 256..=25 600 (1–100 b/s²) |
/// | 20 | `max_fall_speed` | u32 | FP/s | 256..=51 200 (1–200 b/s) |
/// | 24 | `reach` | u32 | FP | 256..=4 096 (1–16 blocks) |
/// | 28 | `attack_cooldown_ms` | u32 | ms | 0..=10 000 |
/// | 32 | `day_length_secs` | u32 | s | 60..=86 400 |
/// | 36 | `mob_tick_ms` | u32 | ms | 100..=60 000 |
/// | 40 | `fluid_tick_ms` | u32 | ms | 100..=60 000 |
/// | 44 | `fall_damage` | u8 | bool | 0..=1 |
/// | 45 | `hunger` | u8 | bool | 0..=1 |
/// | 46 | `zombie_cap_per_chunk` | u8 | count | 0..=8 (chunk mob slots) |
/// | 47 | `_pad` | u8 | — | 0 |
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
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
    pub _pad: u8,
}

const _: () = assert!(core::mem::size_of::<WorldParams>() == WorldParams::SIZE);

impl Default for WorldParams {
    /// Minecraft-ish: walk 4.3 b/s, sprint 5.6, swim 2.0, jump 1.25 blocks
    /// (`v = √(2·32·1.25)` ≈ 8.94 b/s), gravity 32 b/s², max fall 78 b/s, reach 5 blocks.
    fn default() -> Self {
        WorldParams {
            walk_speed: 1101,
            sprint_speed: 1434,
            swim_speed: 512,
            jump_velocity: 2290,
            gravity: 8192,
            max_fall_speed: 19968,
            reach: 1280,
            attack_cooldown_ms: 600,
            day_length_secs: 1200,
            mob_tick_ms: 333,
            fluid_tick_ms: 250,
            fall_damage: 1,
            hunger: 1,
            zombie_cap_per_chunk: 4,
            _pad: 0,
        }
    }
}

/// Which [`WorldParams`] field is out of range.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ParamError {
    WalkSpeed = 0,
    SprintSpeed = 1,
    SwimSpeed = 2,
    JumpVelocity = 3,
    Gravity = 4,
    JumpHeight = 5,
    MaxFallSpeed = 6,
    Reach = 7,
    AttackCooldown = 8,
    DayLength = 9,
    FallDamageFlag = 10,
    HungerFlag = 11,
    ZombieCap = 12,
    MobTick = 13,
    FluidTick = 14,
    Padding = 15,
}

const SPEED_MIN: u32 = FP as u32;
const SPEED_MAX: u32 = 50 * FP as u32;

fn in_range(v: u32, lo: u32, hi: u32, e: ParamError) -> Result<(), ParamError> {
    if (lo..=hi).contains(&v) {
        Ok(())
    } else {
        Err(e)
    }
}

impl WorldParams {
    /// Serialized size in bytes.
    pub const SIZE: usize = 48;

    /// Checks every field against the ranges in the type docs.
    pub fn validate(&self) -> Result<(), ParamError> {
        use ParamError::*;
        in_range(self.walk_speed, SPEED_MIN, SPEED_MAX, WalkSpeed)?;
        in_range(self.sprint_speed, self.walk_speed, SPEED_MAX, SprintSpeed)?;
        in_range(self.swim_speed, SPEED_MIN, SPEED_MAX, SwimSpeed)?;
        in_range(self.jump_velocity, SPEED_MIN, SPEED_MAX, JumpVelocity)?;
        in_range(self.gravity, FP as u32, 100 * FP as u32, Gravity)?;
        if self.jump_height() > 8 * FPL {
            return Err(JumpHeight);
        }
        in_range(
            self.max_fall_speed,
            SPEED_MIN,
            200 * FP as u32,
            MaxFallSpeed,
        )?;
        in_range(self.reach, FP as u32, 16 * FP as u32, Reach)?;
        in_range(self.attack_cooldown_ms, 0, 10_000, AttackCooldown)?;
        in_range(self.day_length_secs, 60, 86_400, DayLength)?;
        in_range(self.fall_damage as u32, 0, 1, FallDamageFlag)?;
        in_range(self.hunger as u32, 0, 1, HungerFlag)?;
        in_range(self.zombie_cap_per_chunk as u32, 0, 8, ZombieCap)?;
        in_range(self.mob_tick_ms, 100, 60_000, MobTick)?;
        in_range(self.fluid_tick_ms, 100, 60_000, FluidTick)?;
        in_range(self._pad as u32, 0, 0, Padding)
    }

    /// Jump apex height `v² / 2g`, FP (0 if gravity is 0).
    pub fn jump_height(&self) -> i64 {
        let v = self.jump_velocity as i64;
        (v * v).checked_div(2 * self.gravity as i64).unwrap_or(0)
    }

    /// Time to the jump apex `v / g`, ms. Callers ensure `gravity > 0`.
    fn apex_ms(&self) -> i64 {
        (self.jump_velocity as i64 * 1000)
            .checked_div(self.gravity as i64)
            .unwrap_or(0)
    }

    /// Little-endian bytes in the documented layout.
    pub fn to_bytes(&self) -> [u8; Self::SIZE] {
        let mut b = [0u8; Self::SIZE];
        let words = [
            self.walk_speed,
            self.sprint_speed,
            self.swim_speed,
            self.jump_velocity,
            self.gravity,
            self.max_fall_speed,
            self.reach,
            self.attack_cooldown_ms,
            self.day_length_secs,
            self.mob_tick_ms,
            self.fluid_tick_ms,
        ];
        for (chunk, w) in b.chunks_exact_mut(4).zip(words) {
            chunk.copy_from_slice(&w.to_le_bytes());
        }
        b[44] = self.fall_damage;
        b[45] = self.hunger;
        b[46] = self.zombie_cap_per_chunk;
        b[47] = self._pad;
        b
    }

    /// Parses the documented layout. Does not validate (call [`Self::validate`]).
    pub fn from_bytes(b: &[u8; Self::SIZE]) -> Self {
        let w = |i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
        WorldParams {
            walk_speed: w(0),
            sprint_speed: w(4),
            swim_speed: w(8),
            jump_velocity: w(12),
            gravity: w(16),
            max_fall_speed: w(20),
            reach: w(24),
            attack_cooldown_ms: w(28),
            day_length_secs: w(32),
            mob_tick_ms: w(36),
            fluid_tick_ms: w(40),
            fall_damage: b[44],
            hunger: b[45],
            zombie_cap_per_chunk: b[46],
            _pad: b[47],
        }
    }
}

/// Per-player movement state (part of `PlayerState`).
///
/// Byte layout ([`Self::SIZE`] = 56, little-endian):
///
/// | off | field | type |
/// |---|---|---|
/// | 0 | `last_ms` | i64 |
/// | 8 | `support_ms` | i64 |
/// | 16 | `pos` | [i32; 3] (FP, feet center) |
/// | 28 | `vel` | [i32; 3] (FP/s, as reported) |
/// | 40 | `fall_start_y` | i32 (FP) |
/// | 44 | `support_y` | i32 (FP) |
/// | 48 | `on_ground` | u8 (0/1) |
/// | 49 | `in_water` | u8 (0/1) |
/// | 50 | reserved | [u8; 6] (written 0, ignored) |
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct MoveState {
    /// Feet center, FP.
    pub pos: [i32; 3],
    /// Client-reported velocity, FP/s (stored for other clients' interpolation).
    pub vel: [i32; 3],
    /// Last accepted `on_ground` claim.
    pub on_ground: bool,
    /// Highest y since the last on-ground / in-water update, FP.
    pub fall_start_y: i32,
    /// Time of the last accepted update, ms (never decreases).
    pub last_ms: i64,
    /// Feet or head voxel is water.
    pub in_water: bool,
    /// y of the last update that was on ground or in water, FP.
    pub support_y: i32,
    /// Time of the last update that was on ground or in water, ms.
    pub support_ms: i64,
}

impl MoveState {
    /// Serialized size in bytes.
    pub const SIZE: usize = 56;

    /// Fresh state at `pos` (spawn / respawn / teleport): airborne, supported now.
    pub fn spawn(pos: [i32; 3], now_ms: i64) -> Self {
        MoveState {
            pos,
            vel: [0; 3],
            on_ground: false,
            fall_start_y: pos[1],
            last_ms: now_ms,
            in_water: false,
            support_y: pos[1],
            support_ms: now_ms,
        }
    }

    /// Little-endian bytes in the documented layout.
    pub fn to_bytes(&self) -> [u8; Self::SIZE] {
        let mut b = [0u8; Self::SIZE];
        b[0..8].copy_from_slice(&self.last_ms.to_le_bytes());
        b[8..16].copy_from_slice(&self.support_ms.to_le_bytes());
        let words = [
            self.pos[0],
            self.pos[1],
            self.pos[2],
            self.vel[0],
            self.vel[1],
            self.vel[2],
            self.fall_start_y,
            self.support_y,
        ];
        for (chunk, w) in b[16..48].chunks_exact_mut(4).zip(words) {
            chunk.copy_from_slice(&w.to_le_bytes());
        }
        b[48] = self.on_ground as u8;
        b[49] = self.in_water as u8;
        b
    }

    /// Parses the documented layout; bool bytes other than 0/1 → `InvalidState`.
    pub fn from_bytes(b: &[u8; Self::SIZE]) -> Result<Self, MoveError> {
        let w = |i: usize| i32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
        let l = |i: usize| {
            let mut a = [0u8; 8];
            a.copy_from_slice(&b[i..i + 8]);
            i64::from_le_bytes(a)
        };
        let flag = |v: u8| match v {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(MoveError::InvalidState),
        };
        Ok(MoveState {
            last_ms: l(0),
            support_ms: l(8),
            pos: [w(16), w(20), w(24)],
            vel: [w(28), w(32), w(36)],
            fall_start_y: w(40),
            support_y: w(44),
            on_ground: flag(b[48])?,
            in_water: flag(b[49])?,
        })
    }
}

/// Why a move was rejected. Discriminants are stable (the program maps them to its errors).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum MoveError {
    /// Horizontal or downward distance exceeds the allowance.
    MoveTooFast = 0,
    /// Destination or swept path overlaps a solid block.
    Collision = 1,
    /// `on_ground` claimed without a block top under the feet.
    NotOnGround = 2,
    /// Rose more than jumping/swimming allows, or stayed up past the jump arc.
    Flying = 3,
    /// Params, coordinates, velocity or stored state out of range.
    InvalidState = 4,
}

/// Accepted move: damage to apply and the state to store.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MoveOutcome {
    /// Fall damage in hit points (= whole blocks fallen beyond 3).
    pub fall_damage: u8,
    pub state: MoveState,
}

fn pos_ok(p: [i32; 3]) -> bool {
    (-XZ_LIMIT..=XZ_LIMIT).contains(&p[0])
        && (-XZ_LIMIT..=XZ_LIMIT).contains(&p[2])
        && (Y_MIN..=Y_MAX).contains(&p[1])
}

/// FP (inclusive) → block coordinate. Inputs are bounded, so the cast is lossless.
#[inline]
fn blk(v: i64) -> i32 {
    v.div_euclid(FPL) as i32
}

/// No solid block overlaps the box `[x ± HALF_W) × [y_lo + FEET_EPS, y_hi + BODY_H) ×
/// [z ± HALF_W)` (half-open, FP). `y_lo ≤ y_hi`; a tall box sweeps a vertical move.
fn box_clear(w: &impl BlockAccess, x: i64, y_lo: i64, y_hi: i64, z: i64) -> bool {
    let h = HALF_W as i64;
    let (x0, x1) = (blk(x - h), blk(x + h - 1));
    let (z0, z1) = (blk(z - h), blk(z + h - 1));
    let (y0, y1) = (blk(y_lo + FEET_EPS as i64), blk(y_hi + BODY_H as i64 - 1));
    for by in y0..=y1 {
        for bz in z0..=z1 {
            for bx in x0..=x1 {
                if is_solid_u8(w.get(bx, by, bz)) {
                    return false;
                }
            }
        }
    }
    true
}

/// A solid block top with a non-solid block above it lies within
/// `[y − GROUND_EPS, y + FEET_EPS]` under the [`GROUND_HALF_W`] footprint.
fn grounded(w: &impl BlockAccess, x: i64, y: i64, z: i64) -> bool {
    // Only one block row can have its top in a 17-FP window.
    let row = blk(y + FEET_EPS as i64) - 1;
    let top = (row as i64 + 1) * FPL;
    if top < y - GROUND_EPS as i64 {
        return false;
    }
    let h = GROUND_HALF_W as i64;
    for bz in blk(z - h)..=blk(z + h - 1) {
        for bx in blk(x - h)..=blk(x + h - 1) {
            if is_solid_u8(w.get(bx, row, bz)) && !is_solid_u8(w.get(bx, row + 1, bz)) {
                return true;
            }
        }
    }
    false
}

/// Feet or head voxel (at the xz center) is water.
fn in_water(w: &impl BlockAccess, x: i64, y: i64, z: i64) -> bool {
    let (bx, bz) = (blk(x), blk(z));
    is_fluid_u8(w.get(bx, blk(y + FEET_EPS as i64), bz))
        || is_fluid_u8(w.get(bx, blk(y + BODY_H as i64 - 1), bz))
}

/// `v · dt · 5/4` in FP for a speed in FP/s and `dt` in ms.
#[inline]
fn travel(speed: u32, dt: i64) -> i64 {
    speed as i64 * dt * SPEED_NUM / (SPEED_DEN * 1000)
}

/// Highest height above the support a jump can be at `t` ms after lift-off, FP.
fn rise(p: &WorldParams, t: i64) -> i64 {
    let apex = p.apex_ms();
    let h = p.jump_height();
    if t <= apex {
        return h;
    }
    let s = t - apex;
    let g = p.gravity as i64;
    let vmax = p.max_fall_speed as i64;
    let t_term = vmax * 1000 / g;
    let fall = if s <= t_term {
        g * s * s / 2_000_000
    } else {
        g * t_term * t_term / 2_000_000 + vmax * (s - t_term) / 1000
    };
    h - fall
}

/// Validates one movement update; see the module docs for the rules.
pub fn check_move(
    params: &WorldParams,
    prev: &MoveState,
    new_pos: [i32; 3],
    new_vel: [i32; 3],
    on_ground: bool,
    now_ms: i64,
    blocks: &impl BlockAccess,
) -> Result<MoveOutcome, MoveError> {
    use MoveError::*;
    // 0. Ranges (everything below relies on these bounds for overflow-freedom).
    if params.validate().is_err()
        || !pos_ok(prev.pos)
        || !pos_ok(new_pos)
        || !(Y_MIN..=Y_MAX).contains(&prev.fall_start_y)
        || !(Y_MIN..=Y_MAX).contains(&prev.support_y)
    {
        return Err(InvalidState);
    }
    let p = params;
    let vh = 2 * p.sprint_speed.max(p.swim_speed) as i64;
    let vup = 2 * p.jump_velocity.max(p.swim_speed) as i64;
    let vdown = 2 * p.max_fall_speed as i64;
    let [vx, vy, vz] = new_vel.map(i64::from);
    if vx.abs() > vh || vz.abs() > vh || vy > vup || vy < -vdown {
        return Err(InvalidState);
    }

    // 1. Time.
    let now = now_ms.max(prev.last_ms);
    let dt = now.saturating_sub(prev.last_ms).min(MAX_DT_MS);

    let [px, py, pz] = prev.pos.map(i64::from);
    let [nx, ny, nz] = new_pos.map(i64::from);
    let (dx, dy, dz) = (nx - px, ny - py, nz - pz);
    let water = in_water(blocks, nx, ny, nz);

    // 2. Horizontal speed.
    let hspeed = if prev.in_water && water {
        p.swim_speed
    } else {
        p.sprint_speed
    };
    let h_allow = travel(hspeed, dt) + DIST_TOL;
    if dx * dx + dz * dz > h_allow * h_allow {
        return Err(MoveTooFast);
    }

    // 3. Vertical speed.
    if dy < 0 && -dy > travel(p.max_fall_speed, dt) + DIST_TOL {
        return Err(MoveTooFast);
    }
    if dy > 0 {
        let cycle = (2 * p.apex_ms()).max(1);
        let mut up = (p.jump_height() + DIST_TOL) * (1 + dt / cycle);
        if prev.in_water || water {
            up += travel(p.swim_speed, dt);
        }
        if dy > up {
            return Err(Flying);
        }
    }

    // 4. Destination box.
    if !box_clear(blocks, nx, ny, ny, nz) {
        return Err(Collision);
    }

    // 5. Ground claim.
    if on_ground && !grounded(blocks, nx, ny, nz) {
        return Err(NotOnGround);
    }

    // 6. Airborne ceiling.
    if !on_ground && !water {
        let air = now.saturating_sub(prev.support_ms).clamp(0, MAX_AIR_MS);
        let t = (air - AIR_SLACK_MS).max(0);
        if ny > prev.support_y as i64 + rise(p, t) + DIST_TOL {
            return Err(Flying);
        }
    }

    // 7. Swept L-path, unless the player is already stuck in a block.
    if box_clear(blocks, px, py, py, pz) {
        let top = py.max(ny);
        if (top > py && !box_clear(blocks, px, py, top, pz))
            || (top > ny && !box_clear(blocks, nx, ny, top, nz))
        {
            return Err(Collision);
        }
        let steps = ((dx.abs() + SAMPLE_STEP - 1) / SAMPLE_STEP)
            .max((dz.abs() + SAMPLE_STEP - 1) / SAMPLE_STEP)
            .min(MAX_SAMPLES);
        for k in 1..steps {
            let sx = px + dx * k / steps;
            let sz = pz + dz * k / steps;
            if !box_clear(blocks, sx, top, top, sz) {
                return Err(Collision);
            }
        }
    }

    // 8. Outcome.
    let start = prev.fall_start_y.max(prev.pos[1]);
    let mut fall_damage = 0u8;
    if on_ground && !water && p.fall_damage != 0 {
        let d = (start as i64 - ny - 3 * FPL).div_euclid(FPL);
        fall_damage = d.clamp(0, u8::MAX as i64) as u8;
    }
    let supported = on_ground || water;
    let state = MoveState {
        pos: new_pos,
        vel: new_vel,
        on_ground,
        fall_start_y: if supported {
            new_pos[1]
        } else {
            start.max(new_pos[1])
        },
        last_ms: now,
        in_water: water,
        support_y: if supported {
            new_pos[1]
        } else {
            prev.support_y
        },
        support_ms: if supported { now } else { prev.support_ms },
    };
    Ok(MoveOutcome { fall_damage, state })
}

/// Read-only 2×2 chunk window `(cx0..=cx0+1, cz0..=cz0+1)` for [`check_move`].
/// Missing slots and anything outside read as Stone, `y < 0` as Bedrock, `y ≥ 64` as Air.
pub struct ChunkQuad<'a> {
    pub cx0: i32,
    pub cz0: i32,
    /// Slots `[(cx0, cz0), (cx0+1, cz0), (cx0, cz0+1), (cx0+1, cz0+1)]`.
    chunks: [Option<&'a [u8; CHUNK_VOL]>; 4],
}

impl<'a> ChunkQuad<'a> {
    /// `chunks` in order `(cx0, cz0)`, `(cx0+1, cz0)`, `(cx0, cz0+1)`, `(cx0+1, cz0+1)`.
    pub fn new(cx0: i32, cz0: i32, chunks: [Option<&'a [u8; CHUNK_VOL]>; 4]) -> Self {
        ChunkQuad { cx0, cz0, chunks }
    }
}

impl BlockAccess for ChunkQuad<'_> {
    fn get(&self, x: i32, y: i32, z: i32) -> u8 {
        if y < 0 {
            return Block::Bedrock as u8;
        }
        if y >= CHUNK_H as i32 {
            return Block::Air as u8;
        }
        let w = CHUNK_W as i64;
        let dx = (x as i64).div_euclid(w) - self.cx0 as i64;
        let dz = (z as i64).div_euclid(w) - self.cz0 as i64;
        if !(0..2).contains(&dx) || !(0..2).contains(&dz) {
            return Block::Stone as u8;
        }
        match self.chunks[(dz * 2 + dx) as usize] {
            Some(c) => {
                c[block_index(
                    x.rem_euclid(CHUNK_W as i32) as usize,
                    y as usize,
                    z.rem_euclid(CHUNK_W as i32) as usize,
                )]
            }
            None => Block::Stone as u8,
        }
    }

    fn set(&mut self, _: i32, _: i32, _: i32, _: u8) -> bool {
        false
    }
}

/// Origin `(cx0, cz0)` of the 2×2 chunk window covering every block [`check_move`] may
/// read for a move `a → b` (boxes, ground footprint), or `None` if it spans more chunks.
pub fn move_window(a: [i32; 3], b: [i32; 3]) -> Option<(i32, i32)> {
    let m = GROUND_HALF_W as i64;
    let cw = CHUNK_W as i64 * FPL;
    let span = |u: i32, v: i32| {
        let (lo, hi) = ((u.min(v) as i64) - m, (u.max(v) as i64) + m - 1);
        let (c0, c1) = (lo.div_euclid(cw), hi.div_euclid(cw));
        if c1 - c0 > 1 {
            None
        } else {
            i32::try_from(c0).ok()
        }
    };
    Some((span(a[0], b[0])?, span(a[2], b[2])?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::cell::Cell;

    const B: i32 = FP;
    const AIR: u8 = Block::Air as u8;
    const STONE: u8 = Block::Stone as u8;
    const WATER: u8 = Block::WaterSource as u8;

    /// Test world (block coords):
    /// - default: `y < 10` Stone, else Air (feet stand at y = 10);
    /// - pool: x -40..=-31, z 0..=9: Water at y 7..=9, Stone below;
    /// - tower: x -20..=-11, z 0..=9: Stone up to y 19 (top at 20);
    /// - wall: x = 20, z -50..=50, y 10..=12;
    /// - step: x 30..=32, z 0..=9, y = 10 (top at 11);
    /// - platform: x 40..=42, z 0..=9, y 10..=12 (top at 13).
    struct TestWorld {
        reads: Cell<u32>,
    }

    fn world() -> TestWorld {
        TestWorld {
            reads: Cell::new(0),
        }
    }

    fn block_at(x: i32, y: i32, z: i32) -> u8 {
        if y < 0 {
            return Block::Bedrock as u8;
        }
        if y >= CHUNK_H as i32 {
            return AIR;
        }
        let zin = (0..=9).contains(&z);
        if (-40..=-31).contains(&x) && zin {
            return if y < 7 {
                STONE
            } else if y <= 9 {
                WATER
            } else {
                AIR
            };
        }
        if (-20..=-11).contains(&x) && zin && y < 20 {
            return STONE;
        }
        if x == 20 && (-50..=50).contains(&z) && (10..=12).contains(&y) {
            return STONE;
        }
        if (30..=32).contains(&x) && zin && y == 10 {
            return STONE;
        }
        if (40..=42).contains(&x) && zin && (10..=12).contains(&y) {
            return STONE;
        }
        if y < 10 {
            STONE
        } else {
            AIR
        }
    }

    impl BlockAccess for TestWorld {
        fn get(&self, x: i32, y: i32, z: i32) -> u8 {
            self.reads.set(self.reads.get() + 1);
            block_at(x, y, z)
        }
        fn set(&mut self, _: i32, _: i32, _: i32, _: u8) -> bool {
            false
        }
    }

    /// Block coordinate + fraction in 1/256: `bf(5, 128)` = 5.5 blocks.
    fn bf(b: i32, f: i32) -> i32 {
        b * B + f
    }

    fn grounded(pos: [i32; 3], t: i64) -> MoveState {
        MoveState {
            on_ground: true,
            ..MoveState::spawn(pos, t)
        }
    }

    fn airborne(pos: [i32; 3], t: i64, support_y: i32, support_ms: i64) -> MoveState {
        MoveState {
            pos,
            vel: [0; 3],
            on_ground: false,
            fall_start_y: support_y.max(pos[1]),
            last_ms: t,
            in_water: false,
            support_y,
            support_ms,
        }
    }

    fn mv(
        prev: &MoveState,
        pos: [i32; 3],
        on_ground: bool,
        now: i64,
    ) -> Result<MoveOutcome, MoveError> {
        check_move(
            &WorldParams::default(),
            prev,
            pos,
            [0; 3],
            on_ground,
            now,
            &world(),
        )
    }

    const HOME: [i32; 3] = [5 * 256 + 128, 10 * 256, 5 * 256 + 128];

    #[test]
    fn layout_sizes() {
        assert_eq!(core::mem::size_of::<WorldParams>(), WorldParams::SIZE);
        assert_eq!(WorldParams::default().to_bytes().len(), 48);
        assert_eq!(MoveState::default().to_bytes().len(), MoveState::SIZE);
    }

    #[test]
    fn params_bytes_roundtrip() {
        let p = WorldParams::default();
        let b = p.to_bytes();
        assert_eq!(WorldParams::from_bytes(&b), p);
        assert_eq!(&b[0..4], &1101u32.to_le_bytes());
        assert_eq!(b[44], 1);
        assert_eq!(b[46], 4);
    }

    #[test]
    fn state_bytes_roundtrip() {
        let s = MoveState {
            pos: [-5, 7, i32::MIN],
            vel: [1, -2, 3],
            on_ground: true,
            fall_start_y: 99,
            last_ms: -12345678901,
            in_water: true,
            support_y: -4,
            support_ms: 77,
        };
        let b = s.to_bytes();
        assert_eq!(MoveState::from_bytes(&b), Ok(s));
        assert_eq!(&b[0..8], &(-12345678901i64).to_le_bytes());
        assert_eq!(b[48], 1);
        let mut bad = b;
        bad[48] = 2;
        assert_eq!(MoveState::from_bytes(&bad), Err(MoveError::InvalidState));
    }

    #[test]
    fn params_validate() {
        assert_eq!(WorldParams::default().validate(), Ok(()));
        let p = WorldParams {
            walk_speed: 0,
            ..Default::default()
        };
        assert_eq!(p.validate(), Err(ParamError::WalkSpeed));
        let p = WorldParams {
            walk_speed: 1000 * 256,
            ..Default::default()
        };
        assert_eq!(p.validate(), Err(ParamError::WalkSpeed));
        let p = WorldParams {
            sprint_speed: 1000 * 256,
            ..Default::default()
        };
        assert_eq!(p.validate(), Err(ParamError::SprintSpeed));
        let p = WorldParams {
            swim_speed: 0,
            ..Default::default()
        };
        assert_eq!(p.validate(), Err(ParamError::SwimSpeed));
        let p = WorldParams {
            gravity: 0,
            ..Default::default()
        };
        assert_eq!(p.validate(), Err(ParamError::Gravity));
        let p = WorldParams {
            fall_damage: 2,
            ..Default::default()
        };
        assert_eq!(p.validate(), Err(ParamError::FallDamageFlag));
        let p = WorldParams {
            jump_velocity: 50 * 256,
            gravity: 256,
            ..Default::default()
        };
        assert_eq!(p.validate(), Err(ParamError::JumpHeight));
        let p = WorldParams {
            _pad: 1,
            ..Default::default()
        };
        assert_eq!(p.validate(), Err(ParamError::Padding));
    }

    #[test]
    fn default_jump_height_is_1_25_blocks() {
        assert_eq!(WorldParams::default().jump_height(), 320);
    }

    #[test]
    fn standing_still_ok() {
        let prev = grounded(HOME, 1000);
        let out = mv(&prev, HOME, true, 1125).unwrap();
        assert_eq!(out.fall_damage, 0);
        assert_eq!(out.state.pos, HOME);
        assert!(out.state.on_ground && !out.state.in_water);
        assert_eq!(out.state.last_ms, 1125);
    }

    #[test]
    fn walking_and_sprinting_ok() {
        let p = WorldParams::default();
        for speed in [p.walk_speed, p.sprint_speed] {
            let mut st = grounded(HOME, 0);
            for i in 1..=16i64 {
                let x = HOME[0] + (speed as i64 * i * 125 / 1000) as i32;
                st = mv(&st, [x, HOME[1], HOME[2]], true, i * 125).unwrap().state;
            }
        }
    }

    #[test]
    fn triple_sprint_rejected() {
        let prev = grounded(HOME, 0);
        let d = 3 * 1434 * 125 / 1000;
        assert_eq!(
            mv(&prev, [HOME[0] + d, HOME[1], HOME[2]], true, 125),
            Err(MoveError::MoveTooFast)
        );
        // Diagonal at 3x sprint too.
        let d2 = d * 7 / 10;
        assert_eq!(
            mv(&prev, [HOME[0] + d2, HOME[1], HOME[2] + d2], true, 125),
            Err(MoveError::MoveTooFast)
        );
    }

    #[test]
    fn moving_into_stone_rejected() {
        let prev = grounded([bf(19, 154), bf(10, 0), bf(5, 0)], 0);
        assert_eq!(
            mv(&prev, [bf(19, 205), bf(10, 0), bf(5, 0)], true, 125),
            Err(MoveError::Collision)
        );
        // Sinking into the floor.
        let prev = grounded(HOME, 0);
        assert_eq!(
            mv(&prev, [HOME[0], HOME[1] - 40, HOME[2]], false, 125),
            Err(MoveError::Collision)
        );
    }

    #[test]
    fn phasing_through_wall_rejected() {
        let prev = grounded([bf(19, 154), bf(10, 0), bf(5, 0)], 0);
        // 1.8 blocks in 300 ms is within the speed allowance; the wall sits in between.
        assert_eq!(
            mv(&prev, [bf(21, 102), bf(10, 0), bf(5, 0)], true, 300),
            Err(MoveError::Collision)
        );
        // Same distance with no wall in between is fine.
        let prev = grounded([bf(9, 154), bf(10, 0), bf(5, 0)], 0);
        mv(&prev, [bf(11, 102), bf(10, 0), bf(5, 0)], true, 300).unwrap();
    }

    #[test]
    fn on_ground_over_air_rejected() {
        let prev = airborne([HOME[0], bf(11, 0), HOME[2]], 1000, HOME[1], 900);
        assert_eq!(
            mv(&prev, [HOME[0], bf(11, 0), HOME[2]], true, 1125),
            Err(MoveError::NotOnGround)
        );
        // Airborne claim at the same spot is fine (mid-jump).
        mv(&prev, [HOME[0], bf(11, 0), HOME[2]], false, 1125).unwrap();
    }

    #[test]
    fn hugging_a_wall_is_not_ground() {
        // Mid-air at an integer height, pressed against the wall at x = 20.
        let x = 20 * B - 77;
        let prev = airborne([x, bf(11, 0), bf(5, 0)], 1000, bf(10, 0), 900);
        assert_eq!(
            mv(&prev, [x, bf(11, 0), bf(5, 0)], true, 1125),
            Err(MoveError::NotOnGround)
        );
    }

    #[test]
    fn standing_on_an_edge_is_ground() {
        // Client box (0.3 half-width) overlaps the step's edge by < 1/256 block.
        let x = 30 * B - 76;
        let prev = grounded([x, bf(11, 0), bf(5, 0)], 0);
        mv(&prev, [x, bf(11, 0), bf(5, 0)], true, 125).unwrap();
    }

    #[test]
    fn jump_up_one_block_step_ok() {
        let prev = grounded([bf(29, 128), bf(10, 0), bf(5, 0)], 0);
        let out = mv(&prev, [bf(30, 51), bf(11, 0), bf(5, 0)], true, 125).unwrap();
        assert_eq!(out.fall_damage, 0);
        assert_eq!(out.state.support_y, bf(11, 0));
    }

    #[test]
    fn going_up_three_blocks_rejected() {
        let prev = grounded([bf(39, 128), bf(10, 0), bf(5, 0)], 0);
        assert_eq!(
            mv(&prev, [bf(40, 128), bf(13, 0), bf(5, 0)], true, 125),
            Err(MoveError::Flying)
        );
        // Straight up into the air, too.
        let prev = grounded(HOME, 0);
        assert_eq!(
            mv(&prev, [HOME[0], bf(13, 0), HOME[2]], false, 125),
            Err(MoveError::Flying)
        );
    }

    #[test]
    fn hovering_rejected() {
        // Left the ground 1 s ago at y = 10 and still claims y = 11.
        let prev = airborne([HOME[0], bf(11, 0), HOME[2]], 1000, HOME[1], 0);
        assert_eq!(
            mv(&prev, [HOME[0], bf(11, 0), HOME[2]], false, 1125),
            Err(MoveError::Flying)
        );
        // Hovering just above the floor without ever landing gets caught as well.
        let prev = airborne([HOME[0], bf(10, 40), HOME[2]], 2000, bf(10, 40), 0);
        assert_eq!(
            mv(&prev, [HOME[0], bf(10, 40), HOME[2]], false, 2125),
            Err(MoveError::Flying)
        );
    }

    #[test]
    fn falling_ten_blocks_deals_seven() {
        let prev = airborne([bf(-9, 128), bf(10, 154), bf(5, 0)], 1000, bf(20, 0), 200);
        let out = mv(&prev, [bf(-9, 128), bf(10, 0), bf(5, 0)], true, 1125).unwrap();
        assert_eq!(out.fall_damage, 7);
        assert_eq!(out.state.fall_start_y, bf(10, 0));
        assert_eq!(out.state.support_y, bf(10, 0));
        assert_eq!(out.state.support_ms, 1125);
    }

    #[test]
    fn falling_three_blocks_is_free() {
        let prev = airborne([bf(-9, 128), bf(10, 154), bf(5, 0)], 1000, bf(13, 0), 600);
        let out = mv(&prev, [bf(-9, 128), bf(10, 0), bf(5, 0)], true, 1125).unwrap();
        assert_eq!(out.fall_damage, 0);
    }

    #[test]
    fn falling_into_water_deals_zero() {
        let prev = airborne([bf(-35, 128), bf(11, 0), bf(5, 128)], 1000, bf(21, 0), 200);
        let out = mv(&prev, [bf(-35, 128), bf(9, 0), bf(5, 128)], false, 1125).unwrap();
        assert_eq!(out.fall_damage, 0);
        assert!(out.state.in_water);
        assert_eq!(out.state.fall_start_y, bf(9, 0));
        // Hitting the pool floor in one update: still water, still 0.
        let out = mv(&prev, [bf(-35, 128), bf(7, 0), bf(5, 128)], true, 1125).unwrap();
        assert_eq!(out.fall_damage, 0);
        assert!(out.state.in_water && out.state.on_ground);
    }

    #[test]
    fn fall_damage_disabled_deals_zero() {
        let p = WorldParams {
            fall_damage: 0,
            ..Default::default()
        };
        let prev = airborne([bf(-9, 128), bf(10, 154), bf(5, 0)], 1000, bf(20, 0), 200);
        let out = check_move(
            &p,
            &prev,
            [bf(-9, 128), bf(10, 0), bf(5, 0)],
            [0; 3],
            true,
            1125,
            &world(),
        )
        .unwrap();
        assert_eq!(out.fall_damage, 0);
    }

    #[test]
    fn swimming_speed_and_up() {
        let start = [bf(-35, 128), bf(8, 0), bf(5, 128)];
        let prev = MoveState {
            in_water: true,
            ..MoveState::spawn(start, 0)
        };
        // Swim speed 2 b/s: 0.75 block in 125 ms is too fast while fully in water
        // (allowance 2 * 1.25 * 0.125 + 0.25 = 0.56 block); on land it would be fine.
        assert_eq!(
            mv(&prev, [start[0] + 192, start[1], start[2]], false, 125),
            Err(MoveError::MoveTooFast)
        );
        mv(&prev, [start[0] + 64, start[1], start[2]], false, 125).unwrap();
        // Swim up 1 s worth without touching the ground.
        let mut st = prev;
        for i in 1..=8i64 {
            st = mv(
                &st,
                [start[0], start[1] + (64 * i) as i32, start[2]],
                false,
                i * 125,
            )
            .unwrap()
            .state;
        }
    }

    #[test]
    fn long_gap_caps_travel_at_two_seconds() {
        let prev = grounded([bf(5, 128), bf(10, 0), bf(-30, 128)], 0);
        mv(&prev, [bf(5, 128), bf(10, 0), bf(-19, 128)], true, 10_000).unwrap();
        // 14.25 blocks allowed (2 s * 5.6 b/s * 1.25 + 0.25), 15 not, however long the gap.
        assert_eq!(
            mv(&prev, [bf(5, 128), bf(10, 0), bf(-15, 128)], true, 10_000),
            Err(MoveError::MoveTooFast)
        );
        assert_eq!(
            mv(
                &prev,
                [bf(5, 128), bf(10, 0), bf(-15, 128)],
                true,
                1_000_000
            ),
            Err(MoveError::MoveTooFast)
        );
    }

    #[test]
    fn time_going_backwards_is_dt_zero() {
        let prev = grounded(HOME, 1000);
        assert_eq!(
            mv(&prev, [HOME[0] + 128, HOME[1], HOME[2]], true, 500),
            Err(MoveError::MoveTooFast)
        );
        let out = mv(&prev, [HOME[0] + 51, HOME[1], HOME[2]], true, 500).unwrap();
        assert_eq!(out.state.last_ms, 1000);
    }

    #[test]
    fn can_escape_a_block_placed_into_the_player() {
        // Standing inside the wall (e.g. someone placed a block on us): leaving is allowed.
        let prev = grounded([bf(20, 128), bf(10, 0), bf(5, 0)], 0);
        mv(&prev, [bf(19, 160), bf(10, 0), bf(5, 0)], true, 300).unwrap();
    }

    #[test]
    fn invalid_inputs_rejected() {
        let prev = grounded(HOME, 0);
        let bad = WorldParams {
            gravity: 0,
            ..Default::default()
        };
        assert_eq!(
            check_move(&bad, &prev, HOME, [0; 3], true, 125, &world()),
            Err(MoveError::InvalidState)
        );
        assert_eq!(
            check_move(
                &WorldParams::default(),
                &prev,
                HOME,
                [i32::MAX, 0, 0],
                true,
                125,
                &world()
            ),
            Err(MoveError::InvalidState)
        );
        assert_eq!(
            mv(&prev, [HOME[0], i32::MAX, HOME[2]], false, 125),
            Err(MoveError::InvalidState)
        );
    }

    /// Integer replica of a 60 fps client (semi-implicit Euler, positions in milli-FP).
    struct Client {
        x: i64,
        y: i64,
        vy: i64,
        on_ground: bool,
    }

    /// Runs `frames` frames sprinting +x, jumping whenever grounded if `hop`; sends every
    /// 8 frames and on every ground-contact change (landing / lift-off, a client parity
    /// requirement), asserting each update is accepted. Returns total fall damage.
    fn simulate(start: [i32; 3], frames: i64, hop: bool, ground_y: impl Fn(i64) -> i64) -> u32 {
        let p = WorldParams::default();
        let mut c = Client {
            x: start[0] as i64 * 1000,
            y: start[1] as i64 * 1000,
            vy: 0,
            on_ground: true,
        };
        let mut st = grounded(start, 0);
        let mut dmg = 0u32;
        for f in 1..=frames {
            if hop && c.on_ground {
                c.vy = p.jump_velocity as i64 * 1000;
            }
            c.x += p.sprint_speed as i64 * 1000 / 60;
            c.vy = (c.vy - p.gravity as i64 * 1000 / 60).max(-(p.max_fall_speed as i64) * 1000);
            c.y += c.vy / 60;
            let was_on_ground = c.on_ground;
            let g = ground_y(c.x / 1000) * 1000;
            if c.y <= g {
                c.y = g;
                c.vy = 0;
                c.on_ground = true;
            } else {
                c.on_ground = false;
            }
            if f % 8 == 0 || c.on_ground != was_on_ground {
                let pos = [(c.x / 1000) as i32, (c.y / 1000) as i32, start[2]];
                let vel = [p.sprint_speed as i32, (c.vy / 1000) as i32, 0];
                let now = f * 1000 / 60;
                let out = check_move(&p, &st, pos, vel, c.on_ground, now, &world())
                    .unwrap_or_else(|e| panic!("frame {f} pos {pos:?} rejected: {e:?}"));
                dmg += out.fall_damage as u32;
                st = out.state;
            }
        }
        dmg
    }

    #[test]
    fn simulated_bunny_hop_accepted() {
        let dmg = simulate([bf(0, 128), bf(10, 0), bf(5, 128)], 180, true, |_| 10 * 256);
        assert_eq!(dmg, 0);
    }

    #[test]
    fn simulated_walk_off_tower_deals_seven() {
        // Client box half-width 77: over the tower while its box overlaps x < -10.
        let dmg = simulate([bf(-12, 0), bf(20, 0), bf(5, 0)], 120, false, |x| {
            if x - 77 < -10 * 256 {
                20 * 256
            } else {
                10 * 256
            }
        });
        assert_eq!(dmg, 7);
    }

    #[test]
    fn chunk_quad_reads() {
        let mut a = [0u8; CHUNK_VOL];
        let mut d = [0u8; CHUNK_VOL];
        a[block_index(3, 5, 4)] = STONE;
        d[block_index(15, 0, 15)] = WATER;
        let q = ChunkQuad::new(-1, 2, [Some(&a), None, None, Some(&d)]);
        assert_eq!(q.get(-16 + 3, 5, 32 + 4), STONE);
        assert_eq!(q.get(-15, 5, 36), AIR);
        assert_eq!(q.get(15, 0, 63), WATER);
        assert_eq!(q.get(0, 5, 36), STONE); // missing (+1, 0) slot
        assert_eq!(q.get(-17, 5, 36), STONE); // outside the window
        assert_eq!(q.get(-15, -1, 36), Block::Bedrock as u8);
        assert_eq!(q.get(-15, 64, 36), AIR);
        assert_eq!(q.get(i32::MIN, 3, i32::MAX), STONE);
    }

    #[test]
    fn move_window_spans() {
        assert_eq!(move_window(HOME, HOME), Some((0, 0)));
        // Near the corner of chunk (0, 0): window starts at (-1, -1).
        assert_eq!(move_window([10, 2560, 10], [10, 2560, 10]), Some((-1, -1)));
        assert_eq!(move_window([128, 0, 128], [20 * 256, 0, 128]), Some((0, 0)));
        // 40 blocks apart in x: more than two chunks.
        assert_eq!(move_window([128, 0, 128], [40 * 256, 0, 128]), None);
        assert_eq!(move_window([i32::MIN, 0, 0], [i32::MAX, 0, 0]), None);
    }

    /// xorshift64*
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn i32(&mut self) -> i32 {
            match self.next() % 4 {
                0 => self.next() as i32,
                1 => [i32::MIN, i32::MAX, 0, -1][(self.next() % 4) as usize],
                _ => (self.next() % 20_000) as i32 - 5_000,
            }
        }
        fn i64(&mut self) -> i64 {
            match self.next() % 3 {
                0 => self.next() as i64,
                1 => [i64::MIN, i64::MAX, 0][(self.next() % 3) as usize],
                _ => (self.next() % 10_000) as i64,
            }
        }
    }

    #[test]
    fn fuzz_never_panics() {
        let mut r = Rng(0x9E37_79B9_7F4A_7C15);
        let w = world();
        let mut plausible_ok = 0;
        for i in 0..6000 {
            let garbage = i % 2 == 0;
            let params = if i % 8 == 0 {
                let mut b = [0u8; WorldParams::SIZE];
                for x in b.iter_mut() {
                    *x = r.next() as u8;
                }
                WorldParams::from_bytes(&b)
            } else {
                WorldParams::default()
            };
            let (prev, new_pos, vel, now) = if garbage {
                let prev = MoveState {
                    pos: [r.i32(), r.i32(), r.i32()],
                    vel: [r.i32(), r.i32(), r.i32()],
                    on_ground: r.next().is_multiple_of(2),
                    fall_start_y: r.i32(),
                    last_ms: r.i64(),
                    in_water: r.next().is_multiple_of(2),
                    support_y: r.i32(),
                    support_ms: r.i64(),
                };
                let new_pos = if r.next().is_multiple_of(2) {
                    prev.pos
                        .map(|c| c.wrapping_add((r.next() % 2000) as i32 - 1000))
                } else {
                    [r.i32(), r.i32(), r.i32()]
                };
                (prev, new_pos, [r.i32(), r.i32(), r.i32()], r.i64())
            } else {
                // Plausible: near the test world's features, small steps.
                let t = (r.next() % 100_000) as i64;
                let pos = [
                    (r.next() % (100 * 256)) as i32 - 50 * 256,
                    10 * 256 + (r.next() % 1024) as i32 - 256,
                    (r.next() % (30 * 256)) as i32 - 10 * 256,
                ];
                let prev = MoveState {
                    on_ground: r.next().is_multiple_of(2),
                    in_water: r.next().is_multiple_of(4),
                    ..MoveState::spawn(pos, t)
                };
                let new_pos = pos.map(|c| c + (r.next() % 600) as i32 - 300);
                let vel = [0, (r.next() % 4000) as i32 - 2000, 0];
                (prev, new_pos, vel, t + (r.next() % 3000) as i64 - 500)
            };
            let res = check_move(
                &params,
                &prev,
                new_pos,
                vel,
                r.next().is_multiple_of(2),
                now,
                &w,
            );
            if !garbage && res.is_ok() {
                plausible_ok += 1;
            }
            let _ = params.validate();
            let _ = move_window(prev.pos, new_pos);
        }
        assert!(
            plausible_ok > 100,
            "fuzz rarely reached accepted moves: {plausible_ok}"
        );
    }

    #[test]
    fn worst_case_reads_bounded() {
        // 2 s gap: ~14 blocks diagonal plus a 40-block fall (the most block reads with
        // default params: tall vertical sweep + max horizontal samples).
        let w = world();
        let p = WorldParams::default();
        let prev = airborne([bf(0, 0), bf(50, 0), bf(-40, 0)], 0, bf(50, 0), 0);
        let res = check_move(
            &p,
            &prev,
            [bf(9, 0), bf(10, 0), bf(-31, 0)],
            [0; 3],
            true,
            2000,
            &w,
        );
        assert!(res.is_ok(), "{res:?}");
        let reads = w.reads.get();
        println!("worst-case block reads: {reads}");
        assert!(reads <= 600, "{reads}");
        // Typical 8 Hz sprint step.
        let w = world();
        let prev = grounded(HOME, 0);
        mv_on(&w, &prev, [HOME[0] + 179, HOME[1], HOME[2]]);
        println!("typical block reads: {}", w.reads.get());
        assert!(w.reads.get() <= 60);
    }

    fn mv_on(w: &TestWorld, prev: &MoveState, pos: [i32; 3]) {
        check_move(&WorldParams::default(), prev, pos, [0; 3], true, 125, w).unwrap();
    }

    #[test]
    #[ignore]
    fn bench_check_move() {
        let p = WorldParams::default();
        let w = world();
        let n = 200_000u32;
        let prev = grounded(HOME, 0);
        let t = std::time::Instant::now();
        for i in 0..n {
            let x = HOME[0] + 179 + (i % 3) as i32;
            let r = check_move(&p, &prev, [x, HOME[1], HOME[2]], [0; 3], true, 125, &w);
            assert!(r.is_ok());
        }
        println!("typical sprint step: {:?}/call", t.elapsed() / n);
        let prev = airborne([bf(0, 0), bf(50, 0), bf(-40, 0)], 0, bf(50, 0), 0);
        let t = std::time::Instant::now();
        for i in 0..n / 10 {
            let x = bf(9, (i % 3) as i32);
            let r = check_move(
                &p,
                &prev,
                [x, bf(10, 0), bf(-31, 0)],
                [0; 3],
                true,
                2000,
                &w,
            );
            assert!(r.is_ok());
        }
        println!("worst-case step: {:?}/call", t.elapsed() / (n / 10));
    }
}
