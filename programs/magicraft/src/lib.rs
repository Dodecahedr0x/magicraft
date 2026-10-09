use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod errors;
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

    // ----- TEMPORARY crank-authority spike -----

    pub fn spike_chunk(ctx: Context<SpikeChunk>, cx: i32, cz: i32) -> Result<()> {
        instructions::spike::spike_chunk(ctx, cx, cz)
    }

    pub fn spike_tick(ctx: Context<SpikeTick>) -> Result<()> {
        instructions::spike::spike_tick(ctx)
    }

    pub fn spike_chunk_schedule(
        ctx: Context<SpikeChunkTask>,
        owner: Pubkey,
        cx: i32,
        cz: i32,
        task_id: i64,
        interval_ms: i64,
        iterations: i64,
    ) -> Result<()> {
        instructions::spike::spike_chunk_schedule(
            ctx,
            owner,
            cx,
            cz,
            task_id,
            interval_ms,
            iterations,
        )
    }

    pub fn spike_chunk_cancel(
        ctx: Context<SpikeChunkTask>,
        owner: Pubkey,
        cx: i32,
        cz: i32,
        task_id: i64,
    ) -> Result<()> {
        instructions::spike::spike_chunk_cancel(ctx, owner, cx, cz, task_id)
    }
}

#[derive(Accounts)]
pub struct Ping {}
