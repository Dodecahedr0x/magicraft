//! Player inventory: 36 fixed slots stored in the ephemeral `PlayerState` account.
//!
//! Runs onchain inside session-signed ixs (`break_block`, `place_block`, `craft`, `eat`,
//! `attack_mob`, `respawn`), so everything here is total: no panics for any stored bytes,
//! slot index or count; every loop is bounded by [`INV_SLOTS`]; no heap, no floats.
//!
//! # Invariant (normalized slots)
//! An [`Inventory`] can only be built by [`Inventory::new`] / [`Inventory::from_bytes`] and
//! changed by its methods, which all keep every slot **normalized**:
//! - empty ⇔ all six bytes zero ([`Slot::EMPTY`]);
//! - otherwise `item` is a known [`Item`] id, `1 ≤ count ≤ max_stack(item)`, `_pad == 0`;
//! - tools: `count == 1` and `1 ≤ durability ≤ max_durability`; non-tools: `durability == 0`.
//!
//! # Garbage bytes
//! [`Inventory::from_bytes`] never fails: it **normalizes** each slot independently —
//! item `0`/unknown or count `0` → empty; count above the item's max stack → clamped;
//! tool durability `0` → empty (a broken tool), above max → max; non-tool durability and
//! `_pad` → 0. Valid slots are kept byte-identical, so `from_bytes(to_bytes(inv)) == inv`.
//! Garbage can only come from a program bug, so clamping (rather than failing the ix and
//! bricking the player) is the safe choice.
//!
//! # Program duties
//! - Load with [`Inventory::from_bytes`], mutate, store with [`Inventory::to_bytes`].
//! - To test whether something fits without mutating, mutate a copy (it is `Copy`,
//!   [`Inventory::SIZE`] bytes) and compare the leftover.
//! - `break_block` / `attack_mob`: [`Inventory::add`] the drops (leftover is lost or the ix
//!   fails — program policy), then [`Inventory::damage_tool`] on the held slot.
//! - `place_block`: [`Inventory::remove_at`]`(slot, 1)` and place the returned item's block.
//! - `eat(slot)`: [`eat`]. `respawn`: [`Inventory::clear`].
//!
//! # Cost (hand count of SBF ops ≈ CU; not measured on SBF yet)
//! One 36-slot scan is ≈ 36 × 8–12 ≈ 300–450 CU. `count`/`take` = 1–2 scans, `add` = 2 scans,
//! `remove_at`/`damage_tool`/`eat` = O(1) (< 50 CU), `from_bytes` + `to_bytes` ≈ 36 × 25 ≈
//! 900 CU. Frames: an [`Inventory`] is 216 bytes; no function here holds more than one copy
//! plus scalars (< 512 B per frame, far under the 4 KiB SBF limit).

use crate::items::Item;

/// Number of inventory slots (slots 0..9 are the hotbar on the client).
pub const INV_SLOTS: usize = 36;
/// Maximum food level (also the maximum health).
pub const MAX_FOOD: u8 = 20;

/// One inventory slot.
///
/// Byte layout (`repr(C)`, little-endian, align 2, no implicit padding, [`Self::SIZE`] = 6):
///
/// | off | field | type | meaning |
/// |---|---|---|---|
/// | 0 | `item` | u16 | [`Item`] id; 0 = empty |
/// | 2 | `count` | u8 | 1..=max_stack; 0 = empty |
/// | 3 | `_pad` | u8 | 0 |
/// | 4 | `durability` | u16 | tools: remaining uses 1..=max; others 0 |
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Slot {
    pub item: u16,
    pub count: u8,
    pub _pad: u8,
    pub durability: u16,
}

const _: () = assert!(core::mem::size_of::<Slot>() == Slot::SIZE);

impl Slot {
    /// Size in bytes.
    pub const SIZE: usize = 6;
    /// The empty slot (all zero bytes).
    pub const EMPTY: Slot = Slot {
        item: 0,
        count: 0,
        _pad: 0,
        durability: 0,
    };

    /// True for an empty slot.
    pub fn is_empty(&self) -> bool {
        self.item == 0 || self.count == 0
    }

    /// The slot's item, `None` when empty (or not normalized).
    pub fn get_item(&self) -> Option<Item> {
        if self.count == 0 {
            return None;
        }
        Item::from_u16(self.item)
    }

    /// Normalizes per the module docs.
    pub fn normalized(self) -> Slot {
        let Some(it) = self.get_item() else {
            return Slot::EMPTY;
        };
        let max = it.max_durability();
        let durability = if max == 0 {
            0
        } else if self.durability == 0 {
            return Slot::EMPTY; // a broken tool
        } else {
            self.durability.min(max)
        };
        Slot {
            item: self.item,
            count: self.count.min(it.max_stack()),
            _pad: 0,
            durability,
        }
    }
}

/// Inventory errors. Discriminants are stable (the program maps them to its errors).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum InvError {
    /// Slot index ≥ [`INV_SLOTS`].
    BadSlot = 0,
    /// The slot is empty.
    EmptySlot = 1,
    /// The slot holds fewer items than requested.
    NotEnough = 2,
    /// Count of 0.
    InvalidCount = 3,
    /// [`eat`]: the item is not edible.
    NotFood = 4,
    /// [`eat`]: food is already at [`MAX_FOOD`].
    FoodFull = 5,
}

/// 36 normalized slots (see the module docs for the invariant).
///
/// Byte layout: `slots[i]` at offset `6 × i` ([`Slot`] layout), [`Self::SIZE`] = 216.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Inventory {
    slots: [Slot; INV_SLOTS],
}

const _: () = assert!(core::mem::size_of::<Inventory>() == Inventory::SIZE);

impl Default for Inventory {
    fn default() -> Self {
        Self::new()
    }
}

impl Inventory {
    /// Size in bytes.
    pub const SIZE: usize = INV_SLOTS * Slot::SIZE;

    /// An empty inventory.
    pub const fn new() -> Self {
        Inventory {
            slots: [Slot::EMPTY; INV_SLOTS],
        }
    }

    /// Parses and normalizes stored bytes (never fails; see the module docs).
    pub fn from_bytes(b: &[u8; Self::SIZE]) -> Self {
        let mut inv = Inventory::new();
        for (s, c) in inv.slots.iter_mut().zip(b.chunks_exact(Slot::SIZE)) {
            *s = Slot {
                item: u16::from_le_bytes([c[0], c[1]]),
                count: c[2],
                _pad: c[3],
                durability: u16::from_le_bytes([c[4], c[5]]),
            }
            .normalized();
        }
        inv
    }

    /// Little-endian bytes in the documented layout.
    pub fn to_bytes(&self) -> [u8; Self::SIZE] {
        let mut b = [0u8; Self::SIZE];
        for (s, c) in self.slots.iter().zip(b.chunks_exact_mut(Slot::SIZE)) {
            c[0..2].copy_from_slice(&s.item.to_le_bytes());
            c[2] = s.count;
            c[3] = s._pad;
            c[4..6].copy_from_slice(&s.durability.to_le_bytes());
        }
        b
    }

    /// All slots.
    pub fn slots(&self) -> &[Slot; INV_SLOTS] {
        &self.slots
    }

    /// Slot `i`, or `None` if out of range.
    pub fn slot(&self, i: usize) -> Option<Slot> {
        self.slots.get(i).copied()
    }

    /// Empties every slot (respawn).
    pub fn clear(&mut self) {
        self.slots = [Slot::EMPTY; INV_SLOTS];
    }

    /// Total number of `item` across all slots.
    pub fn count(&self, item: Item) -> u32 {
        let id = item as u16;
        self.slots
            .iter()
            .filter(|s| s.item == id)
            .map(|s| s.count as u32)
            .sum()
    }

    /// Adds `n` of `item`; returns how many did not fit.
    ///
    /// Fills existing partial stacks of `item` first (slot order), then empty slots (slot
    /// order). Tools never stack: each goes to its own empty slot with full durability.
    pub fn add(&mut self, item: Item, n: u32) -> u32 {
        let id = item as u16;
        let max = item.max_stack();
        let mut left = n;
        // Partial stacks (never tools: their max stack is 1, so they are never partial).
        for s in self.slots.iter_mut() {
            if left == 0 {
                return 0;
            }
            if s.item == id && s.count < max {
                let k = left.min((max - s.count) as u32);
                s.count += k as u8;
                left -= k;
            }
        }
        // Empty slots.
        for s in self.slots.iter_mut() {
            if left == 0 {
                return 0;
            }
            if s.is_empty() {
                let k = left.min(max as u32);
                *s = Slot {
                    item: id,
                    count: k as u8,
                    _pad: 0,
                    durability: item.max_durability(),
                };
                left -= k;
            }
        }
        left
    }

    /// Removes `n` items from slot `i`; returns the item removed. Atomic: on error nothing
    /// changes. A tool slot is removed whole (`n` must be 1).
    pub fn remove_at(&mut self, i: usize, n: u8) -> Result<Item, InvError> {
        let s = self.slots.get_mut(i).ok_or(InvError::BadSlot)?;
        let item = s.get_item().ok_or(InvError::EmptySlot)?;
        if n == 0 {
            return Err(InvError::InvalidCount);
        }
        if n > s.count {
            return Err(InvError::NotEnough);
        }
        s.count -= n;
        if s.count == 0 {
            *s = Slot::EMPTY;
        }
        Ok(item)
    }

    /// Removes `n` of `item` from the inventory, **last slot first** (keeps the hotbar,
    /// slots 0..9, stocked). Atomic: returns `false` and changes nothing if fewer than `n`
    /// are held. `n == 0` is a no-op returning `true`. Tools are removed regardless of
    /// durability.
    pub fn take(&mut self, item: Item, n: u32) -> bool {
        if self.count(item) < n {
            return false;
        }
        let id = item as u16;
        let mut left = n;
        for s in self.slots.iter_mut().rev() {
            if left == 0 {
                break;
            }
            if s.item == id {
                let k = left.min(s.count as u32);
                s.count -= k as u8;
                left -= k;
                if s.count == 0 {
                    *s = Slot::EMPTY;
                }
            }
        }
        true
    }

    /// Uses one durability of the tool in slot `i`; returns `true` if it broke (the slot is
    /// then cleared). Out-of-range, empty and non-tool slots are left alone (`false`), so
    /// the program can call it unconditionally on the held slot.
    pub fn damage_tool(&mut self, i: usize) -> bool {
        let Some(s) = self.slots.get_mut(i) else {
            return false;
        };
        if s.get_item().is_none_or(|it| it.max_durability() == 0) {
            return false;
        }
        s.durability = s.durability.saturating_sub(1);
        if s.durability == 0 {
            *s = Slot::EMPTY;
            return true;
        }
        false
    }
}

/// Eats the food in slot `i` with current food level `food`: consumes one and returns the
/// new food level `min(MAX_FOOD, food + value)`. Allowed whenever `food < MAX_FOOD`
/// (stored values above the max count as full). Atomic.
pub fn eat(inv: &mut Inventory, i: usize, food: u8) -> Result<u8, InvError> {
    let s = inv.slot(i).ok_or(InvError::BadSlot)?;
    let item = s.get_item().ok_or(InvError::EmptySlot)?;
    let value = item.food_value().ok_or(InvError::NotFood)?;
    if food >= MAX_FOOD {
        return Err(InvError::FoodFull);
    }
    inv.remove_at(i, 1)?;
    Ok(food.saturating_add(value).min(MAX_FOOD))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::hash::splitmix_next;

    /// Checks the normalized-slot invariant.
    pub(crate) fn is_normalized(inv: &Inventory) -> bool {
        inv.slots().iter().all(|s| {
            if *s == Slot::EMPTY {
                return true;
            }
            let Some(it) = Item::from_u16(s.item) else {
                return false;
            };
            if s._pad != 0 || s.count == 0 || s.count > it.max_stack() {
                return false;
            }
            let max = it.max_durability();
            if max > 0 {
                s.count == 1 && (1..=max).contains(&s.durability)
            } else {
                s.durability == 0
            }
        })
    }

    #[test]
    fn layout() {
        assert_eq!(Slot::SIZE, 6);
        assert_eq!(Inventory::SIZE, 216);
        let mut inv = Inventory::new();
        inv.add(Item::Dirt, 5);
        inv.add(Item::WoodPickaxe, 1);
        let b = inv.to_bytes();
        assert_eq!(&b[0..6], &[2, 0, 5, 0, 0, 0]);
        assert_eq!(&b[6..12], &[0, 1, 1, 0, 59, 0]);
        assert!(b[12..].iter().all(|&x| x == 0));
        assert_eq!(Inventory::from_bytes(&b), inv);
        assert_eq!(Inventory::from_bytes(&[0; 216]), Inventory::new());
    }

    #[test]
    fn add_stacks_to_64_then_spills() {
        let mut inv = Inventory::new();
        assert_eq!(inv.add(Item::Dirt, 60), 0);
        assert_eq!(inv.add(Item::Stone, 1), 0);
        assert_eq!(inv.add(Item::Dirt, 10), 0);
        assert_eq!(inv.slot(0).unwrap().count, 64);
        assert_eq!(inv.slot(1).unwrap().item, Item::Stone as u16);
        assert_eq!(inv.slot(2).unwrap().count, 6);
        assert_eq!(inv.count(Item::Dirt), 70);
        // Partial stacks are filled before empty slots, in slot order.
        inv.remove_at(0, 4).unwrap();
        assert_eq!(inv.add(Item::Dirt, 5), 0);
        assert_eq!(inv.slot(0).unwrap().count, 64);
        assert_eq!(inv.slot(2).unwrap().count, 7);
        assert_eq!(inv.add(Item::Dirt, 0), 0);
        assert!(is_normalized(&inv));
    }

    #[test]
    fn add_returns_leftover_when_full() {
        let mut inv = Inventory::new();
        assert_eq!(inv.add(Item::Cobblestone, 36 * 64 - 10), 0);
        assert_eq!(inv.add(Item::Cobblestone, 25), 15);
        assert_eq!(inv.count(Item::Cobblestone), 36 * 64);
        assert_eq!(inv.add(Item::Dirt, 3), 3);
        assert_eq!(inv.add(Item::WoodSword, 1), 1);
        assert_eq!(inv.add(Item::Dirt, u32::MAX), u32::MAX);
        let mut inv = Inventory::new();
        assert_eq!(inv.add(Item::Dirt, u32::MAX), u32::MAX - 36 * 64);
        assert!(is_normalized(&inv));
    }

    #[test]
    fn tools_do_not_stack_and_get_full_durability() {
        let mut inv = Inventory::new();
        assert_eq!(inv.add(Item::IronPickaxe, 3), 0);
        for i in 0..3 {
            let s = inv.slot(i).unwrap();
            assert_eq!((s.item, s.count), (Item::IronPickaxe as u16, 1));
            assert_eq!(s.durability, 250);
        }
        assert_eq!(inv.count(Item::IronPickaxe), 3);
        assert_eq!(inv.add(Item::Dirt, 64 * 33), 0);
        assert_eq!(inv.add(Item::StoneAxe, 2), 2);
        assert!(is_normalized(&inv));
    }

    #[test]
    fn remove_at_is_atomic() {
        let mut inv = Inventory::new();
        inv.add(Item::Torch, 5);
        inv.add(Item::DiamondSword, 1);
        let before = inv;
        assert_eq!(inv.remove_at(0, 6), Err(InvError::NotEnough));
        assert_eq!(inv.remove_at(0, 0), Err(InvError::InvalidCount));
        assert_eq!(inv.remove_at(2, 1), Err(InvError::EmptySlot));
        assert_eq!(inv.remove_at(36, 1), Err(InvError::BadSlot));
        assert_eq!(inv.remove_at(usize::MAX, 1), Err(InvError::BadSlot));
        assert_eq!(inv.remove_at(1, 2), Err(InvError::NotEnough));
        assert_eq!(inv, before);
        assert_eq!(inv.remove_at(0, 2), Ok(Item::Torch));
        assert_eq!(inv.slot(0).unwrap().count, 3);
        assert_eq!(inv.remove_at(0, 3), Ok(Item::Torch));
        assert_eq!(inv.slot(0), Some(Slot::EMPTY));
        assert_eq!(inv.remove_at(1, 1), Ok(Item::DiamondSword));
        assert_eq!(inv, Inventory::new());
    }

    #[test]
    fn take_is_atomic_and_takes_last_slots_first() {
        let mut inv = Inventory::new();
        inv.add(Item::Planks, 64);
        inv.add(Item::Stick, 1);
        inv.add(Item::Planks, 10);
        let before = inv;
        assert!(!inv.take(Item::Planks, 75));
        assert!(!inv.take(Item::Coal, 1));
        assert_eq!(inv, before);
        assert!(inv.take(Item::Planks, 0));
        assert_eq!(inv, before);
        assert!(inv.take(Item::Planks, 12));
        assert_eq!(inv.slot(2), Some(Slot::EMPTY));
        assert_eq!(inv.slot(0).unwrap().count, 62);
        assert!(inv.take(Item::Planks, 62));
        assert!(inv.take(Item::Stick, 1));
        assert_eq!(inv, Inventory::new());
    }

    #[test]
    fn tool_breaks_at_zero_durability() {
        let mut inv = Inventory::new();
        inv.add(Item::Dirt, 1);
        inv.add(Item::WoodPickaxe, 1);
        for k in 1..59u16 {
            assert!(!inv.damage_tool(1));
            assert_eq!(inv.slot(1).unwrap().durability, 59 - k);
        }
        assert!(inv.damage_tool(1));
        assert_eq!(inv.slot(1), Some(Slot::EMPTY));
        // Non-tools, empty and out-of-range slots are untouched.
        let before = inv;
        assert!(!inv.damage_tool(0));
        assert!(!inv.damage_tool(1));
        assert!(!inv.damage_tool(36));
        assert!(!inv.damage_tool(usize::MAX));
        assert_eq!(inv, before);
    }

    #[test]
    fn clear_empties() {
        let mut inv = Inventory::new();
        inv.add(Item::Dirt, 100);
        inv.add(Item::IronSword, 1);
        inv.clear();
        assert_eq!(inv, Inventory::new());
        assert_eq!(inv.to_bytes(), [0; 216]);
    }

    #[test]
    fn normalizes_garbage_slots() {
        let slot = |item: u16, count: u8, pad: u8, dur: u16| {
            let mut b = [0u8; 216];
            b[0..2].copy_from_slice(&item.to_le_bytes());
            b[2] = count;
            b[3] = pad;
            b[4..6].copy_from_slice(&dur.to_le_bytes());
            Inventory::from_bytes(&b).slot(0).unwrap()
        };
        let s = |item: Item, count: u8, durability: u16| Slot {
            item: item as u16,
            count,
            _pad: 0,
            durability,
        };
        assert_eq!(slot(0, 5, 0, 0), Slot::EMPTY);
        assert_eq!(slot(8, 5, 0, 0), Slot::EMPTY); // bedrock
        assert_eq!(slot(9999, 5, 0, 0), Slot::EMPTY);
        assert_eq!(slot(Item::Dirt as u16, 0, 0, 0), Slot::EMPTY);
        assert_eq!(slot(Item::Dirt as u16, 200, 7, 9), s(Item::Dirt, 64, 0));
        assert_eq!(slot(Item::Dirt as u16, 3, 0, 0), s(Item::Dirt, 3, 0));
        assert_eq!(
            slot(Item::WoodAxe as u16, 9, 1, 60),
            s(Item::WoodAxe, 1, 59)
        );
        assert_eq!(slot(Item::WoodAxe as u16, 1, 0, 0), Slot::EMPTY);
        assert_eq!(slot(Item::WoodAxe as u16, 1, 0, 7), s(Item::WoodAxe, 1, 7));
    }

    #[test]
    fn fuzz_garbage_bytes_never_panic() {
        let mut st = 0x1234_5678_9abc_def0u64;
        for round in 0..3000 {
            let mut b = [0u8; 216];
            for chunk in b.chunks_mut(8) {
                let r = splitmix_next(&mut st).to_le_bytes();
                chunk.copy_from_slice(&r[..chunk.len()]);
            }
            // Bias some slots towards valid ids so the valid paths are exercised too.
            for i in 0..INV_SLOTS {
                let r = splitmix_next(&mut st);
                if r.is_multiple_of(3) {
                    let it = Item::ALL[(r >> 8) as usize % Item::ALL.len()];
                    b[i * 6..i * 6 + 2].copy_from_slice(&(it as u16).to_le_bytes());
                }
            }
            let mut inv = Inventory::from_bytes(&b);
            assert!(is_normalized(&inv));
            assert_eq!(Inventory::from_bytes(&inv.to_bytes()), inv);
            let r = splitmix_next(&mut st);
            let it = Item::ALL[r as usize % Item::ALL.len()];
            let i = (r >> 16) as usize % 40;
            inv.add(it, (r >> 24) as u32 % 200);
            let _ = inv.remove_at(i, (r >> 32) as u8);
            let _ = inv.take(it, (r >> 40) as u32 % 100);
            let _ = inv.damage_tool(i);
            let _ = eat(&mut inv, i, (r >> 48) as u8);
            assert!(is_normalized(&inv), "round {round}");
        }
    }

    #[test]
    fn eat_food() {
        let mut inv = Inventory::new();
        inv.add(Item::CookedBeef, 2);
        inv.add(Item::Dirt, 1);
        assert_eq!(eat(&mut inv, 0, 10), Ok(18));
        assert_eq!(inv.count(Item::CookedBeef), 1);
        assert_eq!(eat(&mut inv, 0, 19), Ok(20));
        assert_eq!(inv.slot(0), Some(Slot::EMPTY));
        inv.add(Item::RawMutton, 1);
        let before = inv;
        assert_eq!(eat(&mut inv, 0, 20), Err(InvError::FoodFull));
        assert_eq!(eat(&mut inv, 0, 255), Err(InvError::FoodFull));
        assert_eq!(eat(&mut inv, 1, 0), Err(InvError::NotFood));
        assert_eq!(eat(&mut inv, 2, 0), Err(InvError::EmptySlot));
        assert_eq!(eat(&mut inv, 99, 0), Err(InvError::BadSlot));
        assert_eq!(inv, before);
        assert_eq!(eat(&mut inv, 0, 0), Ok(2));
        assert_eq!(inv.count(Item::RawMutton), 0);
    }
}
