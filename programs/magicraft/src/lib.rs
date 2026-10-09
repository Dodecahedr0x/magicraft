use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod instructions;
pub mod state;

// Handler fns share names with the `#[program]`-generated ix items; the
// clash is harmless (handlers are called by full path).
#[allow(ambiguous_glob_reexports)]
pub use instructions::*;

declare_id!("4GTybm3WD66wUnTgS8UcB9H947uAY7BAqivp8HfbSsW9");

#[ephemeral]
#[program]
pub mod magicraft {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        msg!("pong v{}", magicraft_core::version());
        Ok(())
    }

    // ----- Player (base layer) -----

    pub fn init_player(ctx: Context<InitPlayer>) -> Result<()> {
        instructions::player::init_player(ctx)
    }

    pub fn deposit(ctx: Context<Deposit>, lamports: u64) -> Result<()> {
        instructions::player::deposit(ctx, lamports)
    }

    pub fn delegate_player(ctx: Context<DelegatePlayer>, validator: Option<Pubkey>) -> Result<()> {
        instructions::player::delegate_player(ctx, validator)
    }

    // ----- TEMPORARY chunk spikes (Task 3; remove in Task 6) -----

    pub fn spike_chunk(ctx: Context<SpikeChunk>, cx: i32, cz: i32, len: u32) -> Result<()> {
        instructions::spike::spike_chunk(ctx, cx, cz, len)
    }

    pub fn spike_resize(ctx: Context<SpikeChunk>, cx: i32, cz: i32, new_len: u32) -> Result<()> {
        instructions::spike::spike_resize(ctx, cx, cz, new_len)
    }

    pub fn spike_close(ctx: Context<SpikeChunk>, cx: i32, cz: i32) -> Result<()> {
        instructions::spike::spike_close(ctx, cx, cz)
    }

    pub fn spike_fill(
        ctx: Context<SpikeFill>,
        cx: i32,
        cz: i32,
        value: u8,
        mode: u8,
    ) -> Result<()> {
        instructions::spike::spike_fill(ctx, cx, cz, value, mode)
    }

    // ----- TEMPORARY crank / economics spikes (Task 4; remove in Task 6) -----

    pub fn spike_tick(ctx: Context<SpikeTick>) -> Result<()> {
        instructions::spike::spike_tick(ctx)
    }

    pub fn spike_schedule(
        ctx: Context<SpikeSchedule>,
        cx: i32,
        cz: i32,
        task_id: i64,
        interval_ms: i64,
        iterations: i64,
    ) -> Result<()> {
        instructions::spike::spike_schedule(ctx, cx, cz, task_id, interval_ms, iterations)
    }

    pub fn spike_cancel(ctx: Context<SpikeCancel>, task_id: i64) -> Result<()> {
        instructions::spike::spike_cancel(ctx, task_id)
    }

    pub fn spike_commit(ctx: Context<SpikeCommit>, undelegate: bool) -> Result<()> {
        instructions::spike::spike_commit(ctx, undelegate)
    }

    // ----- TEMPORARY VRF / session spikes (Task 5; remove in Task 6) -----

    pub fn spike_vrf(
        ctx: Context<SpikeVrf>,
        cx: i32,
        cz: i32,
        caller_seed: [u8; 32],
        payer_mode: u8,
    ) -> Result<()> {
        instructions::spike::spike_vrf(ctx, cx, cz, caller_seed, payer_mode)
    }

    pub fn spike_vrf_callback(ctx: Context<SpikeVrfCallback>, randomness: [u8; 32]) -> Result<()> {
        instructions::spike::spike_vrf_callback(ctx, randomness)
    }

    pub fn spike_session_ping(ctx: Context<SpikeSessionPing>, cx: i32, cz: i32) -> Result<()> {
        instructions::spike::spike_session_ping(ctx, cx, cz)
    }
}

#[derive(Accounts)]
pub struct Ping {}
