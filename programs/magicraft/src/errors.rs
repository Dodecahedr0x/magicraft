use anchor_lang::prelude::*;

/// Program errors. Offset 6100 keeps clear of `session_keys::SessionError`
/// (6000-6003), which is compiled into this program with the default offset.
/// Anchor 1.0 allows only one `#[error_code]` enum per program.
#[error_code(offset = 6100)]
pub enum MagicraftError {
    #[msg("Signer is neither the player authority nor a valid session key")]
    Unauthorized,
}
