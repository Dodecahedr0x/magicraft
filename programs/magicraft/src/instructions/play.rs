//! Playing in a world: `join_world` and `move_player`.
//!
//! # `join_world`
//! Creates the ephemeral `PlayerState` `["pstate", world, player]` (432 B, rent 15 744,
//! sponsored by the Player) at `World.spawn` (block coordinates → FP feet position at the
//! block center: `(x·256 + 128, y·256, z·256 + 128)`), health and food 20,
//! `MoveState::spawn(pos, chain_ms)`: `last_ms` = the chain-time reading at join, so the
//! client's first update must carry `client_ms > last_ms` (it reads `last_ms` back from the
//! account). Requires `World.spawn_set` (`SpawnNotSet`); the first join of a world records
//! `World.first_join_ms` (World writable; the clock stops stepping back, `state::TimeAnchor`);
//! joining twice fails (the account
//! exists). **The presence entry is not created at join**: the first `move_player` adds it
//! (a move re-adds a missing own entry anyway, e.g. after it was pruned), which keeps join
//! free of the presence account and its write lock.
//!
//! # `move_player(pos, vel, on_ground, client_ms)`
//! Accounts: World **read-only** (chain time + params; never re-arms the day crank), the
//! mover's Player (mut: presence rent sponsor), its `PlayerState` (mut), the up-to-4 chunks
//! of the 2×2 window `physics::move_window(prev.pos, pos)` in slot order `(cx0, cz0)`,
//! `(cx0+1, cz0)`, `(cx0, cz0+1)`, `(cx0+1, cz0+1)` (read-only), the presence of the chunk
//! containing `pos` (mut) and, when the move crosses a chunk border, the presence of the
//! previous chunk (mut, **required**). Steps:
//! 1. `Dead` if health is 0 (until `respawn`, Task 19). Every window slot overlapped by
//!    the xz footprint (± `GROUND_HALF_W`) of the previous **or** the new position must be
//!    passed and ready ([`required_slots`]), else `ChunkNotReady`. Only the other slots (reachable only by the swept path across a
//!    chunk corner) may be omitted and read as Stone, which can only block. Otherwise a
//!    client could omit its own chunk: the previous box would read Stone, and the "stuck"
//!    rule of `check_move` (plus the omitted presence) would let it skip walls / damage.
//! 2. `physics::check_move` with `chain_ms` from `World::chain_ms_ro`; a *coarse* reading
//!    (anchor stale) is shifted forward by `COARSE_LEAD_MS − LEAD_MS` (750 ms), i.e. the
//!    allowed lead becomes 1 000 ms (the coarse reading floors to the second) and the lag
//!    tolerance shrinks to 1 250 ms. Rejections map to `MoveTooFast`…`TimeSkew`; a move
//!    spanning more than a 2×2 window → `MoveTooFast`. On any error nothing changes (the
//!    client snaps back).
//! 3. Presence (`crate::presence`): crossing → leave the old list (refund) first, then
//!    update/insert own entry in the new list, pruning ≤ 4 stale entries (refund to the
//!    mover). `pending_damage` of both entries is applied.
//! 4. Vitals ([`apply_vitals`]): fall + pending damage, hunger, regeneration, starvation.
//! 5. Store `MoveState`, current chunk `(cx, cz)`, vitals; `crank::maybe_arm_chunk` on the
//!    new chunk (read-only; re-arms its tick crank only if stale, see `crank`).
//!
//! # Players in the world (`World.players_online`, `PlayerState.in_world`)
//! `move_player` keeps the World read-only (no write lock between movers), so the count
//! changes only on explicit transitions, each holding the World writable:
//! - `join_world`: +1 (`in_world = 1`); `enter_world` (back into a joined world): +1 unless
//!   already in; `leave_world` ("Back to worlds"): −1;
//! - `expire_players` (permissionless) / the `remaining_accounts` of `enter_world`: −1 for
//!   each PlayerState counted in whose last move is older than [`EXPIRE_MS`] (1 min): a closed
//!   or crashed client. Clients send it for the stale ones they find, so the count of a
//!   world nobody is playing in still comes down whenever someone looks at the world list.
//!
//! `move_player` and every world action require `in_world` (`NotInWorld`): a counted-out
//! (expired) player is out of the world — its client returns to the world list — until
//! `enter_world` counts it back in.
//!
//! The previous chunk is the chunk of `prev.pos` (always a required slot); `PlayerState`
//! `cx`/`cz` is a cache of the chunk of the stored position.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::MagicProgram;
use ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;
use ephemeral_rollups_sdk::ephemeral_accounts::{rent, EphemeralAccount};
use magicraft_core::consts::{CHUNK_VOL, FP};
use magicraft_core::inventory::{Inventory, MAX_FOOD};
use magicraft_core::physics::{
    check_move, move_window, ChunkQuad, MoveState, GROUND_HALF_W, LEAD_MS,
};
use session_keys::{session_auth_or, Session, SessionError, SessionTokenV2};

use crate::auth::{player_seeds, pstate_seeds};
use crate::errors::MagicraftError;
use crate::instructions::crank::maybe_arm_chunk;
use crate::presence::{self, Sponsor};
use crate::state::{
    chunk_header, ensure_sponsor_reserve, ready_chunk_blocks_ro, Player, PlayerState, World,
    MAX_HEALTH, PLAYER_SEED, PSTATE_SEED,
};

/// Byte size of the `PlayerState` account.
pub const PSTATE_LEN: usize = 8 + PlayerState::INIT_SPACE;
/// Allowed lead of `client_ms` over a *coarse* chain-time reading, ms (fine readings:
/// `physics::LEAD_MS` = 250).
pub const COARSE_LEAD_MS: i64 = 1_000;

// ---------- vitals (hunger / regeneration / damage) ----------

/// One food point is consumed per this much exhaustion.
pub const EXHAUSTION_PER_FOOD: u32 = 4_000;
/// Horizontal travel exhaustion: 1 unit per this many FP (16 units per block, so one food
/// point per 250 blocks of travel).
pub const EXHAUST_FP_PER_UNIT: u64 = 16;
/// Time exhaustion: 1 unit per this many ms of (client) time between accepted moves
/// (20 units/s, one food point per 200 s). The gap is clamped to [`EXHAUST_MAX_GAP_MS`]
/// (not to the 2 s movement cap, so sending rarely does not dodge hunger). With continuous walking (~4.3 blocks/s) food
/// lasts ≈ 20 × 4 000 / (69 + 20) s ≈ 15 min.
pub const EXHAUST_MS_PER_UNIT: u64 = 50;
/// Largest move gap counted for time exhaustion, ms (a player who was away does not come
/// back starved).
pub const EXHAUST_MAX_GAP_MS: i64 = 10_000;
/// Regeneration / starvation step period, ms of client time (≈ 4 s, at most one step per
/// move: long gaps do not accumulate steps).
pub const VITALS_TICK_MS: i64 = 4_000;
/// Regeneration (+1 health per step) requires at least this much food.
pub const REGEN_MIN_FOOD: u8 = 18;
/// Exhaustion cost of one regenerated health point (3/8 of a food point).
pub const REGEN_EXHAUSTION: u32 = 1_500;
/// Starvation (food 0) deals 1 damage per step but never below this health
/// (Minecraft "normal" difficulty: starving cannot kill).
pub const STARVE_MIN_HEALTH: u8 = 1;

/// The mutable vitals of a `PlayerState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Vitals {
    pub health: u8,
    pub food: u8,
    pub exhaustion: u16,
    /// Last regeneration / starvation step, ms (client time of an accepted move).
    pub tick_ms: i64,
}

/// Applies one accepted move to the vitals: `damage` (fall + pending, saturating; health 0
/// = dead, nothing else happens), then — with `hunger` on — exhaustion from `dist_fp`
/// horizontal travel and `dt_ms` elapsed (food −1 per [`EXHAUSTION_PER_FOOD`]), then at most
/// one [`VITALS_TICK_MS`] step at `now_ms`: regeneration (+1 health if food ≥ 18 and
/// health < 20; costs [`REGEN_EXHAUSTION`] with hunger on) or starvation (food 0, hunger
/// on: −1 health down to [`STARVE_MIN_HEALTH`]). With hunger off food never changes.
/// Total: no panics, all arithmetic saturating/unsigned.
pub fn apply_vitals(
    v: &mut Vitals,
    hunger: bool,
    damage: u32,
    dist_fp: u64,
    dt_ms: u64,
    now_ms: i64,
) {
    v.health = v.health.saturating_sub(damage.min(u8::MAX as u32) as u8);
    if v.health == 0 {
        return;
    }
    let mut ex = v.exhaustion as u32;
    if hunger {
        let add = (dist_fp / EXHAUST_FP_PER_UNIT).saturating_add(dt_ms / EXHAUST_MS_PER_UNIT);
        ex = ex.saturating_add(add.min(u32::MAX as u64) as u32);
    }
    if now_ms.saturating_sub(v.tick_ms) >= VITALS_TICK_MS {
        v.tick_ms = now_ms;
        if v.food >= REGEN_MIN_FOOD && v.health < MAX_HEALTH {
            v.health += 1;
            if hunger {
                ex = ex.saturating_add(REGEN_EXHAUSTION);
            }
        } else if hunger && v.food == 0 && v.health > STARVE_MIN_HEALTH {
            v.health -= 1;
        }
    }
    let points = ex / EXHAUSTION_PER_FOOD;
    v.food = v.food.saturating_sub(points.min(u8::MAX as u32) as u8);
    v.exhaustion = (ex % EXHAUSTION_PER_FOOD) as u16;
}

/// Cheap horizontal distance estimate, FP: `max + min/2` of `|dx|, |dz|` (overestimates
/// the Euclidean distance by ≤ 12 %; no sqrt, unsigned ops only).
pub fn approx_dist(a: [i32; 3], b: [i32; 3]) -> u64 {
    let dx = (a[0] as i64 - b[0] as i64).unsigned_abs();
    let dz = (a[2] as i64 - b[2] as i64).unsigned_abs();
    dx.max(dz) + dx.min(dz) / 2
}

/// Window slots (order `(cx0,cz0)`, `(cx0+1,cz0)`, `(cx0,cz0+1)`, `(cx0+1,cz0+1)`) that
/// the xz footprint (± `GROUND_HALF_W`, which covers the collision box) of `a` or `b`
/// overlaps; these chunks must be passed to `move_player`.
pub fn required_slots(a: [i32; 3], b: [i32; 3], cx0: i32, cz0: i32) -> [bool; 4] {
    let m = GROUND_HALF_W as i64;
    let mut req = [false; 4];
    for p in [a, b] {
        let (x, z) = (p[0] as i64, p[2] as i64);
        for cz in ((z - m) >> 12)..=((z + m - 1) >> 12) {
            for cx in ((x - m) >> 12)..=((x + m - 1) >> 12) {
                let (dx, dz) = (cx - cx0 as i64, cz - cz0 as i64);
                if (0..2).contains(&dx) && (0..2).contains(&dz) {
                    req[(dz * 2 + dx) as usize] = true;
                }
            }
        }
    }
    req
}

/// Chunk of an FP coordinate (floor division by 16 blocks; arithmetic shift, no division).
#[inline]
pub fn chunk_of(v: i32) -> i32 {
    v >> 12
}

const _: () = assert!(FP == 256 && magicraft_core::consts::CHUNK_W == 16);

/// `World.spawn` (block coordinates of the feet block) → FP feet position (block center).
pub fn spawn_pos(spawn: [i32; 3]) -> [i32; 3] {
    [
        spawn[0].saturating_mul(FP).saturating_add(FP / 2),
        spawn[1].saturating_mul(FP),
        spawn[2].saturating_mul(FP).saturating_add(FP / 2),
    ]
}

// ---------- join_world (ER) ----------

#[derive(Accounts, Session)]
pub struct JoinWorld<'info> {
    /// Wallet or session key of `player`'s authority.
    pub signer: Signer<'info>,
    /// Sponsor of the PlayerState rent. `mut` ⇒ delegated on the ER.
    #[account(mut, seeds = [PLAYER_SEED, player.authority.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
    #[session(signer = signer, authority = player.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
    /// The spawn must be set; mut: the first join records `first_join_ms` (freezes the
    /// clock's backward correction).
    #[account(mut, constraint = world.spawn_set @ MagicraftError::SpawnNotSet)]
    pub world: Account<'info, World>,
    /// CHECK: the PlayerState PDA, created here (fails if it exists).
    #[account(
        mut,
        seeds = [PSTATE_SEED, world.key().as_ref(), player.key().as_ref()],
        bump
    )]
    pub player_state: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

/// Creates the player's `PlayerState` in `world` at the spawn (see the module docs).
#[session_auth_or(
    ctx.accounts.player.authority == ctx.accounts.signer.key(),
    MagicraftError::Unauthorized
)]
pub fn join_world(ctx: Context<JoinWorld>) -> Result<()> {
    let a = &ctx.accounts;
    let player_ai = a.player.to_account_info();
    let ps_ai = a.player_state.to_account_info();
    ensure_sponsor_reserve(&player_ai, rent(PSTATE_LEN as u32))?;

    let (world_key, player_key, authority) = (a.world.key(), a.player.key(), a.player.authority);
    let (pbump, sbump) = ([a.player.bump], [ctx.bumps.player_state]);
    EphemeralAccount::new(&player_ai, &ps_ai, &a.vault.to_account_info())
        .with_signer_seeds(&[
            &player_seeds(&authority, &pbump),
            &pstate_seeds(&world_key, &player_key, &sbump),
        ])
        .create(PSTATE_LEN as u32)?;

    let clock = Clock::get()?;
    let world = &mut ctx.accounts.world;
    if world.first_join_ms == 0 && world.seed_set {
        // Last backward-capable re-anchor before the first stamp (`state::TimeAnchor`).
        world.tick_clock(&clock);
    }
    let now = world.chain_ms_ro(&clock).ms;
    world.note_join(now);
    // Joining enters the world (`in_world: 1` below).
    world.players_online = world.players_online.saturating_add(1);
    world.entries = world.entries.wrapping_add(1);
    let pos = spawn_pos(world.spawn);
    let mut s = PlayerState {
        player: player_key,
        world: world_key,
        bump: ctx.bumps.player_state,
        move_state: [0; 72],
        health: MAX_HEALTH,
        food: MAX_FOOD,
        exhaustion: 0,
        inventory: Inventory::new().to_bytes(),
        held_slot: 0,
        cx: chunk_of(pos[0]),
        cz: chunk_of(pos[2]),
        break_until_ms: 0,
        attack_until_ms: 0,
        food_tick_ms: now,
        respawn_ms: 0,
        in_world: 1,
        _reserved: [0; 25],
    };
    s.set_move_state(&MoveState::spawn(pos, now));
    s.try_serialize(&mut &mut ps_ai.try_borrow_mut_data()?[..])?;
    Ok(())
}

// ---------- move_player (ER) ----------

#[derive(Accounts, Session)]
pub struct MovePlayer<'info> {
    /// Wallet or session key of `player`'s authority.
    pub signer: Signer<'info>,
    /// Presence rent sponsor (grow: pays, shrink/prune: refunded). `mut` ⇒ delegated.
    #[account(mut, seeds = [PLAYER_SEED, player.authority.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
    #[session(signer = signer, authority = player.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
    /// Read-only: chain time and params. Never written (no write lock between movers).
    pub world: Account<'info, World>,
    /// The mover's state in `world` (stored identity checked instead of a PDA derivation:
    /// only `join_world` writes these fields, at the PDA of the pair it stores).
    #[account(
        mut,
        constraint = player_state.player == player.key() @ MagicraftError::Unauthorized,
        constraint = player_state.world == world.key() @ MagicraftError::Unauthorized
    )]
    pub player_state: Account<'info, PlayerState>,
    /// CHECK: window chunk `(cx0, cz0)`, validated by `ready_chunk_blocks_ro`.
    pub chunk00: Option<UncheckedAccount<'info>>,
    /// CHECK: window chunk `(cx0 + 1, cz0)`.
    pub chunk10: Option<UncheckedAccount<'info>>,
    /// CHECK: window chunk `(cx0, cz0 + 1)`.
    pub chunk01: Option<UncheckedAccount<'info>>,
    /// CHECK: window chunk `(cx0 + 1, cz0 + 1)`.
    pub chunk11: Option<UncheckedAccount<'info>>,
    /// CHECK: presence of the chunk containing the new position (`presence_of`).
    #[account(mut)]
    pub presence: UncheckedAccount<'info>,
    /// CHECK: presence of the previous chunk; required when crossing a border into another
    /// chunk (`presence_of`; `InvalidPresence` if missing or of another chunk).
    #[account(mut)]
    pub old_presence: Option<UncheckedAccount<'info>>,
    /// CHECK: ephemeral rent vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

/// Validates and applies one movement update (see the module docs).
#[session_auth_or(
    ctx.accounts.player.authority == ctx.accounts.signer.key(),
    MagicraftError::Unauthorized
)]
pub fn move_player(
    ctx: Context<MovePlayer>,
    pos: [i32; 3],
    vel: [i32; 3],
    on_ground: bool,
    client_ms: i64,
) -> Result<()> {
    let a = &ctx.accounts;
    require!(!a.player_state.is_dead(), MagicraftError::Dead);
    require!(a.player_state.in_world != 0, MagicraftError::NotInWorld);
    let prev = a.player_state.move_state()?;
    let world = &a.world;
    let world_key = world.key();
    let t = world.chain_ms_ro(&Clock::get()?);
    let chain_ms = if t.coarse {
        t.ms.saturating_add(COARSE_LEAD_MS - LEAD_MS)
    } else {
        t.ms
    };

    // 2×2 chunk window covering every block the check may read.
    let (cx0, cz0) = move_window(prev.pos, pos).ok_or(MagicraftError::MoveTooFast)?;
    let slots: [Option<&AccountInfo>; 4] = [
        a.chunk00.as_deref(),
        a.chunk10.as_deref(),
        a.chunk01.as_deref(),
        a.chunk11.as_deref(),
    ];
    let required = required_slots(prev.pos, pos, cx0, cz0);
    for (r, s) in required.iter().zip(slots.iter()) {
        require!(!r || s.is_some(), MagicraftError::ChunkNotReady);
    }
    let slot_key = |cx: i32, cz: i32| -> Option<Pubkey> {
        let (dx, dz) = (cx.wrapping_sub(cx0), cz.wrapping_sub(cz0));
        if !(0..2).contains(&dx) || !(0..2).contains(&dz) {
            return None;
        }
        slots[(dz * 2 + dx) as usize].map(|ai| ai.key())
    };
    let outcome = {
        let mut refs: [Option<core::cell::Ref<[u8; CHUNK_VOL]>>; 4] = [None, None, None, None];
        for (i, ai) in slots.iter().enumerate() {
            if let Some(ai) = ai {
                let (dx, dz) = ((i & 1) as i32, (i >> 1) as i32);
                refs[i] = Some(ready_chunk_blocks_ro(
                    ai,
                    &world_key,
                    cx0.wrapping_add(dx),
                    cz0.wrapping_add(dz),
                )?);
            }
        }
        let quad = ChunkQuad::new(
            cx0,
            cz0,
            [
                refs[0].as_deref(),
                refs[1].as_deref(),
                refs[2].as_deref(),
                refs[3].as_deref(),
            ],
        );
        check_move(
            &world.core_params(),
            &prev,
            pos,
            vel,
            on_ground,
            client_ms,
            chain_ms,
            &quad,
        )
        .map_err(MagicraftError::from)?
    };

    // Presence: leave the previous chunk's list (refund) before entering the new one.
    let (ncx, ncz) = (chunk_of(pos[0]), chunk_of(pos[2]));
    let (ocx, ocz) = (chunk_of(prev.pos[0]), chunk_of(prev.pos[2]));
    let new_chunk = slot_key(ncx, ncz).ok_or(MagicraftError::ChunkNotReady)?;
    let player_ai = a.player.to_account_info();
    let vault_ai = a.vault.to_account_info();
    let (authority, pbump) = (a.player.authority, [a.player.bump]);
    let pseeds = player_seeds(&authority, &pbump);
    let sponsor = Sponsor {
        player: &player_ai,
        vault: &vault_ai,
        seeds: &pseeds,
    };
    let me = a.player.key();
    let mut pending = 0u32;
    if (ncx, ncz) != (ocx, ocz) {
        // The previous chunk is a required slot, so it was passed.
        let old_chunk = slot_key(ocx, ocz).ok_or(MagicraftError::ChunkNotReady)?;
        let old = a
            .old_presence
            .as_ref()
            .ok_or(MagicraftError::InvalidPresence)?;
        pending +=
            presence::leave(old, &old_chunk, &me, a.player_state.respawn_ms, &sponsor)? as u32;
    }
    pending += presence::enter_or_update(
        &a.presence,
        &new_chunk,
        &me,
        pos,
        t.ms,
        a.player_state.respawn_ms,
        &sponsor,
    )? as u32;

    let ps = &a.player_state;
    let mut v = Vitals {
        health: ps.health,
        food: ps.food,
        exhaustion: ps.exhaustion,
        tick_ms: ps.food_tick_ms,
    };
    let dt = client_ms
        .saturating_sub(prev.last_ms)
        .clamp(0, EXHAUST_MAX_GAP_MS) as u64;
    apply_vitals(
        &mut v,
        world.params.hunger != 0,
        outcome.fall_damage as u32 + pending,
        approx_dist(prev.pos, pos),
        dt,
        client_ms,
    );
    if outcome.fall_damage > 0 || pending > 0 {
        msg!(
            "damage fall {} pending {} → health {}",
            outcome.fall_damage,
            pending,
            v.health
        );
    }

    // Watchdog: the mover is fresh presence, i.e. work for the crank (stale-gated).
    maybe_arm_chunk(
        slots[((ncz - cz0) * 2 + (ncx - cx0)) as usize].unwrap(),
        world,
        t.ms,
    )?;

    let ps = &mut ctx.accounts.player_state;
    ps.set_move_state(&outcome.state);
    ps.cx = ncx;
    ps.cz = ncz;
    ps.health = v.health;
    ps.food = v.food;
    ps.exhaustion = v.exhaustion;
    ps.food_tick_ms = v.tick_ms;
    Ok(())
}

// ---------- leave_world ----------

#[derive(Accounts, Session)]
pub struct LeaveWorld<'info> {
    pub signer: Signer<'info>,
    /// Presence rent sponsor (the freed entry is refunded to it). `mut` ⇒ delegated.
    #[account(mut, seeds = [PLAYER_SEED, player.authority.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
    #[session(signer = signer, authority = player.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
    /// `players_online` −1.
    #[account(mut)]
    pub world: Account<'info, World>,
    #[account(
        mut,
        constraint = player_state.player == player.key() @ MagicraftError::Unauthorized,
        constraint = player_state.world == world.key() @ MagicraftError::Unauthorized
    )]
    pub player_state: Account<'info, PlayerState>,
    /// CHECK: the chunk of the stored position (`PlayerState.cx/cz`; stored identity).
    pub chunk: UncheckedAccount<'info>,
    /// CHECK: its presence list (`presence_of`).
    #[account(mut)]
    pub presence: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

/// Leaves the world for now (the client's "exit world"): removes the player's entry from
/// the presence list of its current chunk (refund to its Player), so zombies and other
/// players no longer see or hit it; the next `move_player` re-adds it. Pending damage on
/// the entry is applied first (leaving does not dodge hits already taken; it can kill).
/// Not listed (already pruned / never moved) → no-op. Allowed while dead.
#[session_auth_or(
    ctx.accounts.player.authority == ctx.accounts.signer.key(),
    MagicraftError::Unauthorized
)]
pub fn leave_world(ctx: Context<LeaveWorld>) -> Result<()> {
    let a = &ctx.accounts;
    let ps = &a.player_state;
    {
        let h = chunk_header(&a.chunk)?;
        require!(
            h.world == a.world.key() && h.cx.get() == ps.cx && h.cz.get() == ps.cz,
            MagicraftError::InvalidChunk
        );
    }
    let player_ai = a.player.to_account_info();
    let vault_ai = a.vault.to_account_info();
    let (authority, pbump) = (a.player.authority, [a.player.bump]);
    let pseeds = player_seeds(&authority, &pbump);
    let sponsor = Sponsor {
        player: &player_ai,
        vault: &vault_ai,
        seeds: &pseeds,
    };
    let me = a.player.key();
    let pending = presence::leave(&a.presence, a.chunk.key, &me, ps.respawn_ms, &sponsor)?;
    let a = &mut *ctx.accounts;
    let ps = &mut a.player_state;
    if pending > 0 && !ps.is_dead() {
        ps.health = ps.health.saturating_sub(pending);
        msg!("leave: pending damage {} → health {}", pending, ps.health);
    }
    if ps.in_world != 0 {
        ps.in_world = 0;
        a.world.players_online = a.world.players_online.saturating_sub(1);
    }
    Ok(())
}

// ---------- enter_world / expire_players ----------

/// A player counts as gone (crashed tab, lost connection) once its last accepted move is
/// older than this, chain ms (moves come every ≤ 1 s while in the world, hidden tabs
/// included; well above `presence::STALE_MS`).
pub const EXPIRE_MS: i64 = 60_000;
/// At most this many `PlayerState`s per `expire_players` / `enter_world` call (CU bound).
pub const MAX_EXPIRE: usize = 8;

#[derive(Accounts, Session)]
pub struct EnterWorld<'info> {
    pub signer: Signer<'info>,
    /// Read-only; tied to `player_state`.
    pub player: Account<'info, Player>,
    #[session(signer = signer, authority = player.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
    /// `players_online` +1.
    #[account(mut)]
    pub world: Account<'info, World>,
    #[account(
        mut,
        constraint = player_state.player == player.key() @ MagicraftError::Unauthorized,
        constraint = player_state.world == world.key() @ MagicraftError::Unauthorized
    )]
    pub player_state: Account<'info, PlayerState>,
}

/// Comes back into a joined world (the client's "Resume"): `in_world = 1` and
/// `players_online` +1, unless already in (no-op: a reload or a second tab). The move
/// clock is not touched: the next `move_player` carries on from the stored state.
/// `remaining_accounts`: up to [`MAX_EXPIRE`] PlayerStates to expire (as [`expire_players`]).
#[session_auth_or(
    ctx.accounts.player.authority == ctx.accounts.signer.key(),
    MagicraftError::Unauthorized
)]
pub fn enter_world(ctx: Context<EnterWorld>) -> Result<()> {
    let now = ctx.accounts.world.chain_ms_ro(&Clock::get()?).ms;
    let me = ctx.accounts.player_state.key();
    let expired = expire_list(
        &ctx.accounts.world.key(),
        ctx.remaining_accounts,
        now,
        Some(&me),
    )?;
    let a = &mut *ctx.accounts;
    a.world.players_online = a.world.players_online.saturating_sub(expired);
    if a.player_state.in_world == 0 {
        a.player_state.in_world = 1;
        a.world.players_online = a.world.players_online.saturating_add(1);
        a.world.entries = a.world.entries.wrapping_add(1);
    }
    Ok(())
}

#[derive(Accounts)]
pub struct ExpirePlayers<'info> {
    /// `players_online` − the expired count.
    #[account(mut)]
    pub world: Account<'info, World>,
}

/// Permissionless: takes the `remaining_accounts` PlayerStates (≤ [`MAX_EXPIRE`], mut) of
/// `world` that are counted in but silent for over [`EXPIRE_MS`] out of the count
/// (`in_world = 0`, `players_online` −1 each). Others are skipped (not an error: the
/// caller's view may be a little old). Their next `move_player` fails `NotInWorld` until
/// they `enter_world` again.
pub fn expire_players(ctx: Context<ExpirePlayers>) -> Result<()> {
    let now = ctx.accounts.world.chain_ms_ro(&Clock::get()?).ms;
    let n = expire_list(&ctx.accounts.world.key(), ctx.remaining_accounts, now, None)?;
    let w = &mut ctx.accounts.world;
    w.players_online = w.players_online.saturating_sub(n);
    if n > 0 {
        msg!("expired {} → {} online", n, w.players_online);
    }
    Ok(())
}

/// Pure: a PlayerState counted in (`in_world`) whose last move is older than [`EXPIRE_MS`].
pub fn expirable(in_world: u8, last_ms: i64, now: i64) -> bool {
    in_world != 0 && now.saturating_sub(last_ms) > EXPIRE_MS
}

/// Expires the PlayerStates of `world` in `accounts` (see [`expire_players`]); `skip`: the
/// caller's own state. Returns how many were expired.
fn expire_list<'a, 'info>(
    world: &Pubkey,
    accounts: &'a [AccountInfo<'info>],
    now: i64,
    skip: Option<&Pubkey>,
) -> Result<u32> {
    require!(accounts.len() <= MAX_EXPIRE, MagicraftError::InvalidTarget);
    let mut n = 0u32;
    for ai in accounts {
        if skip == Some(ai.key) || !ai.is_writable {
            continue;
        }
        require_keys_eq!(*ai.owner, crate::ID, MagicraftError::Unauthorized);
        let mut data = ai.try_borrow_mut_data()?;
        // Checks the discriminator.
        let mut ps = PlayerState::try_deserialize(&mut &data[..])?;
        require_keys_eq!(ps.world, *world, MagicraftError::Unauthorized);
        if !expirable(ps.in_world, ps.move_state()?.last_ms, now) {
            continue;
        }
        ps.in_world = 0;
        ps.try_serialize(&mut &mut data[..])?;
        n += 1;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    #[test]
    fn expirable_only_when_in_and_silent() {
        use super::{expirable, EXPIRE_MS};
        let now = 1_000_000;
        assert!(expirable(1, now - EXPIRE_MS - 1, now));
        assert!(!expirable(1, now - EXPIRE_MS, now));
        assert!(!expirable(0, 0, now));
    }

    use super::*;

    fn full() -> Vitals {
        Vitals {
            health: 20,
            food: 20,
            exhaustion: 0,
            tick_ms: 0,
        }
    }

    #[test]
    fn damage_and_death() {
        let mut v = full();
        apply_vitals(&mut v, true, 5, 0, 0, 1);
        assert_eq!(v.health, 15);
        // Lethal: nothing else happens (no regen even when a tick is due).
        let mut v = full();
        v.food = 20;
        apply_vitals(&mut v, true, 300, 10_000, 2_000, 100_000);
        assert_eq!(
            v,
            Vitals {
                health: 0,
                ..full()
            }
        );
    }

    #[test]
    fn dead_state_is_health_zero() {
        // `move_player` rejects with `Dead` exactly when `PlayerState::is_dead`.
        let mut v = full();
        apply_vitals(&mut v, false, 20, 0, 0, 0);
        assert_eq!(v.health, 0);
    }

    #[test]
    fn exhaustion_drains_food() {
        let mut v = full();
        // 250 blocks of travel = 4 000 units = 1 food point.
        apply_vitals(&mut v, true, 0, 250 * 256, 0, 0);
        assert_eq!((v.food, v.exhaustion), (19, 0));
        // 200 s of time = 1 food point (accumulated over capped 2 s moves).
        for _ in 0..100 {
            apply_vitals(&mut v, true, 0, 0, 2_000, 0);
        }
        assert_eq!((v.food, v.exhaustion), (18, 0));
        // Hunger off: nothing drains.
        let mut v = full();
        apply_vitals(&mut v, false, 0, 1 << 40, 2_000, 0);
        assert_eq!(v, full());
    }

    #[test]
    fn regeneration_every_tick_when_fed() {
        let mut v = Vitals {
            health: 10,
            ..full()
        };
        apply_vitals(&mut v, true, 0, 0, 0, 3_999);
        assert_eq!(v.health, 10);
        apply_vitals(&mut v, true, 0, 0, 0, 4_000);
        assert_eq!((v.health, v.exhaustion, v.tick_ms), (11, 1_500, 4_000));
        // At most one step per move, however long the gap.
        apply_vitals(&mut v, true, 0, 0, 0, 1_000_000);
        assert_eq!((v.health, v.tick_ms), (12, 1_000_000));
        // Below 18 food: no regeneration.
        let mut v = Vitals {
            health: 10,
            food: 17,
            ..full()
        };
        apply_vitals(&mut v, true, 0, 0, 0, 10_000);
        assert_eq!(v.health, 10);
        // Hunger off: regeneration is free.
        let mut v = Vitals {
            health: 10,
            ..full()
        };
        apply_vitals(&mut v, false, 0, 0, 0, 10_000);
        assert_eq!((v.health, v.exhaustion), (11, 0));
    }

    #[test]
    fn starvation_stops_at_one() {
        let mut v = Vitals {
            health: 2,
            food: 0,
            ..full()
        };
        apply_vitals(&mut v, true, 0, 0, 0, 4_000);
        assert_eq!(v.health, 1);
        apply_vitals(&mut v, true, 0, 0, 0, 8_000);
        assert_eq!(v.health, 1);
        // Damage can still kill a starving player.
        apply_vitals(&mut v, true, 1, 0, 0, 12_000);
        assert_eq!(v.health, 0);
    }

    #[test]
    fn vitals_are_total() {
        let mut v = Vitals {
            health: 255,
            food: 255,
            exhaustion: u16::MAX,
            tick_ms: i64::MIN,
        };
        apply_vitals(&mut v, true, u32::MAX - 1, u64::MAX, u64::MAX, i64::MAX);
        let mut v = Vitals {
            health: 255,
            food: 255,
            exhaustion: u16::MAX,
            tick_ms: i64::MAX,
        };
        apply_vitals(&mut v, true, 0, u64::MAX, u64::MAX, i64::MIN);
        assert!(v.exhaustion < EXHAUSTION_PER_FOOD as u16);
    }

    #[test]
    fn required_slots_cover_both_footprints() {
        let c = |b: i32| b * 256 + 128; // block center
                                        // In the middle of chunk (0,0): only slot 0.
        assert_eq!(
            required_slots([c(8), 0, c(8)], [c(9), 0, c(8)], 0, 0),
            [true, false, false, false]
        );
        // Crossing +x: both chunks of the row.
        assert_eq!(
            required_slots([c(15), 0, c(8)], [c(16), 0, c(8)], 0, 0),
            [true, true, false, false]
        );
        // Footprint of the previous position straddles the border (x = 16 blocks − 10 FP).
        assert_eq!(
            required_slots([4096 - 10, 0, c(8)], [c(24), 0, c(8)], 0, 0),
            [true, true, false, false]
        );
        // Diagonal corner crossing: the two other chunks are only touched by the sweep.
        assert_eq!(
            required_slots([c(15), 0, c(15)], [c(16), 0, c(16)], 0, 0),
            [true, false, false, true]
        );
        // Negative coordinates.
        assert_eq!(
            required_slots([c(-1), 0, c(-1)], [c(-1), 0, c(-1)], -1, -1),
            [true, false, false, false]
        );
        assert_eq!(
            required_slots([-10, 0, c(3)], [-10, 0, c(3)], -1, 0),
            [true, true, false, false]
        );
    }

    #[test]
    fn spawn_and_chunk_math() {
        assert_eq!(
            spawn_pos([3, 40, 15]),
            [3 * 256 + 128, 40 * 256, 15 * 256 + 128]
        );
        assert_eq!(chunk_of(0), 0);
        assert_eq!(chunk_of(4095), 0);
        assert_eq!(chunk_of(4096), 1);
        assert_eq!(chunk_of(-1), -1);
        assert_eq!(chunk_of(-4096), -1);
        assert_eq!(chunk_of(-4097), -2);
        assert_eq!(approx_dist([0, 0, 0], [300, 9, -400]), 400 + 150);
    }
}
