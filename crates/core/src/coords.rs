//! Block / chunk coordinate helpers.

use crate::consts::CHUNK_W;

/// Index of a block inside a chunk's byte array: `(y * 16 + lz) * 16 + lx`.
/// Inputs must satisfy `lx, lz < 16`, `y < 64`.
#[inline]
pub fn block_index(lx: usize, y: usize, lz: usize) -> usize {
    debug_assert!(lx < CHUNK_W && lz < CHUNK_W && y < crate::consts::CHUNK_H);
    (y * CHUNK_W + lz) * CHUNK_W + lx
}

/// Splits a world block coordinate (x or z) into `(chunk coord, local coord 0..16)`
/// using floor division, so `-1 -> (-1, 15)`.
#[inline]
pub fn world_to_chunk(x: i32) -> (i32, usize) {
    (
        x.div_euclid(CHUNK_W as i32),
        x.rem_euclid(CHUNK_W as i32) as usize,
    )
}

/// World block coordinate of local coordinate 0 in chunk `cx`.
/// Valid for `|cx| <= i32::MAX / 16` (overflows otherwise; overflow checks are on in release).
#[inline]
pub fn chunk_origin(cx: i32) -> i32 {
    cx * CHUNK_W as i32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::consts::*;

    #[test]
    fn world_to_chunk_floors_negatives() {
        assert_eq!(world_to_chunk(0), (0, 0));
        assert_eq!(world_to_chunk(15), (0, 15));
        assert_eq!(world_to_chunk(16), (1, 0));
        assert_eq!(world_to_chunk(-1), (-1, 15));
        assert_eq!(world_to_chunk(-16), (-1, 0));
        assert_eq!(world_to_chunk(-17), (-2, 15));
    }

    #[test]
    fn chunk_origin_inverts_world_to_chunk() {
        for x in -100..100 {
            let (cx, lx) = world_to_chunk(x);
            assert_eq!(chunk_origin(cx) + lx as i32, x);
        }
        assert_eq!(chunk_origin(-1), -16);
    }

    #[test]
    fn block_index_corners_and_uniqueness() {
        assert_eq!(block_index(0, 0, 0), 0);
        assert_eq!(block_index(15, 63, 15), CHUNK_VOL - 1);
        assert_eq!(block_index(15, 63, 15), 16383);
        let mut seen = vec![false; CHUNK_VOL];
        for y in 0..CHUNK_H {
            for lz in 0..CHUNK_W {
                for lx in 0..CHUNK_W {
                    let i = block_index(lx, y, lz);
                    assert!(!seen[i]);
                    seen[i] = true;
                }
            }
        }
        assert!(seen.iter().all(|&s| s));
    }
}
