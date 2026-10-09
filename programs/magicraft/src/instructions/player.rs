use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::anchor::{delegate, MagicProgram};
use ephemeral_rollups_sdk::consts::MAGIC_CONTEXT_ID;
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;

use crate::errors::MagicraftError;
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
    player.open_chunks = 0;
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

/// `validator`: the ER validator to delegate to. `None` lets any validator
/// pick the Player up; production should pin the ER validator identity.
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

// ---------- withdraw (ER): commit + undelegate ----------

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [PLAYER_SEED, authority.key().as_ref()],
        bump = player.bump,
        has_one = authority
    )]
    pub player: Account<'info, Player>,
    /// CHECK: Magic context
    #[account(mut, address = MAGIC_CONTEXT_ID)]
    pub magic_context: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

/// Step 1 of a withdrawal, sent to the ER: commits the Player (its base balance moves by
/// the ER-side delta since the last sync) and undelegates it. Never blocked: open
/// chunks stay on the ER (`open_chunks` is only a UI warning). Wallet-signed only.
pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
    let a = &ctx.accounts;
    commit_and_undelegate_accounts(
        &a.authority.to_account_info(),
        vec![&a.player.to_account_info()],
        &a.magic_context.to_account_info(),
        &a.magic_program.to_account_info(),
        None,
    )?;
    Ok(())
}

// ---------- withdraw_base (base layer, after undelegation) ----------

#[derive(Accounts)]
pub struct WithdrawBase<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [PLAYER_SEED, authority.key().as_ref()],
        bump = player.bump,
        has_one = authority
    )]
    pub player: Account<'info, Player>,
}

/// Step 2, on the base layer once the Player is owned by this program again: moves
/// `lamports` to the wallet, keeping the Player rent-exempt.
pub fn withdraw_base(ctx: Context<WithdrawBase>, lamports: u64) -> Result<()> {
    let player = ctx.accounts.player.to_account_info();
    let min = Rent::get()?.minimum_balance(player.data_len());
    let available = player.lamports().saturating_sub(min);
    require!(lamports <= available, MagicraftError::InsufficientFunds);
    player.sub_lamports(lamports)?;
    ctx.accounts.authority.add_lamports(lamports)?;
    Ok(())
}
