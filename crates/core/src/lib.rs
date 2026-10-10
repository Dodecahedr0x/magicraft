//! Pure, deterministic Magicraft game logic shared by the onchain program and tests.
//!
//! # Build profile (must match everywhere)
//! The workspace builds this crate with `overflow-checks = false` in release
//! (`[profile.release.package.magicraft-core]` in the root `Cargo.toml`): checked `i64`
//! multiplication is a software routine on SBF and pushed terrain generation past the
//! 1.4M CU limit. Debug/test builds keep the checks, so any overflow is caught by the test
//! suite (where it would panic). **Every other build of this crate that must reproduce
//! onchain results (e.g. a wasm client build) must use the same setting**: with checks on, an
//! overflow would panic instead of wrapping, so outputs could only differ on inputs that
//! overflow — but keeping one setting makes the builds identical by construction.

pub mod blocks;
pub mod caves;
pub mod consts;
pub mod coords;
pub mod fluid;
pub mod ground;
pub mod hash;
pub mod inventory;
pub mod items;
pub mod mobs;
pub mod noise;
pub mod physics;
pub mod populate;
pub mod recipes;
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
