//! World-wide constants.

/// Chunk width and depth in blocks (x and z).
pub const CHUNK_W: usize = 16;
/// Chunk height in blocks (y).
pub const CHUNK_H: usize = 64;
/// Number of blocks (bytes) in a chunk.
pub const CHUNK_VOL: usize = CHUNK_W * CHUNK_W * CHUNK_H;
/// Sea level (y of the topmost water layer during generation).
pub const SEA_LEVEL: i32 = 28;
/// Fixed-point scale: positions are `i32` with `FP` units per block.
pub const FP: i32 = 256;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volume_matches_dims() {
        assert_eq!(CHUNK_VOL, CHUNK_W * CHUNK_W * CHUNK_H);
        assert_eq!(CHUNK_VOL, 16384);
        assert_eq!(FP, 256);
        assert_eq!(SEA_LEVEL, 28);
    }
}
