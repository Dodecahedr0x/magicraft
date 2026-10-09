use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod auth;
pub mod errors;
pub mod instructions;
pub mod presence;
pub mod scheduler;
pub mod state;

// Handler fns share names with the `#[program]`-generated ix items; the
// clash is harmless (handlers are called by full path).
#[allow(ambiguous_glob_reexports)]
pub use instructions::*;
pub use state::WorldParams;

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

    /// ER: commit + undelegate the Player (step 1 of a withdrawal).
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        instructions::player::withdraw(ctx)
    }

    /// Base layer, after undelegation: transfer `lamports` to the wallet.
    pub fn withdraw_base(ctx: Context<WithdrawBase>, lamports: u64) -> Result<()> {
        instructions::player::withdraw_base(ctx, lamports)
    }

    // ----- Worlds (ER) -----

    /// Creates the ephemeral World (sponsored by the Player) and arms its day crank.
    pub fn create_world(
        ctx: Context<CreateWorld>,
        nonce: u64,
        name: [u8; 32],
        params: WorldParams,
    ) -> Result<()> {
        instructions::world::create_world(ctx, nonce, name, params)
    }

    /// Requests the world seed from the ER VRF queue (the creator's Player PDA pays).
    pub fn request_seed(ctx: Context<RequestSeed>, client_seed: [u8; 32]) -> Result<()> {
        instructions::world::request_seed(ctx, client_seed)
    }

    /// VRF callback: stores the seed once.
    pub fn callback_seed(ctx: Context<CallbackSeed>, randomness: [u8; 32]) -> Result<()> {
        instructions::world::callback_seed(ctx, randomness)
    }

    // ----- Chunks (ER) -----

    /// Creates `Chunk (cx, cz)` (10 240 B, `gen_stage 0`) + its empty presence list,
    /// sponsored by the Player. Same tx: `grow_chunk`.
    pub fn create_chunk(ctx: Context<CreateChunk>, cx: i32, cz: i32) -> Result<()> {
        instructions::chunk::create_chunk(ctx, cx, cz)
    }

    /// Resizes the chunk to full size and writes stage-1 terrain (`gen_stage 1`).
    /// Permissionless (sponsor = the chunk's payer Player).
    pub fn grow_chunk(ctx: Context<GrowChunk>, cx: i32, cz: i32) -> Result<()> {
        instructions::chunk::grow_chunk(ctx, cx, cz)
    }

    /// Stage 2 (caves, ores, trees, animals). Permissionless; World read-only.
    pub fn populate_chunk(ctx: Context<PopulateChunk>, cx: i32, cz: i32) -> Result<()> {
        instructions::chunk::populate_chunk(ctx, cx, cz)
    }

    /// Sets the world spawn once from the populated chunk (0,0). Permissionless.
    pub fn set_spawn(ctx: Context<SetSpawn>) -> Result<()> {
        instructions::chunk::set_spawn(ctx)
    }

    /// Closes an unedited, empty chunk + presence; refunds the payer Player.
    pub fn close_chunk(ctx: Context<CloseChunk>, cx: i32, cz: i32) -> Result<()> {
        instructions::chunk::close_chunk(ctx, cx, cz)
    }

    // ----- Playing (ER) -----

    /// Creates the player's `PlayerState` in the world at the spawn (sponsored by the Player).
    pub fn join_world(ctx: Context<JoinWorld>) -> Result<()> {
        instructions::play::join_world(ctx)
    }

    /// Validates and applies one movement update (presence, damage, hunger). World read-only.
    pub fn move_player(
        ctx: Context<MovePlayer>,
        pos: [i32; 3],
        vel: [i32; 3],
        on_ground: bool,
        client_ms: i64,
    ) -> Result<()> {
        instructions::play::move_player(ctx, pos, vel, on_ground, client_ms)
    }

    // ----- Day crank (ER) -----

    /// (Re)arms the World's day crank (permissionless, idempotent).
    pub fn schedule_day_crank(ctx: Context<ScheduleDayCrank>) -> Result<()> {
        instructions::crank::schedule_day_crank(ctx)
    }

    /// Crank target: re-anchors the clock and advances `time_of_day_ms`.
    pub fn tick_day(ctx: Context<TickDay>) -> Result<()> {
        instructions::crank::tick_day(ctx)
    }
}

#[derive(Accounts)]
pub struct Ping {}
