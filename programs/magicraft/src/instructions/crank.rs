//! Cranked instructions: the day crank (`schedule_day_crank` → `tick_day`) and the chunk
//! tick crank (`arm_chunk` / [`maybe_arm_chunk`] → `tick_chunk`).
//!
//! The day crank's authority is the **World PDA** (signs with its stored seeds), so arming
//! needs no Player and anyone can (re)arm it: same id + same authority replaces the task.
//!
//! # Chunk tick crank
//! **Authority** = the Chunk PDA (seeds `["chunk", world, cx, cz, bump]`), task id
//! `sha256("tick" ‖ chunk ‖ task_epoch)` (`scheduler::task_id`, stored in the header).
//! Same authority + id replaces, so every arm is idempotent in task count. A **writable**
//! arm that finds the crank armed but stale ([`prepare_arm`]) cancels the old id and moves
//! to the next epoch, abandoning an id a foreign task may have squatted (residual risk: all
//! 256 epochs squatted; re-check with Hydra, Task 28). Read-only arms (`move_player`) keep
//! the epoch.
//!
//! **Untrusted lists:** `tick_chunk` is callable by anyone, so nothing it schedules is built
//! from the passed accounts: renewals and repairs use [`derive_tick_ix`] (header bumps +
//! mask), existing neighbors' presences must be their canonical PDAs, and a list that
//! doesn't match triggers a repair re-arm at most once per `CRANK_STALE_MS`
//! (`ChunkHeader::repair_s`), otherwise a no-op. Arming a neighbor from inside a tick is
//! best effort (errors are logged, the tick continues).
//!
//! **Account list** ([`tick_ix`]): `[world (ro), chunk, presence, N, S, E, W chunks, N, S,
//! E, W presences, magic_program (ro)]`, all chunk/presence accounts writable. A **missing
//! neighbor is a placeholder**: the center chunk (and the center presence) again. The ER
//! rejects a tx that lists a non-existent account writable ("illegally used as writable",
//! checked after execution; tested), so derived PDAs of missing chunks can't be listed.
//! Which neighbors exist is `ChunkHeader::nbr_mask`, kept by `create_chunk` / `close_chunk`
//! (both take the 4 neighbor slots); they also **re-arm every armed neighbor** (its list
//! changed). The addresses are derived from bumps stored at `create_chunk`
//! (`presence_bump`, `nbr_bumps`): ≤ 9 `create_program_address`, no bump search. A tick
//! whose list doesn't match the mask (an arm that missed a change) is a no-op that re-arms
//! itself with the derived list.
//!
//! **Cadence:** interval = `min(fluid_tick_ms, mob_tick_ms)` ([`tick_interval_ms`]),
//! [`TICK_ITERATIONS`] executions per arm (≈ 60 s at the default 250 ms). A tick is
//! *accepted* only if at least half an interval of chain time passed since `last_tick_ms`
//! (`tick_chunk` is permissionless, so direct calls must not speed the world up); fluid
//! steps on every accepted tick when `fluid_tick_ms` is the interval, else when the fluid
//! period (`chain_ms / fluid_tick_ms`) advanced; mobs step when the **global** mob period
//! (`chain_ms / mob_tick_ms`, required by `core::mobs`) advanced, with `dt` = the number
//! of periods × `mob_tick_ms` (≤ 1 s). With the defaults (250 / 333) fluid runs every tick
//! and mobs on ~3 of 4 ticks.
//!
//! **Lifetime:** a tick is *idle* when the center has no fluid work, no mobs and no fresh
//! presence (center or neighbors): it sets `crank_armed = 0` and **cancels** its own task
//! (CPI from inside the cranked tx). A tick with fluid work or fresh presence **renews**
//! the task (same-id replace, iterations reset) every [`RENEW_AFTER`] accepted ticks, so
//! busy chunks never run out; a chunk with only mobs (animals, nobody near) runs out its
//! iterations (≤ 60 s) and stops. Fluid pushed into a neighbor's queue arms that neighbor
//! from inside the tick (same gate as below, neighbor PDA signs).
//!
//! **Watchdog** ([`maybe_arm_chunk`]): `move_player` (mover's chunk, read-only), block
//! edits (chunks whose fluid queue has work), `populate_chunk` (chunks with animals) and
//! the permissionless `arm_chunk` re-arm only when [`crank_stale`]: `crank_armed == 0`
//! (never armed, or idle-cancelled) or `last_tick_ms` older than `CRANK_STALE_MS` (3 s;
//! arms that can write the header set `last_tick_ms = now`, so "armed but never ticked"
//! goes stale 3 s after the arm). A replace restarts the timer and executes at once, so
//! ungated re-arms would let callers drive the tick rate (Task 16).
//!
//! **Never fails** on recoverable state: an inconsistent account list (wrong / duplicate
//! accounts, a bad neighbor presence) makes the tick a (throttled) repair or a no-op,
//! never an error (the scheduler drops a task after ~26 s of
//! failures). The only error is a center chunk that no longer exists (closed: its task
//! should have been cancelled; failing lets the scheduler drop it).

use core::cell::RefMut;

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::InstructionData;
use ephemeral_rollups_sdk::anchor::MagicProgram;
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
use magicraft_core::consts::CHUNK_VOL;
use magicraft_core::fluid::{self, ChunkNeighborhood, FluidQueue, FLUID_BUDGET};
use magicraft_core::hash::Seed;
use magicraft_core::mobs::{
    is_day, step_mob, try_spawn_zombie, Mob, MobCtx, Target, MAX_DT_MS, MAX_TARGETS, MOB_SLOTS,
};

use crate::auth::{chunk_seeds, presence_seeds, world_seeds};
use crate::errors::MagicraftError;
use crate::presence::STALE_MS as PRESENCE_STALE_MS;
use crate::scheduler;
use crate::state::{
    chunk_header, chunk_header_mut, chunk_parts_mut, presence_of, ChunkHeader, PresenceEntry,
    World, WorldParams, CRANK_STALE_MS,
};

/// Tag of the day crank's task id (`sha256("day" ‖ world)`).
pub const DAY_TASK_TAG: &[u8] = b"day";
/// `tick_day` cadence, ms.
pub const DAY_TICK_MS: i64 = 1_000;
/// Executions per arming (~136 years at 1 s); the watchdog re-arms long before.
pub const DAY_CRANK_ITERATIONS: i64 = u32::MAX as i64;

/// Schedules (or replaces) `tick_day(world)` every [`DAY_TICK_MS`] with the World PDA
/// (`world_ai`, whose stored fields are `world`) as task authority. Returns the task id.
pub fn arm_day_crank<'info>(world_ai: &AccountInfo<'info>, world: &World) -> Result<i64> {
    let task_id = scheduler::task_id(DAY_TASK_TAG, world_ai.key, world.day_epoch);
    let tick = Instruction {
        program_id: crate::ID,
        accounts: vec![AccountMeta::new(world_ai.key(), false)],
        data: crate::instruction::TickDay {}.data(),
    };
    let (nonce, bump) = (world.nonce.to_le_bytes(), [world.bump]);
    scheduler::schedule(
        world_ai,
        &world_seeds(&world.creator, &nonce, &bump),
        task_id,
        DAY_TICK_MS,
        DAY_CRANK_ITERATIONS,
        tick,
    )?;
    Ok(task_id)
}

// ---------- schedule_day_crank (ER, permissionless) ----------

#[derive(Accounts)]
pub struct ScheduleDayCrank<'info> {
    /// Task authority (signs the Magic-program CPI with its PDA seeds). Writable: a re-arm
    /// rotates the task id epoch (only when stale, so the write lock is rare).
    #[account(mut)]
    pub world: Account<'info, World>,
    pub magic_program: Program<'info, MagicProgram>,
}

/// Re-arms the World's day crank **only if it looks stalled**
/// ([`World::day_crank_stale`]); otherwise a no-op. `create_world` arms it; clients send
/// this when they see `last_tick_ms` stale (e.g. the scheduler dropped the task, or its id
/// was squatted). A stale re-arm cancels the old task and schedules under the next
/// `day_epoch` (a new task id, see `scheduler::task_id`), so a squatted id is abandoned
/// and a merely slow task is not duplicated.
pub fn schedule_day_crank(ctx: Context<ScheduleDayCrank>) -> Result<()> {
    let now = ctx.accounts.world.chain_ms_ro(&Clock::get()?).ms;
    if !ctx.accounts.world.day_crank_stale(now) {
        msg!("day crank alive; not re-armed");
        return Ok(());
    }
    let world_ai = ctx.accounts.world.to_account_info();
    let world = &mut ctx.accounts.world;
    if world.day_task_id != 0 {
        let (nonce, bump) = (world.nonce.to_le_bytes(), [world.bump]);
        scheduler::cancel(
            &world_ai,
            &world_seeds(&world.creator, &nonce, &bump),
            world.day_task_id,
        )?;
        world.day_epoch = world.day_epoch.wrapping_add(1);
    }
    world.day_task_id = arm_day_crank(&world_ai, world)?;
    Ok(())
}

// ---------- tick_day (crank target, permissionless) ----------

#[derive(Accounts)]
pub struct TickDay<'info> {
    /// No signer: cranked txs are signed by the validator; any World is fine to tick
    /// (owner + discriminator checked by `Account`).
    #[account(mut)]
    pub world: Account<'info, World>,
}

/// [`World::tick`]: re-anchors the chain clock and advances `time_of_day_ms` (liveness
/// only while the seed is pending). Never fails on world state (a failing crank is
/// dropped by the scheduler after ~26 s).
pub fn tick_day(ctx: Context<TickDay>) -> Result<()> {
    let clock = Clock::get()?;
    ctx.accounts.world.tick(&clock);
    Ok(())
}

// ---------- chunk tick crank (Task 20) ----------

/// Tag of the chunk tick crank's task id (`sha256("tick" ‖ chunk)`).
pub const TICK_TASK_TAG: &[u8] = b"tick";
/// Executions per arm (≈ 60 s at 250 ms); busy chunks renew before running out.
pub const TICK_ITERATIONS: i64 = 240;
/// A busy chunk renews its task after this many accepted ticks since the last arm
/// (< [`TICK_ITERATIONS`] with room for gated no-op executions).
pub const RENEW_AFTER: u8 = 160;
/// Neighbor offsets `(dcx, dcz)` in fluid slot order N, S, E, W (slot `i + 1`).
pub const NBR_OFF: [(i32, i32); 4] = [(0, -1), (0, 1), (1, 0), (-1, 0)];

/// Tick crank interval, ms: `min(fluid_tick_ms, mob_tick_ms)` (both ≥ 100 by validation).
pub fn tick_interval_ms(p: &WorldParams) -> i64 {
    p.fluid_tick_ms.min(p.mob_tick_ms).max(1) as i64
}

/// The watchdog gate (module docs): never armed / idle-cancelled, or no tick (or arm) for
/// more than `CRANK_STALE_MS`.
pub fn crank_stale(h: &ChunkHeader, now_ms: i64) -> bool {
    h.crank_armed == 0 || now_ms.saturating_sub(h.last_tick_ms.get()) > CRANK_STALE_MS
}

/// Records an arm in a writable header (`last_tick_ms = now` makes "armed but never
/// ticked" go stale 3 s later; `arm_tick` starts the renewal count).
pub fn mark_armed(h: &mut ChunkHeader, now_ms: i64) {
    h.crank_armed = 1;
    h.last_tick_ms.set(now_ms);
    h.arm_tick = h.tick_count.get() as u8;
}

/// A writable arm of chunk `key`: if the crank was believed armed but is stale (dropped,
/// or its id squatted by a foreign task), rotates `task_epoch` / `task_id` and returns the
/// old id (the caller cancels it, so a merely slow task is not duplicated); then
/// [`mark_armed`].
pub fn prepare_arm(h: &mut ChunkHeader, key: &Pubkey, now_ms: i64) -> Option<i64> {
    let old = (h.crank_armed == 1 && crank_stale(h, now_ms)).then(|| {
        let old = h.task_id.get();
        h.task_epoch = h.task_epoch.wrapping_add(1);
        h.task_id
            .set(scheduler::task_id(TICK_TASK_TAG, key, h.task_epoch));
        old
    });
    mark_armed(h, now_ms);
    old
}

/// Cancels task `id` of `chunk_ai` (the Chunk PDA signs).
pub fn cancel_tick<'info>(chunk_ai: &AccountInfo<'info>, k: &CrankKeys, id: i64) -> Result<()> {
    let (cxb, czb, b) = (k.cx.to_le_bytes(), k.cz.to_le_bytes(), [k.bump]);
    scheduler::cancel(chunk_ai, &chunk_seeds(&k.world, &cxb, &czb, &b), id)
}

/// What is needed to rebuild a chunk's tick task (copied out of its header).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CrankKeys {
    pub world: Pubkey,
    pub cx: i32,
    pub cz: i32,
    pub bump: u8,
    pub presence_bump: u8,
    pub nbr_bumps: [u8; 8],
    pub nbr_mask: u8,
    /// The current task id epoch (`ChunkHeader::task_epoch`) and the stored id.
    pub epoch: u8,
    pub task_id: i64,
}

impl CrankKeys {
    pub fn of(h: &ChunkHeader) -> Self {
        CrankKeys {
            world: h.world,
            cx: h.cx.get(),
            cz: h.cz.get(),
            bump: h.bump,
            presence_bump: h.presence_bump,
            nbr_bumps: h.nbr_bumps,
            nbr_mask: h.nbr_mask,
            epoch: h.task_epoch,
            task_id: h.task_id.get(),
        }
    }

    /// Neighbor `i` exists (per the mask).
    pub fn has(&self, i: usize) -> bool {
        self.nbr_mask & (1 << i) != 0
    }

    /// Coordinates of neighbor `i` (N, S, E, W).
    pub fn nbr(&self, i: usize) -> (i32, i32) {
        let (dx, dz) = NBR_OFF[i];
        (self.cx.wrapping_add(dx), self.cz.wrapping_add(dz))
    }
}

/// Chunk PDA `(cx, cz)` of `world` from a known bump.
pub fn chunk_key(world: &Pubkey, cx: i32, cz: i32, bump: u8) -> Result<Pubkey> {
    let (cxb, czb, b) = (cx.to_le_bytes(), cz.to_le_bytes(), [bump]);
    Pubkey::create_program_address(&chunk_seeds(world, &cxb, &czb, &b), &crate::ID)
        .map_err(|_| error!(MagicraftError::InvalidChunk))
}

/// Presence PDA of `chunk` from a known bump.
pub fn presence_key(chunk: &Pubkey, bump: u8) -> Result<Pubkey> {
    Pubkey::create_program_address(&presence_seeds(chunk, &[bump]), &crate::ID)
        .map_err(|_| error!(MagicraftError::InvalidPresence))
}

/// The `tick_chunk` instruction with the fixed account list (module docs).
pub fn tick_ix(
    world: &Pubkey,
    chunk: &Pubkey,
    presence: &Pubkey,
    nbrs: &[Pubkey; 4],
    nbr_presences: &[Pubkey; 4],
) -> Instruction {
    let mut accounts = Vec::with_capacity(12);
    accounts.push(AccountMeta::new_readonly(*world, false));
    accounts.push(AccountMeta::new(*chunk, false));
    accounts.push(AccountMeta::new(*presence, false));
    for k in nbrs.iter().chain(nbr_presences.iter()) {
        accounts.push(AccountMeta::new(*k, false));
    }
    accounts.push(AccountMeta::new_readonly(MAGIC_PROGRAM_ID, false));
    Instruction {
        program_id: crate::ID,
        accounts,
        data: crate::instruction::TickChunk {}.data(),
    }
}

/// [`tick_ix`] for `chunk`: existing neighbors (per `nbr_mask`) derived from the stored
/// bumps, missing ones as placeholders (the center chunk / presence).
pub fn derive_tick_ix(chunk: &Pubkey, k: &CrankKeys) -> Result<Instruction> {
    let presence = presence_key(chunk, k.presence_bump)?;
    let mut nbrs = [*chunk; 4];
    let mut pres = [presence; 4];
    for i in 0..4 {
        if k.has(i) {
            let (ncx, ncz) = k.nbr(i);
            nbrs[i] = chunk_key(&k.world, ncx, ncz, k.nbr_bumps[i])?;
            pres[i] = presence_key(&nbrs[i], k.nbr_bumps[4 + i])?;
        }
    }
    Ok(tick_ix(&k.world, chunk, &presence, &nbrs, &pres))
}

/// Schedules (or replaces) `chunk_ai`'s tick task running `ix`, the Chunk PDA signing.
pub fn schedule_tick<'info>(
    chunk_ai: &AccountInfo<'info>,
    k: &CrankKeys,
    interval_ms: i64,
    ix: Instruction,
) -> Result<()> {
    let (cxb, czb, b) = (k.cx.to_le_bytes(), k.cz.to_le_bytes(), [k.bump]);
    scheduler::schedule(
        chunk_ai,
        &chunk_seeds(&k.world, &cxb, &czb, &b),
        scheduler::task_id(TICK_TASK_TAG, chunk_ai.key, k.epoch),
        interval_ms,
        TICK_ITERATIONS,
        ix,
    )
}

/// Watchdog / arm helper (module docs). The caller has established that the chunk has
/// work (a mover is present, its fluid queue has work, it has animals). `chunk_ai` may be
/// read-only (`move_player`); if writable, the arm is recorded in the header
/// ([`mark_armed`]). No-op unless the chunk is a ready chunk of `world` and
/// [`crank_stale`]. Returns whether it armed. **Call after all borrows of the chunk are
/// released.** The tx must contain the Magic program.
pub fn maybe_arm_chunk<'info>(
    chunk_ai: &AccountInfo<'info>,
    world: &Account<'info, World>,
    now_ms: i64,
) -> Result<bool> {
    let k = {
        let h = chunk_header(chunk_ai)?;
        require_keys_eq!(h.world, world.key(), MagicraftError::InvalidChunk);
        if !h.is_done() || !crank_stale(&h, now_ms) {
            return Ok(false);
        }
        CrankKeys::of(&h)
    };
    let (k, old) = if chunk_ai.is_writable {
        let mut h = chunk_header_mut(chunk_ai)?;
        let old = prepare_arm(&mut h, chunk_ai.key, now_ms);
        (CrankKeys::of(&h), old)
    } else {
        // Read-only (`move_player`): no epoch rotation; the writable watchdogs
        // (`arm_chunk`, edits, neighbor changes) rotate a squatted id.
        (k, None)
    };
    if let Some(old) = old {
        cancel_tick(chunk_ai, &k, old)?;
    }
    let ix = derive_tick_ix(chunk_ai.key, &k)?;
    schedule_tick(chunk_ai, &k, tick_interval_ms(&world.params), ix)?;
    msg!("tick crank armed");
    Ok(true)
}

// ---------- arm_chunk (ER, permissionless) ----------

#[derive(Accounts)]
pub struct ArmChunk<'info> {
    /// Read-only: chain time, tick interval.
    pub world: Account<'info, World>,
    /// CHECK: a chunk of `world` (owner, discriminator, stored world); task authority
    /// (signs with its seeds). Writable: a stale re-arm rotates the task id epoch.
    #[account(mut)]
    pub chunk: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

/// Client-side watchdog (e.g. water flowing where nobody moves): re-arms the chunk's tick
/// crank if it has fluid work or mobs **and** [`crank_stale`]; otherwise a no-op.
pub fn arm_chunk(ctx: Context<ArmChunk>) -> Result<()> {
    let world = &ctx.accounts.world;
    let chunk_ai = ctx.accounts.chunk.to_account_info();
    let work = {
        let h = chunk_header(&chunk_ai)?;
        h.fluid_has_work() || h.has_mobs()
    };
    let now = world.chain_ms_ro(&Clock::get()?).ms;
    if !work || !maybe_arm_chunk(&chunk_ai, world, now)? {
        msg!("tick crank not re-armed (no work or alive)");
    }
    Ok(())
}

// ---------- debug_cancel_tick (localnet builds only) ----------

#[cfg(feature = "localnet")]
#[derive(Accounts)]
pub struct DebugCancelTick<'info> {
    pub world: Account<'info, World>,
    /// CHECK: a chunk of `world`; signs the cancel with its seeds.
    pub chunk: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

/// **Test hook, compiled into `localnet` builds only**: cancels the chunk's tick task
/// without touching its header, simulating a task the scheduler dropped (the watchdog
/// test).
#[cfg(feature = "localnet")]
pub fn debug_cancel_tick(ctx: Context<DebugCancelTick>) -> Result<()> {
    let chunk_ai = ctx.accounts.chunk.to_account_info();
    let k = {
        let h = chunk_header(&chunk_ai)?;
        require_keys_eq!(
            h.world,
            ctx.accounts.world.key(),
            MagicraftError::InvalidChunk
        );
        CrankKeys::of(&h)
    };
    cancel_tick(&chunk_ai, &k, k.task_id)
}

// ---------- tick_chunk (crank target, permissionless) ----------

#[derive(Accounts)]
pub struct TickChunk<'info> {
    /// Read-only: chain time, params, seed, time of day.
    pub world: Account<'info, World>,
    /// CHECK: the ticked chunk (owner, discriminator, stored world); see the module docs.
    #[account(mut)]
    pub chunk: UncheckedAccount<'info>,
    /// CHECK: its presence list (stored chunk).
    #[account(mut)]
    pub presence: UncheckedAccount<'info>,
    /// CHECK: neighbor `(cx, cz − 1)` (stored identity, or empty at its PDA).
    #[account(mut)]
    pub chunk_n: UncheckedAccount<'info>,
    /// CHECK: neighbor `(cx, cz + 1)`.
    #[account(mut)]
    pub chunk_s: UncheckedAccount<'info>,
    /// CHECK: neighbor `(cx + 1, cz)`.
    #[account(mut)]
    pub chunk_e: UncheckedAccount<'info>,
    /// CHECK: neighbor `(cx − 1, cz)`.
    #[account(mut)]
    pub chunk_w: UncheckedAccount<'info>,
    /// CHECK: presence of `chunk_n` (checked only if that chunk is ready).
    #[account(mut)]
    pub presence_n: UncheckedAccount<'info>,
    /// CHECK: presence of `chunk_s`.
    #[account(mut)]
    pub presence_s: UncheckedAccount<'info>,
    /// CHECK: presence of `chunk_e`.
    #[account(mut)]
    pub presence_e: UncheckedAccount<'info>,
    /// CHECK: presence of `chunk_w`.
    #[account(mut)]
    pub presence_w: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

/// What an accepted tick asks the handler to do once all borrows are released.
struct TickOut {
    keys: CrankKeys,
    /// The passed list doesn't match `nbr_mask`: nothing ran; re-arm with the derived list.
    repair: bool,
    idle: bool,
    renew: bool,
    /// Neighbors (N, S, E, W) to arm: their keys and an old (rotated) task id to cancel.
    arm: [Option<(CrankKeys, Option<i64>)>; 4],
}

/// One crank tick (module docs). Never fails except when the center chunk is gone.
pub fn tick_chunk(ctx: Context<TickChunk>) -> Result<()> {
    let a = &ctx.accounts;
    let chunk_ai = a.chunk.to_account_info();
    require!(
        *chunk_ai.owner == crate::ID && !chunk_ai.data_is_empty(),
        MagicraftError::InvalidChunk
    );
    let now = a.world.chain_ms_ro(&Clock::get()?).ms;
    let nbr = [
        a.chunk_n.to_account_info(),
        a.chunk_s.to_account_info(),
        a.chunk_e.to_account_info(),
        a.chunk_w.to_account_info(),
    ];
    let pres = [
        a.presence_n.to_account_info(),
        a.presence_s.to_account_info(),
        a.presence_e.to_account_info(),
        a.presence_w.to_account_info(),
    ];
    let presence_ai = a.presence.to_account_info();
    let Some(out) = run_tick(&a.world, &chunk_ai, &presence_ai, &nbr, &pres, now) else {
        return Ok(());
    };

    // Scheduler CPIs, after every borrow is released.
    let interval = tick_interval_ms(&a.world.params);
    let k = &out.keys;
    if out.repair {
        schedule_tick(&chunk_ai, k, interval, derive_tick_ix(chunk_ai.key, k)?)?;
        msg!("tick: account list outdated, crank re-armed");
        return Ok(());
    }
    if out.idle {
        cancel_tick(&chunk_ai, k, k.task_id)?;
        msg!("tick: idle, crank cancelled");
    } else if out.renew {
        // The canonical list (derived from the header), never the passed accounts.
        schedule_tick(&chunk_ai, k, interval, derive_tick_ix(chunk_ai.key, k)?)?;
        msg!("tick: crank renewed");
    }
    for (i, arm) in out.arm.iter().enumerate() {
        if let Some((nk, old)) = arm {
            // Best effort: a neighbor that can't be armed must not fail this tick (its
            // watchdogs re-arm it). Errors returned to us are logged; a failure inside the
            // Magic program itself would still abort the tx (Solana CPI semantics).
            let r = (|| -> Result<()> {
                if let Some(old) = old {
                    cancel_tick(&nbr[i], nk, *old)?;
                }
                schedule_tick(&nbr[i], nk, interval, derive_tick_ix(nbr[i].key, nk)?)
            })();
            match r {
                Ok(()) => msg!("tick: armed neighbor {}", i),
                Err(e) => msg!("tick: arming neighbor {} failed: {:?}", i, e),
            }
        }
    }
    Ok(())
}

/// `period(t, len)` = `t / len` for the cadence checks (unsigned: signed `i64` division is
/// a ~200 CU software routine on SBF).
#[inline]
fn period(t_ms: i64, len_ms: u32) -> u64 {
    t_ms.max(0) as u64 / len_ms.max(1) as u64
}

/// Neighbor slot `i` against the mask: `Some(Some(parts))` = an existing, ready chunk,
/// `Some(None)` = missing (placeholder) or not generated yet, `None` = the slot doesn't
/// match the mask (outdated list or a bogus direct call).
#[allow(clippy::type_complexity)]
fn neighbor<'a>(
    ai: &'a AccountInfo,
    center: &Pubkey,
    k: &CrankKeys,
    i: usize,
) -> Option<Option<(RefMut<'a, ChunkHeader>, RefMut<'a, [u8; CHUNK_VOL]>)>> {
    let placeholder = ai.key == center;
    if !k.has(i) {
        return placeholder.then_some(None);
    }
    if placeholder || *ai.owner != crate::ID {
        return None;
    }
    let (ncx, ncz) = k.nbr(i);
    let ready = {
        let h = chunk_header(ai).ok()?;
        if h.world != k.world || h.cx.get() != ncx || h.cz.get() != ncz {
            return None;
        }
        h.is_done()
    };
    if !ready {
        return Some(None);
    }
    let (h, b) = chunk_parts_mut(ai).ok()?;
    Some(Some((h, b)))
}

/// The accepted-tick body; `None` = no-op (gated, or an inconsistent account list).
fn run_tick(
    world: &Account<World>,
    chunk: &AccountInfo,
    presence: &AccountInfo,
    nbr: &[AccountInfo; 4],
    pres: &[AccountInfo; 4],
    now: i64,
) -> Option<TickOut> {
    // Distinct accounts only, apart from the placeholders (center chunk / presence in a
    // neighbor slot), so the mutable borrows below never alias.
    let all = [
        chunk.key,
        presence.key,
        nbr[0].key,
        nbr[1].key,
        nbr[2].key,
        nbr[3].key,
        pres[0].key,
        pres[1].key,
        pres[2].key,
        pres[3].key,
    ];
    let mut keys = [chunk.key; 10];
    let mut n = 0;
    for (j, &k) in all.iter().enumerate() {
        if j >= 2 && (k == chunk.key || k == presence.key) {
            continue;
        }
        if keys[..n].contains(&k) {
            return None;
        }
        keys[n] = k;
        n += 1;
    }

    let world_key = world.key();
    let p = &world.params;
    let (mut ch, mut cb) = chunk_parts_mut(chunk).ok()?;
    if ch.world != world_key || !ch.is_done() {
        return None;
    }
    let interval = tick_interval_ms(p);
    let last = ch.last_tick_ms.get();
    let since = now.saturating_sub(last);
    if (0..interval / 2).contains(&since) {
        return None; // too early (a direct call, or the immediate run after an arm)
    }
    let keys = CrankKeys::of(&ch);
    let (cx, cz) = (keys.cx, keys.cz);
    // The passed list doesn't match the header: re-arm with the canonical list, at most
    // once per CRANK_STALE_MS (chain-seconds stamp), else a plain no-op.
    let mut repair = || {
        let now_s = (now.max(0) as u64 / 1000) as u16;
        if now_s.wrapping_sub(ch.repair_s.get()) < (CRANK_STALE_MS / 1000) as u16 {
            return None;
        }
        ch.repair_s.set(now_s);
        Some(TickOut {
            keys,
            repair: true,
            idle: false,
            renew: false,
            arm: [None; 4],
        })
    };

    // Neighbors and presence lists (checked against `nbr_mask`).
    let mut heads: [Option<RefMut<ChunkHeader>>; 4] = [None, None, None, None];
    let mut blocks: [Option<RefMut<[u8; CHUNK_VOL]>>; 4] = [None, None, None, None];
    let mut lists: [Option<RefMut<[PresenceEntry]>>; 5] = [None, None, None, None, None];
    lists[0] = Some(presence_of(presence, chunk.key).ok()?.1);
    for i in 0..4 {
        let Some(slot) = neighbor(&nbr[i], chunk.key, &keys, i) else {
            return repair();
        };
        let pres_ok = if keys.has(i) {
            // The neighbor's canonical presence PDA (stored bump), not just any list
            // whose stored `chunk` matches.
            presence_key(nbr[i].key, keys.nbr_bumps[4 + i]).is_ok_and(|k| k == *pres[i].key)
        } else {
            pres[i].key == presence.key
        };
        if !pres_ok {
            return repair();
        }
        if let Some((h, b)) = slot {
            let Ok((_, list)) = presence_of(&pres[i], nbr[i].key) else {
                return repair();
            };
            lists[i + 1] = Some(list);
            heads[i] = Some(h);
            blocks[i] = Some(b);
        }
    }

    // Fresh presence entries = mob targets (first MAX_TARGETS).
    let mut targets: Vec<Target> = Vec::with_capacity(MAX_TARGETS);
    'scan: for (slot, list) in lists.iter().enumerate() {
        if let Some(list) = list {
            for (idx, e) in list.iter().enumerate() {
                if targets.len() >= MAX_TARGETS {
                    break 'scan;
                }
                if now.saturating_sub(e.last_seen_ms.get()) <= PRESENCE_STALE_MS {
                    targets.push(Target {
                        pos: e.pos.map(|v| v.get()),
                        idx: idx as u16,
                        chunk: slot as u8,
                    });
                }
            }
        }
    }

    let [bn, bs, be, bw] = &mut blocks;
    let mut hood = ChunkNeighborhood::new(
        cx,
        cz,
        &mut cb,
        [
            bn.as_deref_mut(),
            bs.as_deref_mut(),
            be.as_deref_mut(),
            bw.as_deref_mut(),
        ],
    );

    // Fluid.
    let mut arm: [Option<(CrankKeys, Option<i64>)>; 4] = [None; 4];
    let fluid_due = p.fluid_tick_ms as i64 == interval
        || period(now, p.fluid_tick_ms) > period(last, p.fluid_tick_ms);
    if fluid_due && ch.fluid_has_work() {
        let mut qs = Box::new([FluidQueue::new(); 5]);
        qs[0] = ch.fluid_queue();
        for (i, h) in heads.iter().enumerate() {
            if let Some(h) = h {
                qs[i + 1] = h.fluid_queue();
            }
        }
        let r = {
            let [q0, q1, q2, q3, q4] = &mut *qs;
            let mut queues = [
                Some(q0),
                heads[0].is_some().then_some(q1),
                heads[1].is_some().then_some(q2),
                heads[2].is_some().then_some(q3),
                heads[3].is_some().then_some(q4),
            ];
            fluid::step(&mut hood, &mut queues, FLUID_BUDGET)
        };
        ch.set_fluid_queue(&qs[0]);
        for (i, h) in heads.iter_mut().enumerate() {
            if let Some(h) = h {
                if r.touched_neighbors & (1 << (i + 1)) != 0 {
                    h.set_fluid_queue(&qs[i + 1]);
                    if h.fluid_has_work() && crank_stale(h, now) {
                        let old = prepare_arm(h, nbr[i].key, now);
                        arm[i] = Some((CrankKeys::of(h), old));
                    }
                }
            }
        }
    }

    // Mobs (global mob period) and zombie spawning.
    let mob_ms = p.mob_tick_ms.max(1);
    let (tick, last_tick) = (period(now, mob_ms), period(last, mob_ms));
    if tick > last_tick {
        let seed = Seed::new(&world.seed);
        let day = is_day(world.time_of_day_ms, p.day_length_secs as u64 * 1000);
        let dt = if last == 0 {
            mob_ms.min(MAX_DT_MS)
        } else {
            ((tick - last_tick).min(MAX_DT_MS as u64) as u32)
                .saturating_mul(mob_ms)
                .min(MAX_DT_MS)
        };
        for i in 0..MOB_SLOTS {
            let mut m = ch.mob(i);
            if m.is_empty() {
                continue;
            }
            let mut enter_mask = 0u8;
            for (j, h) in heads.iter().enumerate() {
                if h.as_ref().is_some_and(|h| h.free_mob_slot().is_some()) {
                    enter_mask |= 1 << (j + 1);
                }
            }
            let ctx = MobCtx {
                seed: &seed,
                tick,
                cx,
                cz,
                targets: &targets,
                is_day: day,
                dt_ms: dt,
                enter_mask,
            };
            let ev = step_mob(&ctx, &mut m, &hood);
            if let Some(hit) = ev.hit {
                if let Some(Some(list)) = lists.get_mut(hit.chunk as usize) {
                    if let Some(e) = list.get_mut(hit.idx as usize) {
                        e.pending_damage = e.pending_damage.saturating_add(hit.dmg);
                    }
                }
            }
            let to = match ev.cross {
                (0, -1) => Some(0),
                (0, 1) => Some(1),
                (1, 0) => Some(2),
                (-1, 0) => Some(3),
                _ => None,
            };
            if let Some(Some(h)) = to.map(|j| &mut heads[j]) {
                if let Some(slot) = h.free_mob_slot() {
                    h.set_mob(slot, &m);
                    ch.set_mob(i, &Mob::EMPTY);
                    continue;
                }
            }
            ch.set_mob(i, &m);
        }
        let cap = p.zombie_cap_per_chunk;
        if cap > 0 && !targets.is_empty() {
            if let Some(slot) = ch.free_mob_slot() {
                let mobs: [Mob; MOB_SLOTS] = core::array::from_fn(|i| ch.mob(i));
                if let Some(z) =
                    try_spawn_zombie(&seed, tick, cx, cz, &hood, &targets, &mobs, !day, cap)
                {
                    ch.set_mob(slot, &z);
                    msg!("tick: zombie spawned");
                }
            }
        }
    }

    // Idle / renewal bookkeeping.
    let fluid_work = ch.fluid_has_work();
    let fresh = !targets.is_empty();
    let idle = !fluid_work && !fresh && !ch.has_mobs();
    let mut renew = false;
    ch.last_tick_ms.set(now);
    if idle {
        ch.crank_armed = 0;
    } else {
        ch.crank_armed = 1;
        let n = ch.tick_count.get().wrapping_add(1);
        ch.tick_count.set(n);
        if (fluid_work || fresh) && (n as u8).wrapping_sub(ch.arm_tick) >= RENEW_AFTER {
            ch.arm_tick = n as u8;
            renew = true;
        }
    }
    Some(TickOut {
        keys,
        repair: false,
        idle,
        renew,
        arm,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presence::new_entry;
    use crate::state::{
        init_chunk_header, init_presence_header, presence_len, TimeAnchor, CHUNK_BLOCKS_OFFSET,
        CHUNK_FULL_LEN, GEN_DONE, PRESENCE_ENTRY_SIZE, PRESENCE_HEADER_SIZE,
    };
    use anchor_lang::Discriminator;
    use magicraft_core::fluid::{EAST, NORTH, WEST};
    use magicraft_core::mobs::{KIND_PIG, KIND_ZOMBIE};
    use magicraft_core::physics as phys;

    const NOW: i64 = 1_000_000;
    const FLOOR: usize = 10; // stone below y = 10
    const B: i32 = 256;

    struct Acc {
        key: Pubkey,
        owner: Pubkey,
        lamports: u64,
        data: Vec<u8>,
    }

    impl Acc {
        fn info(&mut self) -> AccountInfo<'_> {
            AccountInfo::new(
                &self.key,
                false,
                true,
                &mut self.lamports,
                &mut self.data,
                &self.owner,
                false,
            )
        }
    }

    fn world_acc() -> Acc {
        let mut params: WorldParams = phys::WorldParams::default().into();
        params.zombie_cap_per_chunk = 0;
        let w = World {
            creator: Pubkey::new_unique(),
            nonce: 1,
            bump: 255,
            name: [0; 32],
            params,
            seed: [7; 32],
            seed_set: true,
            spawn: [0; 3],
            spawn_set: true,
            time_of_day_ms: 0,
            day_task_id: 1,
            last_tick_ms: NOW,
            chunk_count: 5,
            clock: TimeAnchor::default(),
            day_ticks: 0,
            day_epoch: 0,
            _reserved: [0; 17],
        };
        let mut data = World::DISCRIMINATOR.to_vec();
        w.serialize(&mut data).unwrap();
        Acc {
            key: Pubkey::new_unique(),
            owner: crate::ID,
            lamports: 1,
            data,
        }
    }

    /// A ready chunk `(cx, cz)` of `world` at its PDA, with real stored bumps and a stone
    /// floor (feet at y = 10).
    fn chunk_acc(world: &Pubkey, cx: i32, cz: i32, mask: u8) -> Acc {
        let (key, bump) = Pubkey::find_program_address(
            &[
                crate::state::CHUNK_SEED,
                world.as_ref(),
                &cx.to_le_bytes(),
                &cz.to_le_bytes(),
            ],
            &crate::ID,
        );
        let pb =
            Pubkey::find_program_address(&[crate::state::PRESENCE_SEED, key.as_ref()], &crate::ID)
                .1;
        let mut data = vec![0u8; CHUNK_FULL_LEN];
        {
            let h =
                init_chunk_header(&mut data, Pubkey::new_unique(), *world, cx, cz, bump).unwrap();
            h.gen_stage = GEN_DONE;
            h.nbr_mask = mask;
            h.presence_bump = pb;
            h.nbr_bumps = crate::instructions::chunk::neighbor_pdas(world, cx, cz).1;
            h.task_id.set(scheduler::task_id(TICK_TASK_TAG, &key, 0));
        }
        data[CHUNK_BLOCKS_OFFSET..CHUNK_BLOCKS_OFFSET + FLOOR * 256].fill(3);
        Acc {
            key,
            owner: crate::ID,
            lamports: 1,
            data,
        }
    }

    /// The presence list of `chunk` at its PDA.
    fn presence_acc(chunk: &Pubkey, entries: &[([i32; 3], i64)]) -> Acc {
        let mut a = presence_at(chunk, entries);
        a.key = Pubkey::find_program_address(
            &[crate::state::PRESENCE_SEED, chunk.as_ref()],
            &crate::ID,
        )
        .0;
        a
    }

    /// A presence list of `chunk` at a random address (not its PDA).
    fn presence_at(chunk: &Pubkey, entries: &[([i32; 3], i64)]) -> Acc {
        let mut data = vec![0u8; presence_len(entries.len())];
        init_presence_header(&mut data, *chunk, 255).unwrap();
        data[42..44].copy_from_slice(&(entries.len() as u16).to_le_bytes());
        for (i, &(pos, seen)) in entries.iter().enumerate() {
            let o = PRESENCE_HEADER_SIZE + i * PRESENCE_ENTRY_SIZE;
            let e = new_entry(&Pubkey::new_unique(), pos, seen);
            data[o..o + PRESENCE_ENTRY_SIZE].copy_from_slice(bytemuck::bytes_of(&e));
        }
        Acc {
            key: Pubkey::new_unique(),
            owner: crate::ID,
            lamports: 1,
            data,
        }
    }

    fn header(a: &Acc) -> ChunkHeader {
        *bytemuck::from_bytes(&a.data[..core::mem::size_of::<ChunkHeader>()])
    }

    fn set_mob(a: &mut Acc, i: usize, m: &Mob) {
        let h: &mut ChunkHeader =
            bytemuck::from_bytes_mut(&mut a.data[..core::mem::size_of::<ChunkHeader>()]);
        h.set_mob(i, m);
    }

    fn mob(kind: u8, pos: [i32; 3], dir: u8) -> Mob {
        Mob {
            kind,
            hp: magicraft_core::mobs::max_hp(kind),
            dir,
            pos,
            id: 42,
            ..Mob::EMPTY
        }
    }

    /// Runs one tick of `c` (presence `p`) with the given neighbor slots; `None` slots
    /// are placeholders.
    fn tick(
        w: &mut Acc,
        c: &mut Acc,
        p: &mut Acc,
        nbr: [Option<(&mut Acc, &mut Acc)>; 4],
        now: i64,
    ) -> Option<(bool, bool, bool)> {
        let wi = w.info();
        let world = Account::<World>::try_from(&wi).unwrap();
        let ci = c.info();
        let pi = p.info();
        let mut ns: Vec<AccountInfo> = Vec::new();
        let mut ps: Vec<AccountInfo> = Vec::new();
        for s in nbr {
            match s {
                Some((nc, np)) => {
                    ns.push(nc.info());
                    ps.push(np.info());
                }
                None => {
                    ns.push(ci.clone());
                    ps.push(pi.clone());
                }
            }
        }
        let ns: [AccountInfo; 4] = ns.try_into().unwrap();
        let ps: [AccountInfo; 4] = ps.try_into().unwrap();
        run_tick(&world, &ci, &pi, &ns, &ps, now).map(|o| (o.repair, o.idle, o.renew))
    }

    #[test]
    fn idle_chunk_cancels_and_gate_limits_direct_calls() {
        let mut w = world_acc();
        let mut c = chunk_acc(&w.key, 0, 0, 0);
        let mut p = presence_acc(&c.key, &[]);
        assert_eq!(
            tick(&mut w, &mut c, &mut p, [None, None, None, None], NOW),
            Some((false, true, false))
        );
        let h = header(&c);
        assert_eq!((h.crank_armed, h.last_tick_ms.get()), (0, NOW));
        // Within half an interval of the last tick: no-op.
        assert_eq!(
            tick(&mut w, &mut c, &mut p, [None, None, None, None], NOW + 100),
            None
        );
    }

    #[test]
    fn fresh_presence_keeps_ticking_and_counts() {
        let mut w = world_acc();
        let mut c = chunk_acc(&w.key, 0, 0, 0);
        let mut p = presence_acc(&c.key, &[([8 * B, 10 * B, 8 * B], NOW - 1_000)]);
        for k in 0..3 {
            let r = tick(
                &mut w,
                &mut c,
                &mut p,
                [None, None, None, None],
                NOW + k * 250,
            );
            assert_eq!(r, Some((false, false, false)));
        }
        let h = header(&c);
        assert_eq!((h.crank_armed, h.tick_count.get()), (1, 3));
        // Stale entry (> 5 s) and nothing else: idle.
        let r = tick(
            &mut w,
            &mut c,
            &mut p,
            [None, None, None, None],
            NOW + 10_000,
        );
        assert_eq!(r, Some((false, true, false)));
    }

    #[test]
    fn renews_after_renew_after_ticks() {
        let mut w = world_acc();
        let mut c = chunk_acc(&w.key, 0, 0, 0);
        let mut p = presence_acc(&c.key, &[([8 * B, 10 * B, 8 * B], i64::MAX / 2)]);
        let mut renewed = vec![];
        for k in 0..400i64 {
            if let Some((_, _, true)) = tick(
                &mut w,
                &mut c,
                &mut p,
                [None, None, None, None],
                NOW + k * 250,
            ) {
                renewed.push(k + 1);
            }
        }
        assert_eq!(renewed, vec![160, 320]);
    }

    #[test]
    fn list_must_match_the_mask() {
        let mut w = world_acc();
        // Mask says N exists, but the slot is a placeholder: repair, nothing ran.
        let mut c = chunk_acc(&w.key, 0, 0, 1 << 0);
        let mut p = presence_acc(&c.key, &[]);
        assert_eq!(
            tick(&mut w, &mut c, &mut p, [None, None, None, None], NOW),
            Some((true, false, false))
        );
        assert_eq!(header(&c).last_tick_ms.get(), 0);
        // Mask says nothing exists, but a real neighbor is passed: repair too.
        let mut c = chunk_acc(&w.key, 0, 0, 0);
        let mut p = presence_acc(&c.key, &[]);
        let mut n = chunk_acc(&w.key, 0, -1, 0);
        let mut np = presence_acc(&n.key, &[]);
        assert_eq!(
            tick(
                &mut w,
                &mut c,
                &mut p,
                [Some((&mut n, &mut np)), None, None, None],
                NOW
            ),
            Some((true, false, false))
        );
        // A chunk of another position in the N slot: nothing runs either.
        let mut c = chunk_acc(&w.key, 0, 0, 1 << 0);
        let mut p = presence_acc(&c.key, &[]);
        let mut e = chunk_acc(&w.key, 1, 0, 0);
        let mut ep = presence_acc(&e.key, &[]);
        assert_eq!(
            tick(
                &mut w,
                &mut c,
                &mut p,
                [Some((&mut e, &mut ep)), None, None, None],
                NOW
            ),
            Some((true, false, false))
        );
    }

    #[test]
    fn mobs_cross_into_neighbors_and_hit_neighbor_presences() {
        let mut w = world_acc();
        let east = 1u8 << (EAST - 1);
        let mut c = chunk_acc(&w.key, 0, 0, east);
        let mut p = presence_acc(&c.key, &[]);
        let mut e = chunk_acc(&w.key, 1, 0, 1 << (WEST - 1));
        // A player just across the east border, a zombie next to it, a pig walking east.
        let victim = [16 * B + 100, FLOOR as i32 * B, 8 * B + 128];
        let mut ep = presence_acc(&e.key, &[(victim, NOW - 100)]);
        set_mob(
            &mut c,
            0,
            &mob(KIND_ZOMBIE, [16 * B - 60, FLOOR as i32 * B, 8 * B + 128], 0),
        );
        set_mob(
            &mut c,
            1,
            &mob(KIND_PIG, [16 * B - 20, FLOOR as i32 * B, 4 * B + 128], 0),
        );
        let r = tick(
            &mut w,
            &mut c,
            &mut p,
            [None, None, Some((&mut e, &mut ep)), None],
            NOW,
        );
        assert_eq!(r, Some((false, false, false)));
        // The hit landed in the east presence entry.
        let pending = ep.data[PRESENCE_HEADER_SIZE + 52];
        assert_eq!(pending, magicraft_core::mobs::ZOMBIE_DAMAGE);
        // The pig moved into the east chunk's first free slot (its old slot is empty).
        let (hc, he) = (header(&c), header(&e));
        assert!(hc.mob(1).is_empty(), "pig left the center");
        let moved = (0..MOB_SLOTS)
            .map(|i| he.mob(i))
            .find(|m| m.kind == KIND_PIG);
        assert!(
            moved.is_some_and(|m| m.pos[0] >= 16 * B),
            "pig in the east chunk"
        );
    }

    #[test]
    fn neighbor_presence_must_be_canonical_and_valid() {
        let mut w = world_acc();
        let n_bit = 1u8 << (NORTH - 1);
        // A presence that stores the right chunk but sits at another address: repair.
        let mut c = chunk_acc(&w.key, 0, 0, n_bit);
        let mut p = presence_acc(&c.key, &[]);
        let mut n = chunk_acc(&w.key, 0, -1, 0);
        let mut fake = presence_at(&n.key, &[]);
        let r = tick(
            &mut w,
            &mut c,
            &mut p,
            [Some((&mut n, &mut fake)), None, None, None],
            NOW,
        );
        assert_eq!(r, Some((true, false, false)));
        // The canonical presence with broken data (count mismatch): repair, not a silent
        // no-op (3 s later: repairs are throttled).
        let mut np = presence_acc(&n.key, &[]);
        np.data[42] = 5;
        let r = tick(
            &mut w,
            &mut c,
            &mut p,
            [Some((&mut n, &mut np)), None, None, None],
            NOW + 3_000,
        );
        assert_eq!(r, Some((true, false, false)));
        // The correct list runs (idle: nothing to do).
        np.data[42] = 0;
        let r = tick(
            &mut w,
            &mut c,
            &mut p,
            [Some((&mut n, &mut np)), None, None, None],
            NOW + 3_500,
        );
        assert_eq!(r, Some((false, true, false)));
    }

    #[test]
    fn repairs_are_throttled() {
        let mut w = world_acc();
        let mut c = chunk_acc(&w.key, 0, 0, 1);
        let mut p = presence_acc(&c.key, &[]);
        assert_eq!(
            tick(&mut w, &mut c, &mut p, [None, None, None, None], NOW),
            Some((true, false, false))
        );
        // Within 3 s: plain no-op (no re-arm), however often it is called.
        for dt in [500, 1_000, 2_999] {
            assert_eq!(
                tick(&mut w, &mut c, &mut p, [None, None, None, None], NOW + dt),
                None
            );
        }
        assert_eq!(
            tick(
                &mut w,
                &mut c,
                &mut p,
                [None, None, None, None],
                NOW + 3_000
            ),
            Some((true, false, false))
        );
    }

    #[test]
    fn stale_writable_arm_rotates_the_task_id() {
        let key = Pubkey::new_unique();
        let mut h: ChunkHeader = bytemuck::Zeroable::zeroed();
        h.task_id.set(scheduler::task_id(TICK_TASK_TAG, &key, 0));
        // Never armed: no rotation.
        assert_eq!(prepare_arm(&mut h, &key, NOW), None);
        assert_eq!((h.task_epoch, h.crank_armed), (0, 1));
        // Armed and alive: no rotation.
        assert_eq!(prepare_arm(&mut h, &key, NOW + CRANK_STALE_MS), None);
        // Armed but stale (dropped or squatted): next epoch, old id returned for cancel.
        let old = h.task_id.get();
        let t = NOW + 3 * CRANK_STALE_MS;
        assert_eq!(prepare_arm(&mut h, &key, t), Some(old));
        assert_eq!(h.task_epoch, 1);
        assert_eq!(h.task_id.get(), scheduler::task_id(TICK_TASK_TAG, &key, 1));
        assert_ne!(h.task_id.get(), old);
        assert_eq!(CrankKeys::of(&h).epoch, 1);
        // Idle-cancelled (crank_armed 0): re-armed under the same id.
        h.crank_armed = 0;
        assert_eq!(prepare_arm(&mut h, &key, t + 10 * CRANK_STALE_MS), None);
        assert_eq!(h.task_epoch, 1);
    }

    #[test]
    fn duplicate_accounts_are_a_noop() {
        let mut w = world_acc();
        let mut c = chunk_acc(&w.key, 0, 0, 0b11);
        let mut p = presence_acc(&c.key, &[]);
        let mut n = chunk_acc(&w.key, 0, -1, 0);
        let mut np = presence_acc(&n.key, &[]);
        let wi = w.info();
        let world = Account::<World>::try_from(&wi).unwrap();
        let (ci, pi) = (c.info(), p.info());
        let (ni, npi) = (n.info(), np.info());
        // The same neighbor in the N and S slots.
        let ns = [ni.clone(), ni.clone(), ci.clone(), ci.clone()];
        let ps = [npi.clone(), npi.clone(), pi.clone(), pi.clone()];
        assert!(run_tick(&world, &ci, &pi, &ns, &ps, NOW).is_none());
    }

    #[test]
    fn stale_gate() {
        let mut h: ChunkHeader = bytemuck::Zeroable::zeroed();
        assert!(crank_stale(&h, NOW));
        mark_armed(&mut h, NOW);
        assert!(!crank_stale(&h, NOW + CRANK_STALE_MS));
        assert!(crank_stale(&h, NOW + CRANK_STALE_MS + 1));
        h.crank_armed = 0;
        assert!(crank_stale(&h, NOW));
        let p: WorldParams = phys::WorldParams::default().into();
        assert_eq!(tick_interval_ms(&p), 250);
        assert_eq!(period(-5, 250), 0);
        assert_eq!(period(1_000, 0), 1_000);
    }
}
