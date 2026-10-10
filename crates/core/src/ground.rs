//! Ground items: what a broken block drops, floating where the block was until a player
//! picks it up or it despawns.
//!
//! Stored in the chunk account after the blocks (`GROUND_SLOTS` fixed slots, see the
//! program's `state.rs`). Total and allocation-free like the rest of the core: any stored
//! bytes parse, every loop is bounded by [`GROUND_SLOTS`].
//!
//! # Rules
//! - [`GroundItems::drop_at`]: merges into a live stack of the same item at the same
//!   position (up to the item's max stack), then fills the first free slot (empty or
//!   expired); with no free slot the item that expires first is replaced. Every drop thus
//!   lands; only the oldest item of a chunk holding [`GROUND_SLOTS`] can be lost.
//! - Items fall: a drop lands on the first solid block below the broken one
//!   ([`landing_y`]), and items resting on a block that breaks fall with it
//!   ([`GroundItems::settle_column`]). There is no other physics: an item stays put once
//!   landed (in water it sinks to the bottom).
//! - An item lives [`GROUND_TTL_MS`] (chain ms) from its last drop; afterwards it is gone
//!   (lazily: the slot just counts as free, nothing has to clean it up).
//! - [`GroundItems::pickup`]: a live item within [`PICKUP_REACH_FP`] (+ [`PICKUP_SLACK_FP`])
//!   of the player's body center goes into the inventory, as much as fits; the rest stays.

use crate::consts::FP;
use crate::inventory::Inventory;
use crate::items::Item;

/// Ground item slots per chunk.
pub const GROUND_SLOTS: usize = 16;
/// Lifetime of a ground item, chain ms (5 minutes, as in Minecraft).
pub const GROUND_TTL_MS: i64 = 300_000;
/// Pickup distance from the player's body center to the item, FP (2 blocks).
pub const PICKUP_REACH_FP: i64 = 2 * FP as i64;
/// Added to [`PICKUP_REACH_FP`]: the stored player position lags the client's.
pub const PICKUP_SLACK_FP: i64 = FP as i64 / 2;
/// Height of the body center above the feet, FP (0.9 block).
pub const BODY_CENTER_FP: i64 = 230;
/// Height of a dropped item above the bottom of its block, FP (0.25 block).
pub const DROP_LIFT_FP: i32 = FP / 4;

/// One ground item slot.
///
/// Byte layout (little-endian, [`Self::SIZE`] = 24):
///
/// | off | field | type | meaning |
/// |---|---|---|---|
/// | 0 | `item` | u16 | [`Item`] id; 0 = empty |
/// | 2 | `count` | u8 | 1..=max_stack; 0 = empty |
/// | 3 | `_pad` | u8 | 0 |
/// | 4 | `pos` | [i32; 3] | FP position (bottom center of the floating item) |
/// | 16 | `expires_ms` | i64 | chain ms after which the slot is free |
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GroundItem {
    pub item: u16,
    pub count: u8,
    pub pos: [i32; 3],
    pub expires_ms: i64,
}

impl GroundItem {
    /// Size in bytes.
    pub const SIZE: usize = 24;

    /// The item, if the slot holds a known item that has not expired at `now`.
    pub fn live(&self, now: i64) -> Option<Item> {
        if self.count == 0 || now >= self.expires_ms {
            return None;
        }
        Item::from_u16(self.item)
    }
}

/// Ground item errors (the program maps them to its errors).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GroundError {
    /// Slot index out of range, empty, unknown or expired.
    NoItem,
    /// The item is farther than the pickup reach.
    OutOfReach,
    /// Nothing of it fits into the inventory.
    InventoryFull,
}

/// The [`GROUND_SLOTS`] slots of a chunk. Byte layout: slot `i` at `24 × i`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GroundItems {
    pub slots: [GroundItem; GROUND_SLOTS],
}

/// Block y where an item at block `y` of a column comes to rest: it falls while the block
/// below is not `solid` (never below 0). Bounded by `y` steps.
pub fn landing_y(y: i32, solid: impl Fn(i32) -> bool) -> i32 {
    let mut y = y;
    while y > 0 && !solid(y - 1) {
        y -= 1;
    }
    y
}

/// FP position of an item resting in block `(x, y, z)` (the drop of a block broken there
/// once it has landed: pass the [`landing_y`]).
pub fn drop_pos(b: [i32; 3]) -> [i32; 3] {
    let c = |v: i32| v.wrapping_mul(FP).wrapping_add(FP / 2);
    [
        c(b[0]),
        b[1].wrapping_mul(FP).wrapping_add(DROP_LIFT_FP),
        c(b[2]),
    ]
}

/// An item at `item` is within pickup reach of a player with feet at `feet` (both FP).
pub fn in_pickup_reach(feet: [i32; 3], item: [i32; 3]) -> bool {
    let r = (PICKUP_REACH_FP + PICKUP_SLACK_FP) as u64;
    let d = [
        item[0] as i64 - feet[0] as i64,
        item[1] as i64 - (feet[1] as i64 + BODY_CENTER_FP),
        item[2] as i64 - feet[2] as i64,
    ]
    .map(|v| v.unsigned_abs());
    if d.iter().any(|&v| v > r) {
        return false;
    }
    d[0] * d[0] + d[1] * d[1] + d[2] * d[2] <= r * r
}

impl GroundItems {
    /// Size in bytes.
    pub const SIZE: usize = GROUND_SLOTS * GroundItem::SIZE;

    /// Parses stored bytes (never fails; garbage is caught by [`GroundItem::live`]).
    pub fn from_bytes(b: &[u8; Self::SIZE]) -> Self {
        let mut g = GroundItems::default();
        for (s, c) in g.slots.iter_mut().zip(b.chunks_exact(GroundItem::SIZE)) {
            let i32_at = |o: usize| i32::from_le_bytes(c[o..o + 4].try_into().unwrap());
            *s = GroundItem {
                item: u16::from_le_bytes([c[0], c[1]]),
                count: c[2],
                pos: [i32_at(4), i32_at(8), i32_at(12)],
                expires_ms: i64::from_le_bytes(c[16..24].try_into().unwrap()),
            };
        }
        g
    }

    /// Little-endian bytes in the documented layout.
    pub fn to_bytes(&self) -> [u8; Self::SIZE] {
        let mut b = [0u8; Self::SIZE];
        for (s, c) in self.slots.iter().zip(b.chunks_exact_mut(GroundItem::SIZE)) {
            c[0..2].copy_from_slice(&s.item.to_le_bytes());
            c[2] = s.count;
            for (k, v) in s.pos.iter().enumerate() {
                c[4 + 4 * k..8 + 4 * k].copy_from_slice(&v.to_le_bytes());
            }
            c[16..24].copy_from_slice(&s.expires_ms.to_le_bytes());
        }
        b
    }

    /// Drops `n` of `item` at `pos` (see the module docs); returns the last slot written.
    pub fn drop_at(&mut self, item: Item, n: u8, pos: [i32; 3], now: i64) -> usize {
        let id = item as u16;
        let max = item.max_stack();
        let expires_ms = now.saturating_add(GROUND_TTL_MS);
        let mut left = n;
        let mut last = 0;
        for (i, s) in self.slots.iter_mut().enumerate() {
            if left == 0 {
                return last;
            }
            if s.live(now) == Some(item) && s.pos == pos && s.count < max {
                let k = left.min(max - s.count);
                s.count += k;
                s.expires_ms = expires_ms;
                left -= k;
                last = i;
            }
        }
        while left > 0 {
            let i = self
                .slots
                .iter()
                .position(|s| s.live(now).is_none())
                .unwrap_or_else(|| {
                    // Full: replace the item that expires first.
                    (0..GROUND_SLOTS)
                        .min_by_key(|&i| self.slots[i].expires_ms)
                        .unwrap_or(0)
                });
            let k = left.min(max);
            self.slots[i] = GroundItem {
                item: id,
                count: k,
                pos,
                expires_ms,
            };
            left -= k;
            last = i;
        }
        last
    }

    /// Block `(x, y, z)` was broken: live items resting on it (in block `y + 1` of its
    /// column) fall to block `landing` ([`landing_y`] of `y`).
    pub fn settle_column(&mut self, x: i32, y: i32, z: i32, landing: i32, now: i64) {
        let above = y
            .wrapping_add(1)
            .wrapping_mul(FP)
            .wrapping_add(DROP_LIFT_FP);
        for s in self.slots.iter_mut() {
            if s.live(now).is_some()
                && s.pos[1] == above
                && s.pos[0].div_euclid(FP) == x
                && s.pos[2].div_euclid(FP) == z
            {
                s.pos[1] = landing.wrapping_mul(FP).wrapping_add(DROP_LIFT_FP);
            }
        }
    }

    /// Picks slot `i` up into `inv` for a player with feet at `feet`; returns how many
    /// were taken (the rest stays on the ground).
    pub fn pickup(
        &mut self,
        i: usize,
        inv: &mut Inventory,
        feet: [i32; 3],
        now: i64,
    ) -> Result<u8, GroundError> {
        let s = self.slots.get_mut(i).ok_or(GroundError::NoItem)?;
        let item = s.live(now).ok_or(GroundError::NoItem)?;
        if !in_pickup_reach(feet, s.pos) {
            return Err(GroundError::OutOfReach);
        }
        let left = inv.add(item, s.count as u32) as u8;
        let taken = s.count - left;
        if taken == 0 {
            return Err(GroundError::InventoryFull);
        }
        s.count = left;
        if left == 0 {
            *s = GroundItem::default();
        }
        Ok(taken)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000_000;

    fn feet_at_block(b: [i32; 3]) -> [i32; 3] {
        [b[0] * FP + FP / 2, b[1] * FP, b[2] * FP + FP / 2]
    }

    #[test]
    fn bytes_roundtrip() {
        let mut g = GroundItems::default();
        g.drop_at(Item::Cobblestone, 1, drop_pos([-3, 40, 17]), NOW);
        g.drop_at(Item::Diamond, 1, drop_pos([5, 12, -9]), NOW);
        let b = g.to_bytes();
        assert_eq!(GroundItems::from_bytes(&b), g);
        assert_eq!(
            &b[0..4],
            &[
                Item::Cobblestone as u8,
                (Item::Cobblestone as u16 >> 8) as u8,
                1,
                0
            ]
        );
        assert_eq!(
            i32::from_le_bytes(b[4..8].try_into().unwrap()),
            -3 * 256 + 128
        );
        assert_eq!(
            i32::from_le_bytes(b[8..12].try_into().unwrap()),
            40 * 256 + 64
        );
        assert_eq!(
            i64::from_le_bytes(b[16..24].try_into().unwrap()),
            NOW + GROUND_TTL_MS
        );
    }

    #[test]
    fn drops_merge_at_the_same_spot_only() {
        let mut g = GroundItems::default();
        let p = drop_pos([1, 2, 3]);
        assert_eq!(g.drop_at(Item::Dirt, 1, p, NOW), 0);
        assert_eq!(g.drop_at(Item::Dirt, 1, p, NOW + 10), 0);
        assert_eq!(g.slots[0].count, 2);
        assert_eq!(g.slots[0].expires_ms, NOW + 10 + GROUND_TTL_MS);
        assert_eq!(g.drop_at(Item::Dirt, 1, drop_pos([1, 3, 3]), NOW), 1);
        assert_eq!(g.drop_at(Item::Sand, 1, p, NOW), 2);
    }

    #[test]
    fn expired_slots_are_free_and_full_replaces_the_oldest() {
        let mut g = GroundItems::default();
        for i in 0..GROUND_SLOTS as i32 {
            g.drop_at(Item::Dirt, 1, drop_pos([i, 0, 0]), NOW + i as i64);
        }
        // Full: slot 0 expires first.
        assert_eq!(g.drop_at(Item::Sand, 1, drop_pos([0, 9, 0]), NOW + 100), 0);
        assert_eq!(g.slots[0].item, Item::Sand as u16);
        // Once slot 1 has expired it is the first free one.
        let later = NOW + 1 + GROUND_TTL_MS;
        assert!(g.slots[1].live(later).is_none());
        assert_eq!(g.drop_at(Item::Coal, 1, drop_pos([0, 9, 9]), later), 1);
    }

    #[test]
    fn pickup_reach_inventory_and_expiry() {
        let b = [4, 10, 4];
        let mut g = GroundItems::default();
        let i = g.drop_at(Item::Cobblestone, 1, drop_pos(b), NOW);
        let mut inv = Inventory::new();
        // 3 blocks away horizontally: out of reach (2.5).
        let far = feet_at_block([7, 10, 4]);
        assert_eq!(
            g.pickup(i, &mut inv, far, NOW),
            Err(GroundError::OutOfReach)
        );
        // Standing on the block next to it.
        let near = feet_at_block([5, 10, 4]);
        assert_eq!(
            g.pickup(i, &mut inv, near, NOW + GROUND_TTL_MS),
            Err(GroundError::NoItem)
        );
        assert_eq!(g.pickup(i, &mut inv, near, NOW), Ok(1));
        assert_eq!(inv.count(Item::Cobblestone), 1);
        assert_eq!(g.slots[i], GroundItem::default());
        assert_eq!(g.pickup(i, &mut inv, near, NOW), Err(GroundError::NoItem));
        assert_eq!(
            g.pickup(GROUND_SLOTS, &mut inv, near, NOW),
            Err(GroundError::NoItem)
        );
    }

    #[test]
    fn items_fall_to_the_first_solid_block() {
        // Solid at y ≤ 3 and at 7.
        let solid = |y: i32| y <= 3 || y == 7;
        assert_eq!(landing_y(6, solid), 4);
        assert_eq!(landing_y(4, solid), 4);
        assert_eq!(landing_y(9, solid), 8);
        assert_eq!(landing_y(5, |_| false), 0);

        // A log at y 4 broken under items resting on it (y 5) and one higher up (y 6).
        let mut g = GroundItems::default();
        let on = g.drop_at(Item::Dirt, 1, drop_pos([2, 5, -3]), NOW);
        let high = g.drop_at(Item::Sand, 1, drop_pos([2, 6, -3]), NOW);
        let other = g.drop_at(Item::Coal, 1, drop_pos([3, 5, -3]), NOW);
        g.settle_column(2, 4, -3, 1, NOW);
        assert_eq!(g.slots[on].pos, drop_pos([2, 1, -3]));
        assert_eq!(g.slots[high].pos, drop_pos([2, 6, -3]));
        assert_eq!(g.slots[other].pos, drop_pos([3, 5, -3]));
    }

    #[test]
    fn pickup_takes_what_fits() {
        let mut inv = Inventory::new();
        assert_eq!(inv.add(Item::WoodPickaxe, 35), 0); // 35 slots of tools
        inv.add(Item::Dirt, 63);
        let mut g = GroundItems::default();
        let p = drop_pos([0, 0, 0]);
        g.drop_at(Item::Dirt, 3, p, NOW);
        let feet = feet_at_block([0, 0, 0]);
        assert_eq!(g.pickup(0, &mut inv, feet, NOW), Ok(1));
        assert_eq!(g.slots[0].count, 2);
        assert_eq!(
            g.pickup(0, &mut inv, feet, NOW),
            Err(GroundError::InventoryFull)
        );
    }
}
