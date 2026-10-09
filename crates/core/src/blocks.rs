//! Block palette and per-block properties.

use crate::items::{Item, Tier, ToolKind};

/// A block type, stored as one byte per voxel. Discriminants are contiguous from 0, so
/// `Block::ALL[b as usize] == b`. Water is `WaterSource` followed by `Water1..=Water7`.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Block {
    Air = 0,
    Grass = 1,
    Dirt = 2,
    Stone = 3,
    Cobblestone = 4,
    Sand = 5,
    Sandstone = 6,
    Gravel = 7,
    Bedrock = 8,
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
    WaterSource = 23,
    Water1 = 24,
    Water2 = 25,
    Water3 = 26,
    Water4 = 27,
    Water5 = 28,
    Water6 = 29,
    Water7 = 30,
}

impl Block {
    /// Every block, indexed by its discriminant.
    pub const ALL: [Block; 31] = [
        Block::Air,
        Block::Grass,
        Block::Dirt,
        Block::Stone,
        Block::Cobblestone,
        Block::Sand,
        Block::Sandstone,
        Block::Gravel,
        Block::Bedrock,
        Block::Log,
        Block::Leaves,
        Block::Planks,
        Block::CoalOre,
        Block::IronOre,
        Block::DiamondOre,
        Block::CraftingTable,
        Block::Furnace,
        Block::Torch,
        Block::Glass,
        Block::IronBlock,
        Block::Snow,
        Block::Ice,
        Block::Cactus,
        Block::WaterSource,
        Block::Water1,
        Block::Water2,
        Block::Water3,
        Block::Water4,
        Block::Water5,
        Block::Water6,
        Block::Water7,
    ];

    /// Decodes a stored byte; `None` for bytes outside the palette.
    #[inline]
    pub fn from_u8(v: u8) -> Option<Block> {
        Block::ALL.get(v as usize).copied()
    }
}

impl TryFrom<u8> for Block {
    type Error = u8;
    fn try_from(v: u8) -> Result<Self, u8> {
        Block::from_u8(v).ok_or(v)
    }
}

/// Water source or flowing water (`WaterSource..=Water7`).
#[inline]
pub const fn is_fluid(b: Block) -> bool {
    matches!(b as u8, x if x >= Block::WaterSource as u8 && x <= Block::Water7 as u8)
}

/// Blocks entities collide with. Air, water and torches are passable.
#[inline]
pub const fn is_solid(b: Block) -> bool {
    !(matches!(b, Block::Air | Block::Torch) || is_fluid(b))
}

/// Blocks that don't fully occlude neighbours (rendering / light).
#[inline]
pub const fn is_transparent(b: Block) -> bool {
    matches!(
        b,
        Block::Air | Block::Leaves | Block::Glass | Block::Torch | Block::Ice
    ) || is_fluid(b)
}

/// Property bit: entities collide with the block.
pub const SOLID: u8 = 1;
/// Property bit: block does not occlude neighbours.
pub const TRANSPARENT: u8 = 2;
/// Property bit: block is water.
pub const FLUID: u8 = 4;

/// Property flags for every byte value, for hot loops over raw chunk bytes.
/// Bytes outside the palette are treated as solid, opaque and not fluid (fail closed).
pub const BLOCK_FLAGS: [u8; 256] = {
    let mut t = [SOLID; 256];
    let mut i = 0;
    while i < Block::ALL.len() {
        let b = Block::ALL[i];
        t[i] = (if is_solid(b) { SOLID } else { 0 })
            | (if is_transparent(b) { TRANSPARENT } else { 0 })
            | (if is_fluid(b) { FLUID } else { 0 });
        i += 1;
    }
    t
};

/// [`is_solid`] on a raw byte; out-of-palette bytes are solid.
#[inline]
pub fn is_solid_u8(b: u8) -> bool {
    BLOCK_FLAGS[b as usize] & SOLID != 0
}

/// [`is_transparent`] on a raw byte; out-of-palette bytes are opaque.
#[inline]
pub fn is_transparent_u8(b: u8) -> bool {
    BLOCK_FLAGS[b as usize] & TRANSPARENT != 0
}

/// [`is_fluid`] on a raw byte; out-of-palette bytes are not fluid.
#[inline]
pub fn is_fluid_u8(b: u8) -> bool {
    BLOCK_FLAGS[b as usize] & FLUID != 0
}

/// Water level: source = 0, flowing level n = n (1..=7); `None` for non-water.
#[inline]
pub fn water_level(b: Block) -> Option<u8> {
    if is_fluid(b) {
        Some(b as u8 - Block::WaterSource as u8)
    } else {
        None
    }
}

/// Water block for a level (0 = source, 1..=7 flowing). Callers must pass `level <= 7`
/// (debug-asserted); in release the level is masked with `& 7`, so it never panics.
#[inline]
pub fn water_block(level: u8) -> Block {
    debug_assert!(level <= 7, "water level out of range");
    Block::ALL[(Block::WaterSource as u8 + (level & 7)) as usize]
}

/// Bare-hand break time in milliseconds.
///
/// - `0` means "not a break target" (air, water): there is nothing to break.
/// - `u32::MAX` means unbreakable (bedrock).
/// - Every other block returns a positive value.
pub fn hardness_ms(b: Block) -> u32 {
    match b {
        Block::Air => 0,
        Block::Bedrock => u32::MAX,
        Block::Torch => 50,
        Block::Leaves | Block::Snow => 300,
        Block::Glass => 450,
        Block::Cactus => 600,
        Block::Dirt | Block::Sand | Block::Ice => 750,
        Block::Grass | Block::Gravel => 900,
        Block::Log | Block::Planks => 3000,
        Block::CraftingTable => 3750,
        Block::Sandstone => 4000,
        Block::Stone => 7500,
        Block::Cobblestone => 10000,
        Block::CoalOre | Block::IronOre | Block::DiamondOre => 15000,
        Block::Furnace => 17500,
        Block::IronBlock => 25000,
        Block::WaterSource
        | Block::Water1
        | Block::Water2
        | Block::Water3
        | Block::Water4
        | Block::Water5
        | Block::Water6
        | Block::Water7 => 0,
    }
}

/// Minimum tool (kind, tier) needed for the block to drop anything. `None` = any tool / hand.
pub fn required_tool(b: Block) -> Option<(ToolKind, Tier)> {
    match b {
        Block::Stone | Block::Cobblestone | Block::Sandstone | Block::CoalOre | Block::Furnace => {
            Some((ToolKind::Pickaxe, Tier::Wood))
        }
        Block::IronOre | Block::IronBlock => Some((ToolKind::Pickaxe, Tier::Stone)),
        Block::DiamondOre => Some((ToolKind::Pickaxe, Tier::Iron)),
        _ => None,
    }
}

/// Whether breaking `b` with `tool` (`None` = bare hand) yields its drop.
pub fn can_harvest(b: Block, tool: Option<(ToolKind, Tier)>) -> bool {
    match (required_tool(b), tool) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some((rk, rt)), Some((k, t))) => k == rk && t >= rt,
    }
}

/// Tool kind that speeds up breaking `b`.
pub fn preferred_tool(b: Block) -> Option<ToolKind> {
    match b {
        Block::Stone
        | Block::Cobblestone
        | Block::Sandstone
        | Block::CoalOre
        | Block::IronOre
        | Block::DiamondOre
        | Block::Furnace
        | Block::IronBlock
        | Block::Ice => Some(ToolKind::Pickaxe),
        Block::Log | Block::Planks | Block::CraftingTable => Some(ToolKind::Axe),
        Block::Grass | Block::Dirt | Block::Sand | Block::Gravel | Block::Snow => {
            Some(ToolKind::Shovel)
        }
        _ => None,
    }
}

/// Item dropped when `b` is broken (assuming [`can_harvest`] holds; the caller checks it).
/// Leaves, glass, ice, bedrock, air and water drop nothing.
pub fn drop_item(b: Block) -> Option<(Item, u8)> {
    match b {
        Block::Stone => Some((Item::Cobblestone, 1)),
        Block::Grass => Some((Item::Dirt, 1)),
        Block::CoalOre => Some((Item::Coal, 1)),
        Block::DiamondOre => Some((Item::Diamond, 1)),
        Block::Leaves | Block::Glass | Block::Ice => None,
        _ => Item::from_block(b).map(|it| (it, 1)),
    }
}

/// Break-speed multiplier of a tool tier when used on its preferred block kind.
pub fn tier_speed(t: Tier) -> u32 {
    match t {
        Tier::Wood => 2,
        Tier::Stone => 4,
        Tier::Iron => 6,
        Tier::Diamond => 8,
    }
}

/// Break time in ms for the onchain break cooldown; `None` if `b` cannot be broken
/// (air, water, bedrock).
///
/// Formula: `max(1, hardness_ms(b) / f)` where `f = tier_speed(tier)` when the tool's kind
/// equals [`preferred_tool`]`(b)`, otherwise `f = 1` (bare hand or wrong tool). Harvest tier
/// does not affect speed; see [`can_harvest`] for drops.
pub fn break_time_ms(b: Block, tool: Option<(ToolKind, Tier)>) -> Option<u32> {
    let h = hardness_ms(b);
    if h == 0 || h == u32::MAX {
        return None;
    }
    let f = match (tool, preferred_tool(b)) {
        (Some((k, t)), Some(p)) if k == p => tier_speed(t),
        _ => 1,
    };
    Some((h / f).max(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::items::{Item, Tier, ToolKind};

    #[test]
    fn from_u8_round_trips_and_rejects_invalid() {
        for b in Block::ALL {
            assert_eq!(Block::from_u8(b as u8), Some(b));
        }
        for (i, b) in Block::ALL.iter().enumerate() {
            assert_eq!(*b as u8 as usize, i);
        }
        assert_eq!(Block::Air as u8, 0);
        for v in Block::ALL.len()..=255 {
            assert_eq!(Block::from_u8(v as u8), None);
        }
    }

    #[test]
    fn water_blocks_contiguous_and_levels_round_trip() {
        assert_eq!(Block::Water1 as u8, Block::WaterSource as u8 + 1);
        assert_eq!(Block::Water7 as u8, Block::WaterSource as u8 + 7);
        assert_eq!(water_level(Block::WaterSource), Some(0));
        assert_eq!(water_level(Block::Water7), Some(7));
        assert_eq!(water_level(Block::Stone), None);
        for lvl in 0..=7 {
            let b = water_block(lvl);
            assert!(is_fluid(b));
            assert_eq!(water_level(b), Some(lvl));
        }
        assert!(!is_fluid(Block::Air));
        assert!(!is_fluid(Block::Ice));
    }

    #[test]
    fn solidity_and_transparency() {
        assert!(!is_solid(Block::Air));
        assert!(!is_solid(Block::Torch));
        for lvl in 0..=7 {
            assert!(!is_solid(water_block(lvl)));
            assert!(is_transparent(water_block(lvl)));
        }
        for b in [
            Block::Stone,
            Block::Leaves,
            Block::Glass,
            Block::Cactus,
            Block::Bedrock,
        ] {
            assert!(is_solid(b), "{b:?}");
        }
        for b in [
            Block::Air,
            Block::Leaves,
            Block::Glass,
            Block::Torch,
            Block::Ice,
        ] {
            assert!(is_transparent(b), "{b:?}");
        }
        assert!(!is_transparent(Block::Stone));
        assert!(!is_transparent(Block::Dirt));
    }

    #[test]
    fn required_tools() {
        let wood_pick = Some((ToolKind::Pickaxe, Tier::Wood));
        for b in [
            Block::Stone,
            Block::Cobblestone,
            Block::CoalOre,
            Block::Furnace,
            Block::Sandstone,
        ] {
            assert_eq!(required_tool(b), wood_pick, "{b:?}");
        }
        assert_eq!(
            required_tool(Block::IronOre),
            Some((ToolKind::Pickaxe, Tier::Stone))
        );
        assert_eq!(
            required_tool(Block::IronBlock),
            Some((ToolKind::Pickaxe, Tier::Stone))
        );
        assert_eq!(
            required_tool(Block::DiamondOre),
            Some((ToolKind::Pickaxe, Tier::Iron))
        );
        assert_eq!(required_tool(Block::Dirt), None);
        assert_eq!(required_tool(Block::Log), None);
    }

    #[test]
    fn can_harvest_checks_kind_and_tier() {
        assert!(can_harvest(Block::Dirt, None));
        assert!(!can_harvest(Block::Stone, None));
        assert!(!can_harvest(
            Block::Stone,
            Some((ToolKind::Axe, Tier::Diamond))
        ));
        assert!(can_harvest(
            Block::Stone,
            Some((ToolKind::Pickaxe, Tier::Wood))
        ));
        assert!(!can_harvest(
            Block::DiamondOre,
            Some((ToolKind::Pickaxe, Tier::Stone))
        ));
        assert!(can_harvest(
            Block::DiamondOre,
            Some((ToolKind::Pickaxe, Tier::Iron))
        ));
        assert!(can_harvest(
            Block::DiamondOre,
            Some((ToolKind::Pickaxe, Tier::Diamond))
        ));
    }

    #[test]
    fn preferred_tools() {
        assert_eq!(preferred_tool(Block::Stone), Some(ToolKind::Pickaxe));
        assert_eq!(preferred_tool(Block::Log), Some(ToolKind::Axe));
        assert_eq!(preferred_tool(Block::Dirt), Some(ToolKind::Shovel));
        assert_eq!(preferred_tool(Block::Torch), None);
    }

    #[test]
    fn flag_table_matches_enum_for_all_bytes() {
        for v in 0..=255u8 {
            match Block::from_u8(v) {
                Some(b) => {
                    assert_eq!(is_solid_u8(v), is_solid(b), "{b:?}");
                    assert_eq!(is_transparent_u8(v), is_transparent(b), "{b:?}");
                    assert_eq!(is_fluid_u8(v), is_fluid(b), "{b:?}");
                }
                None => {
                    assert!(is_solid_u8(v));
                    assert!(!is_transparent_u8(v));
                    assert!(!is_fluid_u8(v));
                }
            }
        }
    }

    #[test]
    fn drops() {
        assert_eq!(drop_item(Block::Stone), Some((Item::Cobblestone, 1)));
        assert_eq!(drop_item(Block::Grass), Some((Item::Dirt, 1)));
        assert_eq!(drop_item(Block::CoalOre), Some((Item::Coal, 1)));
        assert_eq!(drop_item(Block::DiamondOre), Some((Item::Diamond, 1)));
        assert_eq!(drop_item(Block::IronOre), Some((Item::IronOre, 1)));
        assert_eq!(drop_item(Block::Log), Some((Item::Log, 1)));
        for b in [
            Block::Leaves,
            Block::Glass,
            Block::Ice,
            Block::Air,
            Block::WaterSource,
            Block::Bedrock,
        ] {
            assert_eq!(drop_item(b), None, "{b:?}");
        }
    }

    #[test]
    fn bedrock_air_water_not_breakable() {
        assert_eq!(hardness_ms(Block::Bedrock), u32::MAX);
        assert_eq!(hardness_ms(Block::Air), 0);
        assert_eq!(hardness_ms(Block::WaterSource), 0);
        for b in [
            Block::Bedrock,
            Block::Air,
            Block::WaterSource,
            Block::Water3,
        ] {
            assert_eq!(break_time_ms(b, None), None);
            assert_eq!(
                break_time_ms(b, Some((ToolKind::Pickaxe, Tier::Diamond))),
                None
            );
        }
        for b in Block::ALL {
            if !matches!(b, Block::Bedrock | Block::Air) && !is_fluid(b) {
                let t = break_time_ms(b, None).expect("breakable");
                assert!(t > 0, "{b:?}");
            }
        }
    }

    #[test]
    fn break_time_faster_with_right_tool_and_tier() {
        let hand = break_time_ms(Block::Stone, None).unwrap();
        assert_eq!(hand, hardness_ms(Block::Stone));
        let wrong = break_time_ms(Block::Stone, Some((ToolKind::Shovel, Tier::Diamond))).unwrap();
        assert_eq!(wrong, hand);
        let mut prev = hand;
        for tier in [Tier::Wood, Tier::Stone, Tier::Iron, Tier::Diamond] {
            let t = break_time_ms(Block::Stone, Some((ToolKind::Pickaxe, tier))).unwrap();
            assert!(t < prev, "{tier:?}");
            prev = t;
        }
        assert_eq!(
            break_time_ms(Block::Stone, Some((ToolKind::Pickaxe, Tier::Wood))),
            Some(hand / 2)
        );
        assert!(
            break_time_ms(Block::Log, Some((ToolKind::Axe, Tier::Stone))).unwrap()
                < break_time_ms(Block::Log, None).unwrap()
        );
    }
}
