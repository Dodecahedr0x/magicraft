//! Authorization and PDA signer-seed helpers.
//!
//! Gameplay ixs authorize with `#[session_auth_or(ctx.accounts.player.authority ==
//! ctx.accounts.signer.key(), MagicraftError::Unauthorized)]` (wallet or a `SessionTokenV2`
//! for the Player's authority). Wallet-only ixs use [`require_authority`] or Anchor's
//! `has_one = authority`. Seeds below match the PDAs documented in `state.rs`; bumps are
//! always the stored ones (no `find_program_address` at runtime).

use anchor_lang::prelude::*;

use crate::errors::MagicraftError;
use crate::state::{Player, CHUNK_SEED, PLAYER_SEED, PRESENCE_SEED, PSTATE_SEED, WORLD_SEED};

/// `signer` must be the Player's wallet.
pub fn require_authority(player: &Player, signer: &Pubkey) -> Result<()> {
    require_keys_eq!(player.authority, *signer, MagicraftError::Unauthorized);
    Ok(())
}

/// `["player", authority, bump]`.
pub fn player_seeds<'a>(authority: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
    [PLAYER_SEED, authority.as_ref(), bump]
}

/// `["world", creator, nonce LE, bump]` (`nonce` = `nonce.to_le_bytes()`).
pub fn world_seeds<'a>(
    creator: &'a Pubkey,
    nonce: &'a [u8; 8],
    bump: &'a [u8; 1],
) -> [&'a [u8]; 4] {
    [WORLD_SEED, creator.as_ref(), nonce, bump]
}

/// `["chunk", world, cx LE, cz LE, bump]`.
pub fn chunk_seeds<'a>(
    world: &'a Pubkey,
    cx: &'a [u8; 4],
    cz: &'a [u8; 4],
    bump: &'a [u8; 1],
) -> [&'a [u8]; 5] {
    [CHUNK_SEED, world.as_ref(), cx, cz, bump]
}

/// `["presence", chunk, bump]`.
pub fn presence_seeds<'a>(chunk: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
    [PRESENCE_SEED, chunk.as_ref(), bump]
}

/// `["pstate", world, player, bump]`.
pub fn pstate_seeds<'a>(world: &'a Pubkey, player: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 4] {
    [PSTATE_SEED, world.as_ref(), player.as_ref(), bump]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_derive_the_canonical_pdas() {
        let authority = Pubkey::new_unique();
        let (pda, bump) =
            Pubkey::find_program_address(&[PLAYER_SEED, authority.as_ref()], &crate::ID);
        let b = [bump];
        let s = player_seeds(&authority, &b);
        assert_eq!(Pubkey::create_program_address(&s, &crate::ID).unwrap(), pda);

        let world = Pubkey::new_unique();
        let (cx, cz) = ((-1i32).to_le_bytes(), 2i32.to_le_bytes());
        let (chunk, bump) =
            Pubkey::find_program_address(&[CHUNK_SEED, world.as_ref(), &cx, &cz], &crate::ID);
        let b = [bump];
        assert_eq!(
            Pubkey::create_program_address(&chunk_seeds(&world, &cx, &cz, &b), &crate::ID).unwrap(),
            chunk
        );
    }

    #[test]
    fn authority_check() {
        let p = Player {
            authority: Pubkey::new_unique(),
            bump: 1,
            open_chunks: 0,
            _reserved: [0; 60],
        };
        assert!(require_authority(&p, &p.authority).is_ok());
        assert!(require_authority(&p, &Pubkey::new_unique()).is_err());
    }
}
