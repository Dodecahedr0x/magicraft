//! Crafting and smelting recipes, and the atomic [`craft`] used by the `craft` ix.
//!
//! Runs onchain inside the session-signed `craft(recipe_id, count)` ix: total (no panics
//! for any id, count or inventory), bounded loops, no heap, no floats.
//!
//! # Recipe ids
//! A recipe's id is its index in [`RECIPES`]. Clients send ids, so **ids are stable: never
//! reorder or remove entries; only append** (a retired recipe would stay as a tombstone).
//! `recipe_ids_are_stable` pins every id. Since recipes are chosen by id (no grid shapes),
//! two recipes may share inputs: the pickaxe and the axe of a tier both take 3 head + 2
//! sticks.
//!
//! # Stations
//! [`Station::None`] recipes craft anywhere (the 2×2 grid). [`Station::Table`] /
//! [`Station::Furnace`] need that block within reach; the program checks the claimed
//! block position and passes the result as [`Stations`]. Furnace smelting is instant.
//!
//! # Fuel
//! Each furnace craft burns [`Recipe::fuel`] fuel units; one unit is one [`Item::Coal`] or,
//! when coal runs out, one [`Item::Planks`]: coal is always used first, then planks make up
//! the rest (so a mix works). Fuel is counted **after** the inputs are taken (no furnace
//! recipe uses coal or planks as input, but this keeps it correct if one ever does).
//!
//! # Atomicity
//! [`craft`] works on a copy of the inventory (216 bytes) and commits only on success, so
//! on any error the inventory is byte-identical. Order of checks / errors: count
//! ([`CraftError::InvalidCount`]), id ([`CraftError::UnknownRecipe`]), station
//! ([`CraftError::WrongStation`]), inputs ([`CraftError::MissingInputs`]), fuel
//! ([`CraftError::MissingFuel`]), output fit ([`CraftError::NoSpace`]; slots freed by the
//! consumed inputs and fuel count as free).
//!
//! # Cost (hand count of SBF ops ≈ CU; not measured on SBF yet)
//! A 36-slot scan ≈ 300–450 CU. One `craft` costs the same for any `count` (amounts are
//! multiplied, not looped): copy 216 B (~60 CU), input pre-check (≤ 2 scans, ≤ 2 inputs),
//! input `take`s (2 scans each), furnace fuel (coal count, planks `take`, coal `take` ≈ 5
//! scans), output `add` (2 scans), commit copy. Worst case (smelting) ≈ 11 scans ≈
//! **4–5k CU**; table/hand crafts ≈ 8 scans ≈ 3–4k CU. Frame: two [`Inventory`] values
//! (432 B) plus scalars (< 1 KiB, far under the 4 KiB SBF limit).

use crate::inventory::Inventory;
use crate::items::Item;

/// Where a recipe can be crafted.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Station {
    /// Anywhere (inventory 2×2 grid).
    None = 0,
    /// Next to a crafting table.
    Table = 1,
    /// Next to a furnace (smelting; burns fuel).
    Furnace = 2,
}

/// Stations within reach of the player (checked by the program).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stations {
    pub table: bool,
    pub furnace: bool,
}

impl Stations {
    /// Whether `s` is available.
    pub fn has(self, s: Station) -> bool {
        match s {
            Station::None => true,
            Station::Table => self.table,
            Station::Furnace => self.furnace,
        }
    }
}

/// One recipe: consumes `inputs` (+ `fuel` units at a furnace) and yields `output`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Recipe {
    /// `(item, amount)` pairs, distinct items.
    pub inputs: &'static [(Item, u8)],
    /// `(item, amount)` produced per craft.
    pub output: (Item, u8),
    pub station: Station,
    /// Fuel units per craft (furnace recipes only; 0 otherwise).
    pub fuel: u8,
}

/// Maximum crafts per `craft` call.
pub const MAX_CRAFT_COUNT: u8 = 64;

/// Craft errors. Discriminants are stable (the program maps them to its errors).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum CraftError {
    /// `recipe_id` ≥ `RECIPES.len()`.
    UnknownRecipe = 0,
    /// The recipe's station is not within reach.
    WrongStation = 1,
    /// Not enough inputs for `count` crafts.
    MissingInputs = 2,
    /// Not enough coal + planks for `count` crafts.
    MissingFuel = 3,
    /// The output does not fit.
    NoSpace = 4,
    /// `count` is 0 or above [`MAX_CRAFT_COUNT`].
    InvalidCount = 5,
}

const fn hand(inputs: &'static [(Item, u8)], output: (Item, u8)) -> Recipe {
    Recipe {
        inputs,
        output,
        station: Station::None,
        fuel: 0,
    }
}

const fn table(inputs: &'static [(Item, u8)], output: (Item, u8)) -> Recipe {
    Recipe {
        inputs,
        output,
        station: Station::Table,
        fuel: 0,
    }
}

const fn smelt(input: &'static [(Item, u8)], output: Item) -> Recipe {
    Recipe {
        inputs: input,
        output: (output, 1),
        station: Station::Furnace,
        fuel: 1,
    }
}

use Item as I;

/// Tool recipe: `head` × `n` + sticks × `sticks`.
macro_rules! tool {
    ($head:ident, $n:expr, $sticks:expr, $out:ident) => {
        table(&[(I::$head, $n), (I::Stick, $sticks)], (I::$out, 1))
    };
}

/// All recipes; **id = index, append-only** (see the module docs).
pub const RECIPES: &[Recipe] = &[
    // 0..=4: basics.
    hand(&[(I::Log, 1)], (I::Planks, 4)),
    hand(&[(I::Planks, 2)], (I::Stick, 4)),
    hand(&[(I::Planks, 4)], (I::CraftingTable, 1)),
    table(&[(I::Cobblestone, 8)], (I::Furnace, 1)),
    hand(&[(I::Coal, 1), (I::Stick, 1)], (I::Torch, 4)),
    // 5..=8: pickaxes (3 head + 2 sticks).
    tool!(Planks, 3, 2, WoodPickaxe),
    tool!(Cobblestone, 3, 2, StonePickaxe),
    tool!(IronIngot, 3, 2, IronPickaxe),
    tool!(Diamond, 3, 2, DiamondPickaxe),
    // 9..=12: axes (3 head + 2 sticks).
    tool!(Planks, 3, 2, WoodAxe),
    tool!(Cobblestone, 3, 2, StoneAxe),
    tool!(IronIngot, 3, 2, IronAxe),
    tool!(Diamond, 3, 2, DiamondAxe),
    // 13..=16: shovels (1 head + 2 sticks).
    tool!(Planks, 1, 2, WoodShovel),
    tool!(Cobblestone, 1, 2, StoneShovel),
    tool!(IronIngot, 1, 2, IronShovel),
    tool!(Diamond, 1, 2, DiamondShovel),
    // 17..=20: swords (2 head + 1 stick).
    tool!(Planks, 2, 1, WoodSword),
    tool!(Cobblestone, 2, 1, StoneSword),
    tool!(IronIngot, 2, 1, IronSword),
    tool!(Diamond, 2, 1, DiamondSword),
    // 21..=25: smelting (1 fuel each).
    smelt(&[(I::Sand, 1)], I::Glass),
    smelt(&[(I::IronOre, 1)], I::IronIngot),
    smelt(&[(I::RawPork, 1)], I::CookedPork),
    smelt(&[(I::RawBeef, 1)], I::CookedBeef),
    smelt(&[(I::RawMutton, 1)], I::CookedMutton),
    // 26: storage block.
    table(&[(I::IronIngot, 9)], (I::IronBlock, 1)),
];

/// Recipe by id.
pub fn recipe(id: u16) -> Option<&'static Recipe> {
    RECIPES.get(id as usize)
}

/// Crafts recipe `recipe_id` `count` times (1..=[`MAX_CRAFT_COUNT`]) with the stations in
/// reach. Atomic: on error the inventory is unchanged (see the module docs).
pub fn craft(
    inv: &mut Inventory,
    recipe_id: u16,
    count: u8,
    near: Stations,
) -> Result<(), CraftError> {
    if count == 0 || count > MAX_CRAFT_COUNT {
        return Err(CraftError::InvalidCount);
    }
    let r = recipe(recipe_id).ok_or(CraftError::UnknownRecipe)?;
    if !near.has(r.station) {
        return Err(CraftError::WrongStation);
    }
    let n = count as u32;
    let mut tmp = *inv;
    // `take` is per item, so check all inputs before taking any (MissingInputs wins over
    // fuel errors); the copy makes every later failure atomic anyway.
    if r.inputs.iter().any(|&(it, k)| tmp.count(it) < k as u32 * n) {
        return Err(CraftError::MissingInputs);
    }
    for &(it, k) in r.inputs {
        tmp.take(it, k as u32 * n);
    }
    let fuel = r.fuel as u32 * n;
    if fuel > 0 {
        let coal = tmp.count(Item::Coal).min(fuel);
        if !tmp.take(Item::Planks, fuel - coal) {
            return Err(CraftError::MissingFuel);
        }
        tmp.take(Item::Coal, coal);
    }
    if tmp.add(r.output.0, r.output.1 as u32 * n) != 0 {
        return Err(CraftError::NoSpace);
    }
    *inv = tmp;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::splitmix_next;
    use crate::inventory::tests::is_normalized;
    use crate::inventory::Slot;
    use crate::items::ToolKind;
    use std::collections::{HashMap, HashSet};

    const ALL: Stations = Stations {
        table: true,
        furnace: true,
    };
    const NONE: Stations = Stations {
        table: false,
        furnace: false,
    };

    fn id_of(out: Item) -> u16 {
        RECIPES.iter().position(|r| r.output.0 == out).unwrap() as u16
    }

    #[test]
    fn recipe_ids_are_stable() {
        use Item::*;
        let expect = [
            Planks,
            Stick,
            CraftingTable,
            Furnace,
            Torch,
            WoodPickaxe,
            StonePickaxe,
            IronPickaxe,
            DiamondPickaxe,
            WoodAxe,
            StoneAxe,
            IronAxe,
            DiamondAxe,
            WoodShovel,
            StoneShovel,
            IronShovel,
            DiamondShovel,
            WoodSword,
            StoneSword,
            IronSword,
            DiamondSword,
            Glass,
            IronIngot,
            CookedPork,
            CookedBeef,
            CookedMutton,
            IronBlock,
        ];
        assert_eq!(RECIPES.len(), expect.len());
        for (i, (r, e)) in RECIPES.iter().zip(expect).enumerate() {
            assert_eq!(r.output.0, e, "recipe id {i} changed");
        }
        assert!(recipe(RECIPES.len() as u16).is_none());
    }

    #[test]
    fn recipe_table_sanity() {
        let mut keys = HashMap::new();
        let mut outputs = HashSet::new();
        for (i, r) in RECIPES.iter().enumerate() {
            let (out, n) = r.output;
            assert_eq!(Item::from_u16(out as u16), Some(out), "{i}");
            assert!(n >= 1 && n <= out.max_stack(), "{i}");
            assert!(!r.inputs.is_empty(), "{i}");
            let mut seen = HashSet::new();
            for &(it, k) in r.inputs {
                assert!(k >= 1, "{i}");
                assert!(seen.insert(it), "duplicate input in {i}");
                assert_ne!(it, out, "{i}");
                assert_eq!(it.max_durability(), 0, "tool input in {i}");
            }
            assert_eq!(r.fuel > 0, r.station == Station::Furnace, "{i}");
            // Any count up to the max never overflows the output count math.
            assert!(n as u32 * MAX_CRAFT_COUNT as u32 <= u16::MAX as u32);
            let mut key: Vec<_> = r.inputs.iter().map(|&(it, k)| (it as u16, k)).collect();
            key.sort();
            // Recipes are picked by id (no grid shapes), so equal inputs are harmless, but
            // the only intended collision is pickaxe vs axe of a tier (both 3 head + 2 sticks).
            if let Some(j) = keys.insert((key, r.station as u8), i) {
                let pair = (RECIPES[j].output.0.tool(), out.tool());
                assert!(
                    matches!(pair, (Some((ToolKind::Pickaxe, a)), Some((ToolKind::Axe, b))) if a == b),
                    "recipes {j} and {i} have the same inputs"
                );
            }
            assert!(outputs.insert(out), "two recipes make {out:?}");
        }
        // Tool recipes give exactly one tool.
        for r in RECIPES {
            if r.output.0.tool().is_some() {
                assert_eq!(r.output.1, 1);
            }
        }
    }

    #[test]
    fn every_tool_reachable_from_raw_resources() {
        // What breaking blocks / killing mobs yields.
        let mut have: HashSet<Item> = [
            Item::Log,
            Item::Cobblestone,
            Item::Sand,
            Item::IronOre,
            Item::Coal,
            Item::Diamond,
            Item::RawPork,
            Item::RawBeef,
            Item::RawMutton,
        ]
        .into_iter()
        .collect();
        loop {
            let before = have.len();
            for r in RECIPES {
                let station_ok = match r.station {
                    Station::None => true,
                    Station::Table => have.contains(&Item::CraftingTable),
                    Station::Furnace => {
                        have.contains(&Item::Furnace)
                            && (have.contains(&Item::Coal) || have.contains(&Item::Planks))
                    }
                };
                if station_ok && r.inputs.iter().all(|(it, _)| have.contains(it)) {
                    have.insert(r.output.0);
                }
            }
            if have.len() == before {
                break;
            }
        }
        for &it in Item::ALL {
            if it.tool().is_some() {
                assert!(have.contains(&it), "{it:?} unreachable");
            }
        }
        for it in [Item::Torch, Item::Glass, Item::IronBlock, Item::CookedBeef] {
            assert!(have.contains(&it), "{it:?} unreachable");
        }
    }

    #[test]
    fn craft_planks_from_log() {
        let mut inv = Inventory::new();
        inv.add(Item::Log, 3);
        assert_eq!(craft(&mut inv, 0, 1, NONE), Ok(()));
        assert_eq!(inv.count(Item::Log), 2);
        assert_eq!(inv.count(Item::Planks), 4);
        assert_eq!(craft(&mut inv, 0, 2, NONE), Ok(()));
        assert_eq!(inv.count(Item::Log), 0);
        assert_eq!(inv.count(Item::Planks), 12);
        // The existing planks stack is topped up; the emptied log slot is cleared.
        assert_eq!(inv.slot(0), Some(Slot::EMPTY));
        assert_eq!(inv.slot(1).unwrap().count, 12);
    }

    #[test]
    fn full_tool_chain() {
        let mut inv = Inventory::new();
        inv.add(Item::Log, 3);
        craft(&mut inv, id_of(Item::Planks), 3, NONE).unwrap(); // 12 planks
        craft(&mut inv, id_of(Item::Stick), 2, NONE).unwrap(); // 8 planks, 8 sticks
        assert_eq!(
            craft(&mut inv, id_of(Item::WoodPickaxe), 1, NONE),
            Err(CraftError::WrongStation)
        );
        craft(&mut inv, id_of(Item::CraftingTable), 1, NONE).unwrap(); // 4 planks
        craft(&mut inv, id_of(Item::WoodPickaxe), 1, ALL).unwrap(); // 1 plank, 6 sticks
        assert_eq!(inv.count(Item::Planks), 1);
        assert_eq!(inv.count(Item::Stick), 6);
        assert_eq!(inv.count(Item::CraftingTable), 1);
        assert_eq!(inv.count(Item::WoodPickaxe), 1);
        inv.add(Item::Cobblestone, 3);
        let tbl = Stations {
            table: true,
            furnace: false,
        };
        craft(&mut inv, id_of(Item::StonePickaxe), 1, tbl).unwrap();
        assert_eq!(inv.count(Item::Cobblestone), 0);
        assert_eq!(inv.count(Item::Stick), 4);
        let s = inv
            .slots()
            .iter()
            .find(|s| s.item == Item::StonePickaxe as u16)
            .unwrap();
        assert_eq!(s.durability, 131);
        assert!(is_normalized(&inv));
    }

    #[test]
    fn insufficient_inputs_leave_inventory_identical() {
        let mut inv = Inventory::new();
        inv.add(Item::Planks, 2);
        inv.add(Item::Stick, 1);
        let before = inv.to_bytes();
        assert_eq!(
            craft(&mut inv, id_of(Item::WoodPickaxe), 1, ALL),
            Err(CraftError::MissingInputs)
        );
        assert_eq!(
            craft(&mut inv, id_of(Item::Stick), 2, ALL),
            Err(CraftError::MissingInputs)
        );
        assert_eq!(inv.to_bytes(), before);
    }

    #[test]
    fn wrong_station_and_bad_args_rejected() {
        let mut inv = Inventory::new();
        inv.add(Item::Cobblestone, 8);
        inv.add(Item::IronOre, 1);
        inv.add(Item::Coal, 1);
        let before = inv;
        let furnace_only = Stations {
            table: false,
            furnace: true,
        };
        let table_only = Stations {
            table: true,
            furnace: false,
        };
        let fur = id_of(Item::Furnace);
        let ingot = id_of(Item::IronIngot);
        assert_eq!(craft(&mut inv, fur, 1, NONE), Err(CraftError::WrongStation));
        assert_eq!(
            craft(&mut inv, fur, 1, furnace_only),
            Err(CraftError::WrongStation)
        );
        assert_eq!(
            craft(&mut inv, ingot, 1, table_only),
            Err(CraftError::WrongStation)
        );
        assert_eq!(
            craft(&mut inv, RECIPES.len() as u16, 1, ALL),
            Err(CraftError::UnknownRecipe)
        );
        assert_eq!(
            craft(&mut inv, u16::MAX, 1, ALL),
            Err(CraftError::UnknownRecipe)
        );
        assert_eq!(craft(&mut inv, fur, 0, ALL), Err(CraftError::InvalidCount));
        assert_eq!(craft(&mut inv, fur, 65, ALL), Err(CraftError::InvalidCount));
        assert_eq!(inv, before);
        assert_eq!(craft(&mut inv, fur, 1, table_only), Ok(()));
        assert_eq!(inv.count(Item::Furnace), 1);
    }

    #[test]
    fn smelt_consumes_ore_and_fuel() {
        let ingot = id_of(Item::IronIngot);
        // Coal preferred over planks.
        let mut inv = Inventory::new();
        inv.add(Item::IronOre, 3);
        inv.add(Item::Planks, 5);
        inv.add(Item::Coal, 2);
        craft(&mut inv, ingot, 1, ALL).unwrap();
        assert_eq!(inv.count(Item::IronOre), 2);
        assert_eq!(inv.count(Item::IronIngot), 1);
        assert_eq!(inv.count(Item::Coal), 1);
        assert_eq!(inv.count(Item::Planks), 5);
        // Mixed: 1 coal then 1 plank.
        craft(&mut inv, ingot, 2, ALL).unwrap();
        assert_eq!(inv.count(Item::IronOre), 0);
        assert_eq!(inv.count(Item::IronIngot), 3);
        assert_eq!(inv.count(Item::Coal), 0);
        assert_eq!(inv.count(Item::Planks), 4);
        // Planks-only fallback.
        inv.add(Item::Sand, 4);
        craft(&mut inv, id_of(Item::Glass), 4, ALL).unwrap();
        assert_eq!(inv.count(Item::Glass), 4);
        assert_eq!(inv.count(Item::Planks), 0);
        // No fuel.
        inv.add(Item::RawBeef, 1);
        let before = inv;
        assert_eq!(
            craft(&mut inv, id_of(Item::CookedBeef), 1, ALL),
            Err(CraftError::MissingFuel)
        );
        assert_eq!(inv, before);
        // Not enough fuel for the whole count: nothing happens.
        inv.add(Item::Coal, 1);
        inv.add(Item::RawBeef, 1);
        let before = inv;
        assert_eq!(
            craft(&mut inv, id_of(Item::CookedBeef), 2, ALL),
            Err(CraftError::MissingFuel)
        );
        assert_eq!(inv, before);
        assert_eq!(craft(&mut inv, id_of(Item::CookedBeef), 1, ALL), Ok(()));
        assert_eq!(inv.count(Item::CookedBeef), 1);
    }

    #[test]
    fn no_space_leaves_inventory_unchanged() {
        let mut inv = Inventory::new();
        // Full: 34 slots of dirt, 64 planks, 64 sticks.
        inv.add(Item::Dirt, 34 * 64);
        inv.add(Item::Planks, 64);
        inv.add(Item::Stick, 64);
        let before = inv.to_bytes();
        // 2 planks → 4 sticks: stick stack is full and no slot is freed.
        assert_eq!(
            craft(&mut inv, id_of(Item::Stick), 1, ALL),
            Err(CraftError::NoSpace)
        );
        // Table: 4 planks → table, no slot for it.
        assert_eq!(
            craft(&mut inv, id_of(Item::CraftingTable), 1, ALL),
            Err(CraftError::NoSpace)
        );
        assert_eq!(inv.to_bytes(), before);
        // Consuming a whole stack frees its slot for the output.
        assert_eq!(craft(&mut inv, id_of(Item::CraftingTable), 16, ALL), Ok(()));
        assert_eq!(inv.count(Item::CraftingTable), 16);
        assert_eq!(inv.count(Item::Planks), 0);
    }

    #[test]
    fn multiple_crafts_are_atomic() {
        let mut inv = Inventory::new();
        inv.add(Item::Planks, 9);
        inv.add(Item::Stick, 5);
        let before = inv;
        // 3 swords need 6 planks + 3 sticks and 3 slots; 4 need 8 + 4; 5 need 10 planks.
        assert_eq!(
            craft(&mut inv, id_of(Item::WoodSword), 5, ALL),
            Err(CraftError::MissingInputs)
        );
        assert_eq!(inv, before);
        assert_eq!(craft(&mut inv, id_of(Item::WoodSword), 4, ALL), Ok(()));
        assert_eq!(inv.count(Item::WoodSword), 4);
        assert_eq!(inv.count(Item::Planks), 1);
        assert_eq!(inv.count(Item::Stick), 1);
        // Torches: output 4 × 64 = 256 spans several stacks.
        let mut inv = Inventory::new();
        inv.add(Item::Coal, 64);
        inv.add(Item::Stick, 64);
        assert_eq!(craft(&mut inv, id_of(Item::Torch), 64, NONE), Ok(()));
        assert_eq!(inv.count(Item::Torch), 256);
        assert_eq!(inv.count(Item::Coal) + inv.count(Item::Stick), 0);
        assert!(is_normalized(&inv));
        // Tools need one free slot each.
        let mut inv = Inventory::new();
        inv.add(Item::Dirt, 32 * 64);
        inv.add(Item::Diamond, 64);
        inv.add(Item::Stick, 64);
        let before = inv;
        // 34 slots used, 2 free: 3 swords don't fit, 2 do.
        assert_eq!(
            craft(&mut inv, id_of(Item::DiamondSword), 3, ALL),
            Err(CraftError::NoSpace)
        );
        assert_eq!(inv, before);
        assert_eq!(craft(&mut inv, id_of(Item::DiamondSword), 2, ALL), Ok(()));
    }

    #[test]
    fn fuzz_craft_never_panics() {
        let mut st = 42u64;
        for _ in 0..2000 {
            let mut b = [0u8; Inventory::SIZE];
            for i in 0..36 {
                let r = splitmix_next(&mut st);
                let it = Item::ALL[r as usize % Item::ALL.len()];
                b[i * 6..i * 6 + 2].copy_from_slice(&(it as u16).to_le_bytes());
                b[i * 6 + 2] = (r >> 32) as u8;
                b[i * 6 + 4] = (r >> 40) as u8;
            }
            let mut inv = Inventory::from_bytes(&b);
            let r = splitmix_next(&mut st);
            let before = inv;
            let near = Stations {
                table: r & 1 != 0,
                furnace: r & 2 != 0,
            };
            let res = craft(&mut inv, (r >> 8) as u16 % 30, (r >> 24) as u8 % 70, near);
            if res.is_err() {
                assert_eq!(inv, before);
            }
            assert!(is_normalized(&inv));
        }
    }
}
