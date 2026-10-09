//! TEMPORARY spike (Task 6 follow-up): can an ephemeral, non-delegated
//! program PDA (the chunk itself) be the ScheduleTask/CancelTask authority?
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::InstructionData;
use ephemeral_rollups_sdk::anchor::MagicProgram;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID};
use ephemeral_rollups_sdk::ephemeral_accounts::EphemeralAccount;
use magicblock_magic_program_api::args::ScheduleTaskArgs;
use magicblock_magic_program_api::instruction::MagicBlockInstruction;

use crate::state::{Player, PLAYER_SEED};

#[derive(Accounts)]
#[instruction(cx: i32, cz: i32)]
pub struct SpikeChunk<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, authority.key().as_ref()], bump = player.bump, has_one = authority)]
    pub player: Account<'info, Player>,
    /// CHECK: ephemeral chunk PDA, created here.
    #[account(mut, seeds = [b"chunk", player.key().as_ref(), &cx.to_le_bytes(), &cz.to_le_bytes()], bump)]
    pub chunk: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

pub fn spike_chunk(ctx: Context<SpikeChunk>, cx: i32, cz: i32) -> Result<()> {
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
    .create(64)?;
    Ok(())
}

#[derive(Accounts)]
pub struct SpikeTick<'info> {
    /// CHECK: ephemeral chunk owned by this program; permissionless.
    #[account(mut, owner = crate::ID)]
    pub chunk: UncheckedAccount<'info>,
}

pub fn spike_tick(ctx: Context<SpikeTick>) -> Result<()> {
    let mut data = ctx.accounts.chunk.try_borrow_mut_data()?;
    let c = &mut data[0..8];
    let n = u64::from_le_bytes(c.try_into().unwrap()) + 1;
    c.copy_from_slice(&n.to_le_bytes());
    Ok(())
}

/// Any signer may call: the chunk PDA itself is the task authority.
#[derive(Accounts)]
#[instruction(owner: Pubkey, cx: i32, cz: i32)]
pub struct SpikeChunkTask<'info> {
    pub caller: Signer<'info>,
    /// CHECK: ephemeral chunk PDA of `owner` (a Player PDA); signs via seeds.
    #[account(mut, owner = crate::ID, seeds = [b"chunk", owner.as_ref(), &cx.to_le_bytes(), &cz.to_le_bytes()], bump)]
    pub chunk: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
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
    let a = &ctx.accounts;
    let tick = Instruction {
        program_id: crate::ID,
        accounts: vec![AccountMeta::new(a.chunk.key(), false)],
        data: crate::instruction::SpikeTick {}.data(),
    };
    let data = bincode::serialize(&MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
        task_id,
        execution_interval_millis: interval_ms,
        iterations,
        instructions: vec![tick],
    }))
    .map_err(|_| ProgramError::InvalidInstructionData)?;
    let ix = Instruction {
        program_id: MAGIC_PROGRAM_ID,
        accounts: vec![AccountMeta::new(a.chunk.key(), true)],
        data,
    };
    let (cxb, czb) = (cx.to_le_bytes(), cz.to_le_bytes());
    invoke_signed(
        &ix,
        &[a.chunk.to_account_info()],
        &[&[b"chunk", owner.as_ref(), &cxb, &czb, &[ctx.bumps.chunk]]],
    )?;
    Ok(())
}

pub fn spike_chunk_cancel(
    ctx: Context<SpikeChunkTask>,
    owner: Pubkey,
    cx: i32,
    cz: i32,
    task_id: i64,
) -> Result<()> {
    let a = &ctx.accounts;
    let data = bincode::serialize(&MagicBlockInstruction::CancelTask { task_id })
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let ix = Instruction {
        program_id: MAGIC_PROGRAM_ID,
        accounts: vec![AccountMeta::new(a.chunk.key(), true)],
        data,
    };
    let (cxb, czb) = (cx.to_le_bytes(), cz.to_le_bytes());
    invoke_signed(
        &ix,
        &[a.chunk.to_account_info()],
        &[&[b"chunk", owner.as_ref(), &cxb, &czb, &[ctx.bumps.chunk]]],
    )?;
    Ok(())
}
