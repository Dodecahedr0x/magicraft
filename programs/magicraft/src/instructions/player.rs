use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::state::{Player, PLAYER_SEED};

// ---------- init_player (base layer) ----------

#[derive(Accounts)]
pub struct InitPlayer<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Player::INIT_SPACE,
        seeds = [PLAYER_SEED, authority.key().as_ref()],
        bump
    )]
    pub player: Account<'info, Player>,
    pub system_program: Program<'info, System>,
}

pub fn init_player(ctx: Context<InitPlayer>) -> Result<()> {
    let player = &mut ctx.accounts.player;
    player.authority = ctx.accounts.authority.key();
    player.bump = ctx.bumps.player;
    Ok(())
}

// ---------- deposit (base layer, before delegation) ----------

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [PLAYER_SEED, authority.key().as_ref()],
        bump = player.bump,
        has_one = authority
    )]
    pub player: Account<'info, Player>,
    pub system_program: Program<'info, System>,
}

pub fn deposit(ctx: Context<Deposit>, lamports: u64) -> Result<()> {
    transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to: ctx.accounts.player.to_account_info(),
            },
        ),
        lamports,
    )
}

// ---------- delegate_player (base layer) ----------

#[delegate]
#[derive(Accounts)]
pub struct DelegatePlayer<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: the Player PDA of `authority` (seeds checked here; the delegate
    /// CPI re-derives it from the same seeds). Untyped because ownership moves
    /// to the delegation program during the CPI.
    #[account(mut, del, seeds = [PLAYER_SEED, authority.key().as_ref()], bump)]
    pub player: UncheckedAccount<'info>,
}

pub fn delegate_player(ctx: Context<DelegatePlayer>, validator: Option<Pubkey>) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    ctx.accounts.delegate_player(
        &ctx.accounts.authority,
        &[PLAYER_SEED, authority.as_ref()],
        DelegateConfig {
            validator,
            ..Default::default()
        },
    )?;
    Ok(())
}
