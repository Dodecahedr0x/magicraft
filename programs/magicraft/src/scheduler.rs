//! Crank scheduling: the only place that talks to the task scheduler.
//!
//! Today this is the Magic program's `ScheduleTask` / `CancelTask` (bincode, via
//! `magicblock-magic-program-api` 0.14). The SDK marks that path deprecated in favour of
//! Hydra; swapping backends should only touch this module.
//!
//! Rules (see `docs/notes/spikes.md`, Task 4 + chunk-authority follow-up):
//! - The task **authority** is account 0 of the CPI and must sign; we always use a program
//!   PDA (the World for the day crank, the Chunk for chunk ticks) signing with its seeds,
//!   so any caller can (re)arm a task.
//! - Task ids are **global per validator**: derive them with [`task_id`] from the PDA they
//!   serve. Same authority + same id **replaces** the task (no cancel needed); a foreign
//!   authority reusing a live id is silently rejected by the scheduler (the tx succeeds).
//! - Cancelling an unknown id is a silent no-op.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
use magicblock_magic_program_api::args::ScheduleTaskArgs;
use magicblock_magic_program_api::instruction::MagicBlockInstruction;

/// Collision-free task id for the crank `tag` of `key`: the first 8 bytes of
/// `sha256(tag ‖ key)` as LE i64, masked positive, never 0 (0 = "not scheduled").
pub fn task_id(tag: &[u8], key: &Pubkey) -> i64 {
    let h = solana_sha256_hasher::hashv(&[tag, key.as_ref()]).to_bytes();
    let id = i64::from_le_bytes(h[..8].try_into().unwrap()) & i64::MAX;
    if id == 0 {
        1
    } else {
        id
    }
}

/// Schedules (or replaces, same authority + id) `iterations` executions of `ix`, every
/// `interval_ms`. `authority` signs via `signer_seeds` (its PDA seeds incl. bump).
pub fn schedule<'info>(
    authority: &AccountInfo<'info>,
    signer_seeds: &[&[u8]],
    task_id: i64,
    interval_ms: i64,
    iterations: i64,
    ix: Instruction,
) -> Result<()> {
    let data = bincode::serialize(&MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
        task_id,
        execution_interval_millis: interval_ms,
        iterations,
        instructions: vec![ix],
    }))
    .map_err(|_| ProgramError::InvalidInstructionData)?;
    let cpi = Instruction {
        program_id: MAGIC_PROGRAM_ID,
        // Writable only if the caller passed it writable (a read-only authority avoids
        // write-locking e.g. the World against `tick_day`).
        accounts: vec![AccountMeta {
            pubkey: authority.key(),
            is_signer: true,
            is_writable: authority.is_writable,
        }],
        data,
    };
    invoke_signed(&cpi, std::slice::from_ref(authority), &[signer_seeds])?;
    Ok(())
}

/// Cancels task `task_id` owned by `authority` (no-op if unknown).
pub fn cancel<'info>(
    authority: &AccountInfo<'info>,
    signer_seeds: &[&[u8]],
    task_id: i64,
) -> Result<()> {
    let data = bincode::serialize(&MagicBlockInstruction::CancelTask { task_id })
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let cpi = Instruction {
        program_id: MAGIC_PROGRAM_ID,
        accounts: vec![AccountMeta {
            pubkey: authority.key(),
            is_signer: true,
            is_writable: authority.is_writable,
        }],
        data,
    };
    invoke_signed(&cpi, std::slice::from_ref(authority), &[signer_seeds])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_ids_are_positive_and_tagged() {
        for _ in 0..64 {
            let k = Pubkey::new_unique();
            let day = task_id(b"day", &k);
            let tick = task_id(b"tick", &k);
            assert!(day > 0 && tick > 0);
            assert_ne!(day, tick);
            assert_eq!(day, task_id(b"day", &k));
        }
    }
}
