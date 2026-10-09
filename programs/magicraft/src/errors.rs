use anchor_lang::prelude::*;
use magicraft_core::inventory::InvError;
use magicraft_core::physics::MoveError;
use magicraft_core::recipes::CraftError;

/// Program errors. Offset 6100 keeps clear of `session_keys::SessionError`
/// (6000-6003), which is compiled into this program with the default offset.
/// Anchor 1.0 allows only one `#[error_code]` enum per program.
///
/// Codes are stable: append new variants at the end only (clients map numbers).
#[error_code(offset = 6100)]
#[derive(PartialEq, Eq)]
pub enum MagicraftError {
    // ----- auth / accounts -----
    #[msg("Signer is neither the player authority nor a valid session key")]
    Unauthorized, // 6100
    #[msg("Account is not a valid chunk for this world")]
    InvalidChunk, // 6101
    #[msg("Account is not a valid chunk presence list")]
    InvalidPresence, // 6102
    #[msg("Chunk is not generated yet")]
    ChunkNotReady, // 6103
    #[msg("Player does not have enough lamports to sponsor this account")]
    InsufficientSponsorFunds, // 6104
    #[msg("Withdrawal would leave the Player below its rent-exempt minimum")]
    InsufficientFunds, // 6105
    #[msg("Arithmetic overflow")]
    Overflow, // 6106

    // ----- worlds -----
    #[msg("World params out of range")]
    InvalidParams, // 6107
    #[msg("World seed is not set yet (VRF pending)")]
    SeedPending, // 6108
    #[msg("World seed is already set")]
    SeedAlreadySet, // 6109

    // ----- chunks -----
    #[msg("Chunk must be adjacent to an existing chunk or the player's chunk")]
    NotAdjacent, // 6110
    #[msg("Chunk generation stage does not allow this")]
    WrongGenStage, // 6111
    #[msg("Chunk was edited and cannot be closed")]
    ChunkEdited, // 6112
    #[msg("Chunk still has mobs")]
    ChunkHasMobs, // 6113
    #[msg("Chunk still has players present")]
    ChunkOccupied, // 6114

    // ----- movement (core::physics::MoveError) -----
    #[msg("Move too fast")]
    MoveTooFast, // 6115
    #[msg("Move collides with a solid block")]
    Collision, // 6116
    #[msg("Claimed on_ground without ground")]
    NotOnGround, // 6117
    #[msg("Rose higher than jumping allows")]
    Flying, // 6118
    #[msg("Invalid movement state or coordinates")]
    InvalidMoveState, // 6119
    #[msg("Client time out of range of chain time")]
    TimeSkew, // 6120

    // ----- actions -----
    #[msg("Target out of reach")]
    OutOfReach, // 6121
    #[msg("Action on cooldown")]
    Cooldown, // 6122
    #[msg("Block cannot be broken")]
    Unbreakable, // 6123
    #[msg("Target block is not replaceable")]
    InvalidTarget, // 6124
    #[msg("Placed block must touch a solid face")]
    NotFaceAdjacent, // 6125
    #[msg("Placed block overlaps a player")]
    SelfOverlap, // 6126
    #[msg("Item cannot be placed")]
    NotPlaceable, // 6127
    #[msg("Player is dead")]
    Dead, // 6128
    #[msg("Player is not dead")]
    NotDead, // 6129
    #[msg("No mob in that slot")]
    NoMob, // 6130

    // ----- inventory (core::inventory::InvError) -----
    #[msg("Invalid inventory slot")]
    BadSlot, // 6131
    #[msg("Inventory slot is empty")]
    EmptySlot, // 6132
    #[msg("Not enough items")]
    NotEnoughItems, // 6133
    #[msg("Invalid count")]
    InvalidCount, // 6134
    #[msg("Item is not food")]
    NotFood, // 6135
    #[msg("Food is full")]
    FoodFull, // 6136
    #[msg("Inventory full")]
    InventoryFull, // 6137

    // ----- crafting (core::recipes::CraftError) -----
    #[msg("Unknown recipe")]
    UnknownRecipe, // 6138
    #[msg("Required station not within reach")]
    WrongStation, // 6139
    #[msg("Missing recipe inputs")]
    MissingInputs, // 6140
    #[msg("Missing furnace fuel")]
    MissingFuel, // 6141
}

impl From<MoveError> for MagicraftError {
    fn from(e: MoveError) -> Self {
        match e {
            MoveError::MoveTooFast => Self::MoveTooFast,
            MoveError::Collision => Self::Collision,
            MoveError::NotOnGround => Self::NotOnGround,
            MoveError::Flying => Self::Flying,
            MoveError::InvalidState => Self::InvalidMoveState,
            MoveError::TimeSkew => Self::TimeSkew,
        }
    }
}

impl From<InvError> for MagicraftError {
    fn from(e: InvError) -> Self {
        match e {
            InvError::BadSlot => Self::BadSlot,
            InvError::EmptySlot => Self::EmptySlot,
            InvError::NotEnough => Self::NotEnoughItems,
            InvError::InvalidCount => Self::InvalidCount,
            InvError::NotFood => Self::NotFood,
            InvError::FoodFull => Self::FoodFull,
        }
    }
}

impl From<CraftError> for MagicraftError {
    fn from(e: CraftError) -> Self {
        match e {
            CraftError::UnknownRecipe => Self::UnknownRecipe,
            CraftError::WrongStation => Self::WrongStation,
            CraftError::MissingInputs => Self::MissingInputs,
            CraftError::MissingFuel => Self::MissingFuel,
            CraftError::NoSpace => Self::InventoryFull,
            CraftError::InvalidCount => Self::InvalidCount,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_stable() {
        assert_eq!(u32::from(MagicraftError::Unauthorized), 6100);
        assert_eq!(u32::from(MagicraftError::ChunkNotReady), 6103);
        assert_eq!(u32::from(MagicraftError::MoveTooFast), 6115);
        assert_eq!(u32::from(MagicraftError::TimeSkew), 6120);
        assert_eq!(u32::from(MagicraftError::MissingFuel), 6141);
    }

    #[test]
    fn core_errors_map() {
        assert_eq!(
            MagicraftError::from(MoveError::TimeSkew),
            MagicraftError::TimeSkew
        );
        assert_eq!(
            MagicraftError::from(InvError::NotEnough),
            MagicraftError::NotEnoughItems
        );
        assert_eq!(
            MagicraftError::from(CraftError::NoSpace),
            MagicraftError::InventoryFull
        );
    }
}
