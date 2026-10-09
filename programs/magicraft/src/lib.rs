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
}

#[derive(Accounts)]
pub struct Ping {}
