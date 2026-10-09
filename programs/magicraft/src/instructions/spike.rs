//! TEMPORARY spike instructions (Task 3). Remove in Task 6.
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::MagicProgram;
use ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;
use ephemeral_rollups_sdk::ephemeral_accounts::EphemeralAccount;

use crate::state::{Player, PLAYER_SEED};

const BLOCKS_OFFSET: usize = 512;
const BLOCKS_LEN: usize = 16_384;

// Not `#[ephemeral_accounts]`: its generated `create_ephemeral_chunk` re-derives
// the eph seeds inside `impl SpikeChunk`, where the ix args `cx`/`cz` are not in
// scope (E0425). We call the SDK builder directly with Anchor's bumps instead,
// and declare the `vault` / `magic_program` accounts the macro would inject.
#[derive(Accounts)]
#[instruction(cx: i32, cz: i32)]
pub struct SpikeChunk<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [PLAYER_SEED, authority.key().as_ref()],
        bump = player.bump,
        has_one = authority
    )]
    pub player: Account<'info, Player>,
    /// CHECK: ephemeral chunk PDA, created here.
    #[account(
        mut,
        seeds = [b"chunk", player.key().as_ref(), &cx.to_le_bytes(), &cz.to_le_bytes()],
        bump
    )]
    pub chunk: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

/// Creates the chunk with `len` bytes. Any `len` > 10_240 fails with
/// `InvalidRealloc`: the SVM caps account growth inside a CPI at 10 KiB.
pub fn spike_chunk(ctx: Context<SpikeChunk>, cx: i32, cz: i32, len: u32) -> Result<()> {
    let a = &ctx.accounts;
    let authority = a.authority.key();
    let player = a.player.key();
    let (cxb, czb) = (cx.to_le_bytes(), cz.to_le_bytes());
    let player_seeds: &[&[u8]] = &[PLAYER_SEED, authority.as_ref(), &[a.player.bump]];
    let chunk_seeds: &[&[u8]] = &[b"chunk", player.as_ref(), &cxb, &czb, &[ctx.bumps.chunk]];
    EphemeralAccount::new(
        &a.player.to_account_info(),
        &a.chunk.to_account_info(),
        &a.vault.to_account_info(),
    )
    .with_signer_seeds(&[player_seeds, chunk_seeds])
    .create(len)?;
    Ok(())
}

/// Grows (or shrinks) the chunk to `new_len`. Must be a separate top-level
/// instruction from the create so each stays under the 10 KiB CPI growth cap.
pub fn spike_resize(ctx: Context<SpikeChunk>, _cx: i32, _cz: i32, new_len: u32) -> Result<()> {
    let a = &ctx.accounts;
    let authority = a.authority.key();
    let player_seeds: &[&[u8]] = &[PLAYER_SEED, authority.as_ref(), &[a.player.bump]];
    EphemeralAccount::new(
        &a.player.to_account_info(),
        &a.chunk.to_account_info(),
        &a.vault.to_account_info(),
    )
    .with_signer_seeds(&[player_seeds])
    .resize(new_len)?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(cx: i32, cz: i32)]
pub struct SpikeFill<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [PLAYER_SEED, authority.key().as_ref()],
        bump = player.bump,
        has_one = authority
    )]
    pub player: Account<'info, Player>,
    /// CHECK: ephemeral chunk PDA owned by this program.
    #[account(
        mut,
        owner = crate::ID,
        seeds = [b"chunk", player.key().as_ref(), &cx.to_le_bytes(), &cz.to_le_bytes()],
        bump
    )]
    pub chunk: UncheckedAccount<'info>,
}

/// mode 0: byte loop (LLVM turns it into a memset), 1: slice::fill,
/// 2: copy_from_slice from a heap buffer, 3: no write (overhead baseline),
/// 4: per-byte computed value (a cheap hash of the index, like terrain gen).
pub fn spike_fill(ctx: Context<SpikeFill>, _cx: i32, _cz: i32, value: u8, mode: u8) -> Result<()> {
    let mut data = ctx.accounts.chunk.try_borrow_mut_data()?;
    let blocks = &mut data[BLOCKS_OFFSET..BLOCKS_OFFSET + BLOCKS_LEN];
    match mode {
        0 => {
            for b in blocks.iter_mut() {
                *b = value;
            }
        }
        1 => blocks.fill(value),
        2 => {
            let src = vec![value; BLOCKS_LEN];
            blocks.copy_from_slice(&src);
        }
        3 => {}
        _ => {
            for (i, b) in blocks.iter_mut().enumerate() {
                let h = (i as u32).wrapping_mul(0x9E37_79B1) ^ value as u32;
                *b = (h >> 29) as u8;
            }
        }
    }
    Ok(())
}
