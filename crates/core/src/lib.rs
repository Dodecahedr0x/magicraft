//! Pure, deterministic Magicraft game logic shared by the onchain program and tests.

pub mod blocks;
pub mod caves;
pub mod consts;
pub mod coords;
pub mod fluid;
pub mod hash;
pub mod items;
pub mod mobs;
pub mod noise;
pub mod physics;
pub mod populate;
pub mod terrain;

/// Version of the core game rules.
pub fn version() -> u32 {
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_one() {
        assert_eq!(version(), 1);
    }
}
