//! TEMPORARY spike instructions (Tasks 3-4). Remove in Task 6.
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

/// Closes the chunk; the Magic program refunds its rent to the sponsor (Player).
pub fn spike_close(ctx: Context<SpikeChunk>, _cx: i32, _cz: i32) -> Result<()> {
    let a = &ctx.accounts;
    let authority = a.authority.key();
    let player_seeds: &[&[u8]] = &[PLAYER_SEED, authority.as_ref(), &[a.player.bump]];
    EphemeralAccount::new(
        &a.player.to_account_info(),
        &a.chunk.to_account_info(),
        &a.vault.to_account_info(),
    )
    .with_signer_seeds(&[player_seeds])
    .close()?;
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

// ---------- Task 4: crank spike (TEMPORARY, remove in Task 6) ----------

use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::InstructionData;
use ephemeral_rollups_sdk::consts::{MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID};
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};
use magicblock_magic_program_api::args::ScheduleTaskArgs;
use magicblock_magic_program_api::instruction::MagicBlockInstruction;

/// Byte offset of the tick counter (u64 LE) inside the spike chunk.
const TICK_OFFSET: usize = 0;
/// `spike_tick` fails while the first block byte equals this value
/// (set it with `spike_fill(mode 1, 0xFF)`), to see what a failing crank does.
pub const TICK_FAIL_MARKER: u8 = 0xFF;

#[error_code]
pub enum SpikeError {
    #[msg("spike_tick forced failure")]
    ForcedFailure,
}

#[derive(Accounts)]
pub struct SpikeTick<'info> {
    /// CHECK: an ephemeral spike chunk owned by this program. No signer: cranks
    /// can only sign with the crank-signer PDA, so tick ixs are permissionless.
    #[account(mut, owner = crate::ID)]
    pub chunk: UncheckedAccount<'info>,
}

pub fn spike_tick(ctx: Context<SpikeTick>) -> Result<()> {
    let mut data = ctx.accounts.chunk.try_borrow_mut_data()?;
    require!(
        data[BLOCKS_OFFSET] != TICK_FAIL_MARKER,
        SpikeError::ForcedFailure
    );
    let c = &mut data[TICK_OFFSET..TICK_OFFSET + 8];
    let n = u64::from_le_bytes(c.try_into().unwrap()) + 1;
    c.copy_from_slice(&n.to_le_bytes());
    Ok(())
}

#[derive(Accounts)]
#[instruction(cx: i32, cz: i32)]
pub struct SpikeSchedule<'info> {
    pub authority: Signer<'info>,
    /// CHECK: Player PDA of `authority`; it is the task payer/authority and signs
    /// the Magic-program CPI via its seeds. Untyped so Anchor does not
    /// re-serialize it after the CPI.
    #[account(mut, seeds = [PLAYER_SEED, authority.key().as_ref()], bump)]
    pub player: UncheckedAccount<'info>,
    /// CHECK: ephemeral chunk PDA (the crank target).
    #[account(
        mut,
        seeds = [b"chunk", player.key().as_ref(), &cx.to_le_bytes(), &cz.to_le_bytes()],
        bump
    )]
    pub chunk: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

/// Schedules `iterations` × `spike_tick(chunk)` every `interval_ms`, paid for
/// and owned by the Player PDA.
pub fn spike_schedule(
    ctx: Context<SpikeSchedule>,
    _cx: i32,
    _cz: i32,
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
        accounts: vec![
            AccountMeta::new(a.player.key(), true),
            AccountMeta::new(a.chunk.key(), false),
        ],
        data,
    };
    let authority = a.authority.key();
    invoke_signed(
        &ix,
        &[a.player.to_account_info(), a.chunk.to_account_info()],
        &[&[PLAYER_SEED, authority.as_ref(), &[ctx.bumps.player]]],
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct SpikeCancel<'info> {
    pub authority: Signer<'info>,
    /// CHECK: Player PDA (the task authority).
    #[account(mut, seeds = [PLAYER_SEED, authority.key().as_ref()], bump)]
    pub player: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

pub fn spike_cancel(ctx: Context<SpikeCancel>, task_id: i64) -> Result<()> {
    let a = &ctx.accounts;
    let data = bincode::serialize(&MagicBlockInstruction::CancelTask { task_id })
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let ix = Instruction {
        program_id: MAGIC_PROGRAM_ID,
        accounts: vec![AccountMeta::new(a.player.key(), true)],
        data,
    };
    let authority = a.authority.key();
    invoke_signed(
        &ix,
        &[a.player.to_account_info()],
        &[&[PLAYER_SEED, authority.as_ref(), &[ctx.bumps.player]]],
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct SpikeCommit<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: delegated Player PDA of `authority`.
    #[account(mut, seeds = [PLAYER_SEED, authority.key().as_ref()], bump)]
    pub player: UncheckedAccount<'info>,
    /// CHECK: Magic context
    #[account(mut, address = MAGIC_CONTEXT_ID)]
    pub magic_context: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

/// Commits the Player (and undelegates it when `undelegate`), on the ER.
pub fn spike_commit(ctx: Context<SpikeCommit>, undelegate: bool) -> Result<()> {
    let a = &ctx.accounts;
    let player = a.player.to_account_info();
    let f = if undelegate {
        commit_and_undelegate_accounts
    } else {
        commit_accounts
    };
    f(
        &a.authority.to_account_info(),
        vec![&player],
        &a.magic_context.to_account_info(),
        &a.magic_program.to_account_info(),
        None,
    )?;
    Ok(())
}
