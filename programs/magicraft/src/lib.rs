use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod auth;
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

    /// ER: commit + undelegate the Player (step 1 of a withdrawal).
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        instructions::player::withdraw(ctx)
    }

    /// Base layer, after undelegation: transfer `lamports` to the wallet.
    pub fn withdraw_base(ctx: Context<WithdrawBase>, lamports: u64) -> Result<()> {
        instructions::player::withdraw_base(ctx, lamports)
    }
}

#[derive(Accounts)]
pub struct Ping {}
