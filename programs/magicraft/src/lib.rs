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

    /// Breaks a block within reach (cooldown = break time; drop to inventory, fluid enqueue).
    pub fn break_block(ctx: Context<BreakBlock>, x: i32, y: i32, z: i32) -> Result<()> {
        instructions::actions::break_block(ctx, x, y, z)
    }

    /// Places the block item of `slot` at a free, face-adjacent position within reach.
    /// `remaining_accounts`: neighbour presence lists for border blocks (see `actions`).
    pub fn place_block(ctx: Context<PlaceBlock>, x: i32, y: i32, z: i32, slot: u8) -> Result<()> {
        instructions::actions::place_block(ctx, x, y, z, slot)
    }

    /// Selects the held inventory slot.
    pub fn select_slot(ctx: Context<SelfAction>, slot: u8) -> Result<()> {
        instructions::actions::select_slot(ctx, slot)
    }

    /// Crafts a recipe; stations are claimed by block position (+ chunk) and verified.
    pub fn craft(
        ctx: Context<Craft>,
        recipe_id: u16,
        count: u8,
        table: Option<[i32; 3]>,
        furnace: Option<[i32; 3]>,
    ) -> Result<()> {
        instructions::actions::craft(ctx, recipe_id, count, table, furnace)
    }

    /// Attacks the mob in slot `idx` of `chunk` (drops to inventory on death).
    pub fn attack_mob(ctx: Context<AttackMob>, idx: u8) -> Result<()> {
        instructions::actions::attack_mob(ctx, idx)
    }

    /// Eats the food in `slot`.
    pub fn eat(ctx: Context<SelfAction>, slot: u8) -> Result<()> {
        instructions::actions::eat(ctx, slot)
    }

    /// Dead player only: back to the spawn with an empty inventory.
    pub fn respawn(ctx: Context<Respawn>) -> Result<()> {
        instructions::actions::respawn(ctx)
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

    // ----- Chunk tick crank (ER) -----

    /// Crank target: one chunk tick (fluid, mobs, zombie spawn, idle / renewal).
    /// Permissionless; never fails on recoverable state.
    pub fn tick_chunk(ctx: Context<TickChunk>) -> Result<()> {
        instructions::crank::tick_chunk(ctx)
    }

    /// Re-arms a chunk's tick crank if it has fluid work or mobs and the crank is stale
    /// (permissionless watchdog; chunk read-only).
    pub fn arm_chunk(ctx: Context<ArmChunk>) -> Result<()> {
        instructions::crank::arm_chunk(ctx)
    }

    /// Test hook (`localnet` builds only): cancels a chunk's tick task, header untouched.
    #[cfg(feature = "localnet")]
    pub fn debug_cancel_tick(ctx: Context<DebugCancelTick>) -> Result<()> {
        instructions::crank::debug_cancel_tick(ctx)
    }

    /// Test hook (`localnet` builds only): puts a mob of `kind` (full hp) at the FP feet
    /// position `pos` into a free slot of the chunk holding it, and arms its crank;
    /// `kind == 0` clears the chunk's mob slots.
    #[cfg(feature = "localnet")]
    pub fn debug_spawn_mob(ctx: Context<DebugSpawnMob>, kind: u8, pos: [i32; 3]) -> Result<()> {
        instructions::crank::debug_spawn_mob(ctx, kind, pos)
    }
}

#[derive(Accounts)]
pub struct Ping {}
