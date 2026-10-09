//! Cranked instructions (day part): `schedule_day_crank` and its target `tick_day`.
//!
//! The day crank's authority is the **World PDA** (signs with its stored seeds), so arming
//! needs no Player and anyone can (re)arm it: same id + same authority replaces the task.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::InstructionData;
use ephemeral_rollups_sdk::anchor::MagicProgram;

use crate::auth::world_seeds;
use crate::scheduler;
use crate::state::World;

/// Tag of the day crank's task id (`sha256("day" ‖ world)`).
pub const DAY_TASK_TAG: &[u8] = b"day";
/// `tick_day` cadence, ms.
pub const DAY_TICK_MS: i64 = 1_000;
/// Executions per arming (~136 years at 1 s); the watchdog re-arms long before.
pub const DAY_CRANK_ITERATIONS: i64 = u32::MAX as i64;

/// Schedules (or replaces) `tick_day(world)` every [`DAY_TICK_MS`] with the World PDA
/// (`world_ai`, whose stored fields are `world`) as task authority. Returns the task id.
pub fn arm_day_crank<'info>(world_ai: &AccountInfo<'info>, world: &World) -> Result<i64> {
    let task_id = scheduler::task_id(DAY_TASK_TAG, world_ai.key);
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
    /// Task authority (signs the Magic-program CPI with its PDA seeds). Read-only.
    pub world: Account<'info, World>,
    pub magic_program: Program<'info, MagicProgram>,
}

/// Re-arms the World's day crank **only if it looks stalled**
/// ([`World::day_crank_stale`]); otherwise a no-op. `create_world` arms it; clients send
/// this when they see `last_tick_ms` stale (e.g. the scheduler dropped the task). The task
/// id is derived from the World PDA, so a re-arm replaces the task rather than adding one.
/// The World is read-only here (`ScheduleTask` accepts a read-only signer at account 0),
/// so a re-arm never write-locks it.
pub fn schedule_day_crank(ctx: Context<ScheduleDayCrank>) -> Result<()> {
    let world = &ctx.accounts.world;
    let now = world.chain_ms_ro(&Clock::get()?).ms;
    if !world.day_crank_stale(now) {
        msg!("day crank alive; not re-armed");
        return Ok(());
    }
    arm_day_crank(&world.to_account_info(), world)?;
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
