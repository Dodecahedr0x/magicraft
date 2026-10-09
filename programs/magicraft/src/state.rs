use anchor_lang::prelude::*;

pub const PLAYER_SEED: &[u8] = b"player";

/// Per-wallet account. Holds the SOL that sponsors every ephemeral account the
/// player creates. Created, funded and delegated on the base layer.
#[account]
#[derive(InitSpace)]
pub struct Player {
    pub authority: Pubkey,
    pub bump: u8,
}
