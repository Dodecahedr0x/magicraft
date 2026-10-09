//! Items, tools and their properties.

use crate::blocks::Block;

/// Tool category.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ToolKind {
    Pickaxe,
    Axe,
    Shovel,
    Sword,
}

/// Tool material tier; ordered `Wood < Stone < Iron < Diamond`.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Tier {
    Wood = 1,
    Stone = 2,
    Iron = 3,
    Diamond = 4,
}

macro_rules! items {
    ($($(#[$m:meta])* $name:ident = $v:expr),* $(,)?) => {
        /// An inventory item id (`u16`).
        ///
        /// Numbering: block items reuse their block's byte (`Item::Stone as u16 == Block::Stone
        /// as u8 as u16`); tools 256..; materials 512..; foods 768..; mob drops 1024..
        /// `0` is never a valid item (empty slot).
        #[repr(u16)]
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum Item {
            $($(#[$m])* $name = $v,)*
        }

        impl Item {
            /// Every item.
            pub const ALL: &'static [Item] = &[$(Item::$name,)*];

            /// Decodes a stored id; `None` for unknown ids.
            pub fn from_u16(v: u16) -> Option<Item> {
                match v {
                    $(x if x == $v => Some(Item::$name),)*
                    _ => None,
                }
            }
        }
    };
}

items! {
    Grass = 1,
    Dirt = 2,
    Stone = 3,
    Cobblestone = 4,
    Sand = 5,
    Sandstone = 6,
    Gravel = 7,
    // 8 = Bedrock: intentionally not an item (unobtainable, must never be placed).
    Log = 9,
    Leaves = 10,
    Planks = 11,
    CoalOre = 12,
    IronOre = 13,
    DiamondOre = 14,
    CraftingTable = 15,
    Furnace = 16,
    Torch = 17,
    Glass = 18,
    IronBlock = 19,
    Snow = 20,
    Ice = 21,
    Cactus = 22,

    WoodPickaxe = 256,
    StonePickaxe = 257,
    IronPickaxe = 258,
    DiamondPickaxe = 259,
    WoodAxe = 260,
    StoneAxe = 261,
    IronAxe = 262,
    DiamondAxe = 263,
    WoodShovel = 264,
    StoneShovel = 265,
    IronShovel = 266,
    DiamondShovel = 267,
    WoodSword = 268,
    StoneSword = 269,
    IronSword = 270,
    DiamondSword = 271,

    Stick = 512,
    Coal = 513,
    IronIngot = 514,
    Diamond = 515,

    RawPork = 768,
    CookedPork = 769,
    RawBeef = 770,
    CookedBeef = 771,
    RawMutton = 772,
    CookedMutton = 773,

    Leather = 1024,
    Wool = 1025,
    RottenFlesh = 1026,
}

impl Item {
    /// Item for a placeable block; `None` for air, water and bedrock.
    pub fn from_block(b: Block) -> Option<Item> {
        Item::from_u16(b as u8 as u16)
    }

    /// Block placed by this item, if it is a block item.
    pub fn as_block(self) -> Option<Block> {
        let v = self as u16;
        if v < 256 {
            Block::from_u8(v as u8)
        } else {
            None
        }
    }

    /// `(kind, tier, attack_damage)` for tools. Bare-hand damage (1) is the caller's concern.
    pub fn tool_info(self) -> Option<(ToolKind, Tier, u8)> {
        let v = self as u16;
        if !(256..=271).contains(&v) {
            return None;
        }
        let i = v - 256;
        let tier = match i % 4 {
            0 => Tier::Wood,
            1 => Tier::Stone,
            2 => Tier::Iron,
            _ => Tier::Diamond,
        };
        // Damage = base + tier - 1: sword 4..7, axe 3..6, pickaxe 2..5, shovel 1..4.
        let (kind, base) = match i / 4 {
            0 => (ToolKind::Pickaxe, 2),
            1 => (ToolKind::Axe, 3),
            2 => (ToolKind::Shovel, 1),
            _ => (ToolKind::Sword, 4),
        };
        Some((kind, tier, base + tier as u8 - 1))
    }

    /// `(kind, tier)` of a tool, for block-breaking helpers.
    pub fn tool(self) -> Option<(ToolKind, Tier)> {
        self.tool_info().map(|(k, t, _)| (k, t))
    }

    /// Maximum stack size: tools 1, everything else 64.
    pub fn max_stack(self) -> u8 {
        if self.tool_info().is_some() {
            1
        } else {
            64
        }
    }

    /// Maximum durability for tools (uses before breaking); 0 for non-tools.
    pub fn max_durability(self) -> u16 {
        match self.tool_info() {
            Some((_, Tier::Wood, _)) => 59,
            Some((_, Tier::Stone, _)) => 131,
            Some((_, Tier::Iron, _)) => 250,
            Some((_, Tier::Diamond, _)) => 1561,
            None => 0,
        }
    }

    /// Food points restored when eaten; `None` if not edible.
    pub fn food_value(self) -> Option<u8> {
        match self {
            Item::RawPork | Item::RawBeef => Some(3),
            Item::CookedPork | Item::CookedBeef => Some(8),
            Item::RawMutton => Some(2),
            Item::CookedMutton => Some(6),
            Item::RottenFlesh => Some(4),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blocks::{is_fluid, Block};

    #[test]
    fn from_u16_round_trips_and_rejects_invalid() {
        for &it in Item::ALL {
            assert_eq!(Item::from_u16(it as u16), Some(it));
        }
        assert_eq!(Item::from_u16(0), None);
        assert_eq!(Item::from_u16(Block::WaterSource as u16), None);
        assert_eq!(Item::from_u16(u16::MAX), None);
        let valid = (0..=u16::MAX)
            .filter(|&v| Item::from_u16(v).is_some())
            .count();
        assert_eq!(valid, Item::ALL.len());
    }

    #[test]
    fn item_block_round_trip() {
        for b in Block::ALL {
            match Item::from_block(b) {
                Some(it) => {
                    assert_eq!(it.as_block(), Some(b));
                    assert_eq!(it as u16, b as u16);
                }
                None => assert!(
                    b == Block::Air || b == Block::Bedrock || is_fluid(b),
                    "{b:?}"
                ),
            }
        }
        assert_eq!(Item::Stick.as_block(), None);
        assert_eq!(Item::WoodPickaxe.as_block(), None);
        for &it in Item::ALL {
            if let Some(b) = it.as_block() {
                assert_eq!(Item::from_block(b), Some(it));
            }
        }
    }

    #[test]
    fn tools_have_durability_and_stack_one() {
        let mut n = 0;
        for &it in Item::ALL {
            if let Some((_, tier, dmg)) = it.tool_info() {
                n += 1;
                assert!(it.max_durability() > 0, "{it:?}");
                assert_eq!(it.max_stack(), 1);
                assert!(dmg >= 1);
                assert_eq!(
                    it.max_durability(),
                    match tier {
                        Tier::Wood => 59,
                        Tier::Stone => 131,
                        Tier::Iron => 250,
                        Tier::Diamond => 1561,
                    }
                );
            } else {
                assert_eq!(it.max_durability(), 0);
                assert_eq!(it.max_stack(), 64);
            }
        }
        assert_eq!(n, 16);
    }

    #[test]
    fn sword_damage_and_tier_order() {
        assert_eq!(
            Item::WoodSword.tool_info(),
            Some((ToolKind::Sword, Tier::Wood, 4))
        );
        assert_eq!(
            Item::StoneSword.tool_info(),
            Some((ToolKind::Sword, Tier::Stone, 5))
        );
        assert_eq!(
            Item::IronSword.tool_info(),
            Some((ToolKind::Sword, Tier::Iron, 6))
        );
        assert_eq!(
            Item::DiamondSword.tool_info(),
            Some((ToolKind::Sword, Tier::Diamond, 7))
        );
        assert_eq!(Item::IronPickaxe.tool_info().unwrap().0, ToolKind::Pickaxe);
        assert!(Item::DiamondAxe.tool_info().unwrap().2 < 7);
        assert!(Tier::Wood < Tier::Stone && Tier::Stone < Tier::Iron && Tier::Iron < Tier::Diamond);
        assert_eq!(Tier::Diamond as u8, 4);
    }

    #[test]
    fn foods() {
        let foods = [
            (Item::RawPork, 3),
            (Item::CookedPork, 8),
            (Item::RawBeef, 3),
            (Item::CookedBeef, 8),
            (Item::RawMutton, 2),
            (Item::CookedMutton, 6),
            (Item::RottenFlesh, 4),
        ];
        for (it, v) in foods {
            assert_eq!(it.food_value(), Some(v), "{it:?}");
        }
        let n = Item::ALL
            .iter()
            .filter(|it| it.food_value().is_some())
            .count();
        assert_eq!(n, foods.len());
        assert_eq!(Item::Leather.food_value(), None);
    }
}
