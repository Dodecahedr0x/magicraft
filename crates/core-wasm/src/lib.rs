//! `magicraft-core` for the browser client (wasm-bindgen).
//!
//! The client runs its own 60 fps physics and sends `move_player` at ~8 Hz; before sending
//! it runs the **same** [`physics::check_move`] the program runs, against its local copy of
//! the 2×2 chunk window, so a move the chain would reject is caught (and fixed: an earlier
//! frame is sent, or the player snaps back) without a round trip.
//!
//! Build: `pnpm -C app build:wasm` (wasm-pack, `--target web`, release profile with
//! `overflow-checks = false` like the program's build of the core; see the root
//! `Cargo.toml` and `docs/notes/versions.md`). Output: `app/src/wasm/pkg/` (committed).
//!
//! Byte layouts are the core's: [`WorldParams`] (48 B, the `World.params` bytes) and
//! [`MoveState`] (72 B, the `PlayerState.move_state` bytes).

use magicraft_core::blocks::{self as blk, Block, BLOCK_FLAGS};
use magicraft_core::consts::CHUNK_VOL;
use magicraft_core::inventory::Inventory;
use magicraft_core::items::{Item, Tier, ToolKind};
use magicraft_core::physics::{self, ChunkQuad, MoveState, WorldParams};
use magicraft_core::recipes::{self, Stations, MAX_CRAFT_COUNT, RECIPES};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

/// [`check_move`] result code: accepted.
pub const OK: u8 = 0;
/// [`check_move`] result code: malformed input (buffer lengths).
pub const BAD_INPUT: u8 = 255;
/// Length of the [`check_move`] result: `[code, fall_damage, state (72 B)]`.
pub const RESULT_LEN: usize = 2 + MoveState::SIZE;

fn params_of(b: &[u8]) -> Option<WorldParams> {
    Some(WorldParams::from_bytes(b.try_into().ok()?))
}

/// Runs `physics::check_move` on a 2×2 chunk window.
///
/// - `params`: 48 B `WorldParams`; `prev`: 72 B `MoveState` (the last accepted state).
/// - `pos`, `vel`: 3 × i32 (FP feet center, FP/s).
/// - `client_ms`, `chain_ms`: ms as f64 (integral; cast to i64, saturating).
/// - `(cx0, cz0)`: window origin (`physics::move_window(prev.pos, pos)`); `quad`: 4 ×
///   16 384 block bytes in slot order `(cx0, cz0)`, `(cx0+1, cz0)`, `(cx0, cz0+1)`,
///   `(cx0+1, cz0+1)`; bit `i` of `mask` set = slot `i` present (absent slots read as
///   Stone, like chunks the program is not passed).
///
/// Returns `[code, fall_damage, new state (72 B)]`: code [`OK`], `1 + MoveError`
/// discriminant (1 MoveTooFast, 2 Collision, 3 NotOnGround, 4 Flying, 5 InvalidState,
/// 6 TimeSkew) or [`BAD_INPUT`]; state bytes are zero unless accepted.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn check_move(
    params: &[u8],
    prev: &[u8],
    pos: &[i32],
    vel: &[i32],
    on_ground: bool,
    client_ms: f64,
    chain_ms: f64,
    cx0: i32,
    cz0: i32,
    quad: &[u8],
    mask: u8,
) -> Vec<u8> {
    let mut out = vec![0u8; RESULT_LEN];
    let (Some(p), Ok(prev), Ok(pos), Ok(vel)) = (
        params_of(params),
        <&[u8; MoveState::SIZE]>::try_from(prev),
        <[i32; 3]>::try_from(pos),
        <[i32; 3]>::try_from(vel),
    ) else {
        out[0] = BAD_INPUT;
        return out;
    };
    if quad.len() != 4 * CHUNK_VOL {
        out[0] = BAD_INPUT;
        return out;
    }
    let prev = match MoveState::from_bytes(prev) {
        Ok(s) => s,
        Err(e) => {
            out[0] = 1 + e as u8;
            return out;
        }
    };
    let slot = |i: usize| -> Option<&[u8; CHUNK_VOL]> {
        if mask & (1 << i) == 0 {
            return None;
        }
        quad[i * CHUNK_VOL..(i + 1) * CHUNK_VOL].try_into().ok()
    };
    let q = ChunkQuad::new(cx0, cz0, [slot(0), slot(1), slot(2), slot(3)]);
    match physics::check_move(
        &p,
        &prev,
        pos,
        vel,
        on_ground,
        client_ms as i64,
        chain_ms as i64,
        &q,
    ) {
        Ok(o) => {
            out[0] = OK;
            out[1] = o.fall_damage;
            out[2..].copy_from_slice(&o.state.to_bytes());
        }
        Err(e) => out[0] = 1 + e as u8,
    }
    out
}

thread_local! {
    /// Persistent 2×2 window for [`check_move_stored`] (filled by [`set_quad_slot`]), so a
    /// caller trying many candidate positions in one window uploads the chunks once.
    static QUAD: RefCell<Vec<u8>> = RefCell::new(vec![0u8; 4 * CHUNK_VOL]);
}

/// Copies `blocks` (16 384 B) into slot `i` (0..4) of the stored window; false on bad input.
#[wasm_bindgen]
pub fn set_quad_slot(i: usize, blocks: &[u8]) -> bool {
    if i >= 4 || blocks.len() != CHUNK_VOL {
        return false;
    }
    QUAD.with(|q| q.borrow_mut()[i * CHUNK_VOL..(i + 1) * CHUNK_VOL].copy_from_slice(blocks));
    true
}

/// [`check_move`] against the stored window (see [`set_quad_slot`]); `mask` bit `i` =
/// slot `i` holds a chunk.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn check_move_stored(
    params: &[u8],
    prev: &[u8],
    pos: &[i32],
    vel: &[i32],
    on_ground: bool,
    client_ms: f64,
    chain_ms: f64,
    cx0: i32,
    cz0: i32,
    mask: u8,
) -> Vec<u8> {
    QUAD.with(|q| {
        check_move(
            params,
            prev,
            pos,
            vel,
            on_ground,
            client_ms,
            chain_ms,
            cx0,
            cz0,
            &q.borrow(),
            mask,
        )
    })
}

/// FNV-1a 64 (hex) of the core + wrapper sources this build was made from (`build.rs`).
#[wasm_bindgen]
pub fn core_src_hash() -> String {
    env!("CORE_SRC_HASH").to_string()
}

/// Physics constants the client mirrors: `[HALF_W, FEET_EPS, BODY_H, GROUND_HALF_W,
/// GROUND_EPS, LEAD_MS, LAG_MS]`.
#[wasm_bindgen]
pub fn physics_constants() -> Vec<i32> {
    vec![
        physics::HALF_W,
        physics::FEET_EPS,
        physics::BODY_H,
        physics::GROUND_HALF_W,
        physics::GROUND_EPS,
        physics::LEAD_MS as i32,
        physics::LAG_MS as i32,
    ]
}

/// `physics::move_window(a, b)` → `[cx0, cz0]`, or empty if the move spans more chunks.
#[wasm_bindgen]
pub fn move_window(a: &[i32], b: &[i32]) -> Vec<i32> {
    match (<[i32; 3]>::try_from(a), <[i32; 3]>::try_from(b)) {
        (Ok(a), Ok(b)) => physics::move_window(a, b).map_or(vec![], |(x, z)| vec![x, z]),
        _ => vec![],
    }
}

/// `blocks::BLOCK_FLAGS` (256 B; bit 1 solid, 2 transparent, 4 fluid).
#[wasm_bindgen]
pub fn block_flags() -> Vec<u8> {
    BLOCK_FLAGS.to_vec()
}

/// `WorldParams::default()` bytes (48 B).
#[wasm_bindgen]
pub fn default_params() -> Vec<u8> {
    WorldParams::default().to_bytes().to_vec()
}

/// `WorldParams::validate`: −1 if valid, else the `ParamError` discriminant
/// (BAD_INPUT as i32 for a wrong length).
#[wasm_bindgen]
pub fn validate_params(params: &[u8]) -> i32 {
    match params_of(params) {
        Some(p) => p.validate().map_or_else(|e| e as i32, |_| -1),
        None => BAD_INPUT as i32,
    }
}

/// `MoveState::spawn(pos, now_ms)` bytes (72 B), optionally on ground.
#[wasm_bindgen]
pub fn spawn_state(pos: &[i32], now_ms: f64, on_ground: bool) -> Vec<u8> {
    let pos = <[i32; 3]>::try_from(pos).unwrap_or([0; 3]);
    MoveState {
        on_ground,
        ..MoveState::spawn(pos, now_ms as i64)
    }
    .to_bytes()
    .to_vec()
}

/// Rules version of the core this build wraps (`magicraft_core::version`).
#[wasm_bindgen]
pub fn core_version() -> u32 {
    magicraft_core::version()
}

// ---------------------------------------------------------------- items / blocks / recipes
// The interaction UI (Task 26) uses the core's own tables so mining progress, tool info and
// recipe filtering match what `break_block` / `craft` will do.

/// The tool of item id `item` (0 / unknown / non-tool = bare hand).
fn tool_of(item: u16) -> Option<(ToolKind, Tier)> {
    Item::from_u16(item).and_then(|it| it.tool())
}

/// `blocks::break_time_ms(block, tool of item)` in ms; 0 = not breakable (air, water,
/// bedrock, unknown byte). `item` 0 = bare hand.
#[wasm_bindgen]
pub fn break_time_ms(block: u8, item: u16) -> u32 {
    Block::from_u8(block)
        .and_then(|b| blk::break_time_ms(b, tool_of(item)))
        .unwrap_or(0)
}

/// `blocks::can_harvest(block, tool of item)` (false for unknown bytes).
#[wasm_bindgen]
pub fn can_harvest(block: u8, item: u16) -> bool {
    Block::from_u8(block).is_some_and(|b| blk::can_harvest(b, tool_of(item)))
}

/// `blocks::drop_item(block)` as `[item, count]`, or empty if it drops nothing.
#[wasm_bindgen]
pub fn drop_item(block: u8) -> Vec<u16> {
    Block::from_u8(block)
        .and_then(blk::drop_item)
        .map_or(vec![], |(it, n)| vec![it as u16, n as u16])
}

/// Every item id (`Item::ALL`).
#[wasm_bindgen]
pub fn item_ids() -> Vec<u16> {
    Item::ALL.iter().map(|&it| it as u16).collect()
}

/// Properties of item `id`: `[block (−1 = not placeable), tool kind (−1 none; 0 pickaxe,
/// 1 axe, 2 shovel, 3 sword), tier (0 none, 1..=4), attack damage (1 = fist for
/// non-tools), max stack, max durability, food value (−1 not edible)]`; empty if unknown.
#[wasm_bindgen]
pub fn item_info(id: u16) -> Vec<i32> {
    let Some(it) = Item::from_u16(id) else {
        return vec![];
    };
    let (kind, tier, dmg) = it.tool_info().map_or((-1, 0, 1), |(k, t, d)| {
        let k = match k {
            ToolKind::Pickaxe => 0,
            ToolKind::Axe => 1,
            ToolKind::Shovel => 2,
            ToolKind::Sword => 3,
        };
        (k, t as i32, d as i32)
    });
    vec![
        it.as_block().map_or(-1, |b| b as i32),
        kind,
        tier,
        dmg,
        it.max_stack() as i32,
        it.max_durability() as i32,
        it.food_value().map_or(-1, |v| v as i32),
    ]
}

/// `recipes::RECIPES` flattened, in id order: per recipe `[n_inputs, (item, amount) ×
/// n_inputs, output item, output amount, station (0 none, 1 table, 2 furnace), fuel]`.
#[wasm_bindgen]
pub fn recipe_table() -> Vec<u16> {
    let mut out = Vec::new();
    for r in RECIPES {
        out.push(r.inputs.len() as u16);
        for &(it, k) in r.inputs {
            out.push(it as u16);
            out.push(k as u16);
        }
        out.push(r.output.0 as u16);
        out.push(r.output.1 as u16);
        out.push(r.station as u16);
        out.push(r.fuel as u16);
    }
    out
}

fn inventory_of(b: &[u8]) -> Option<Inventory> {
    Some(Inventory::from_bytes(b.try_into().ok()?))
}

/// `recipes::craft` on a copy of `inv` (216 B, the `PlayerState` inventory bytes):
/// `[code, inventory after (216 B)]`; code 0 = ok, `1 + CraftError` discriminant
/// (1 UnknownRecipe, 2 WrongStation, 3 MissingInputs, 4 MissingFuel, 5 NoSpace,
/// 6 InvalidCount) or [`BAD_INPUT`] (then no inventory follows).
#[wasm_bindgen]
pub fn craft(inv: &[u8], recipe_id: u16, count: u8, table: bool, furnace: bool) -> Vec<u8> {
    let Some(mut inv) = inventory_of(inv) else {
        return vec![BAD_INPUT];
    };
    let near = Stations { table, furnace };
    let code = match recipes::craft(&mut inv, recipe_id, count, near) {
        Ok(()) => 0,
        Err(e) => 1 + e as u8,
    };
    let mut out = vec![code];
    out.extend_from_slice(&inv.to_bytes());
    out
}

/// The largest `count` (0..=[`MAX_CRAFT_COUNT`]) for which [`craft`] succeeds. Not
/// monotonic in `count` (consuming a whole input stack frees its slot for the output, so
/// e.g. 16 tables from 64 planks fit a full inventory while 15 don't), hence a linear scan
/// from the top (≤ 64 core crafts on a 216-byte copy each).
#[wasm_bindgen]
pub fn max_crafts(inv: &[u8], recipe_id: u16, table: bool, furnace: bool) -> u8 {
    let Some(inv) = inventory_of(inv) else {
        return 0;
    };
    let near = Stations { table, furnace };
    (1..=MAX_CRAFT_COUNT)
        .rev()
        .find(|&n| {
            let mut tmp = inv;
            recipes::craft(&mut tmp, recipe_id, n, near).is_ok()
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use magicraft_core::blocks::Block;
    use magicraft_core::coords::block_index;

    /// Flat world: stone below y = 10 in every chunk.
    fn flat() -> Vec<u8> {
        let mut c = vec![0u8; CHUNK_VOL];
        for y in 0..10 {
            for z in 0..16 {
                for x in 0..16 {
                    c[block_index(x, y, z)] = Block::Stone as u8;
                }
            }
        }
        c.repeat(4)
    }

    const HOME: [i32; 3] = [5 * 256 + 128, 10 * 256, 5 * 256 + 128];

    #[test]
    fn walk_accepted_and_state_returned() {
        let p = default_params();
        let prev = spawn_state(&HOME, 1000.0, true);
        let q = flat();
        let r = check_move(
            &p,
            &prev,
            &[HOME[0] + 100, HOME[1], HOME[2]],
            &[0; 3],
            true,
            1125.0,
            1125.0,
            0,
            0,
            &q,
            0b1111,
        );
        assert_eq!(r.len(), RESULT_LEN);
        assert_eq!(r[0], OK);
        let st = MoveState::from_bytes(r[2..].try_into().unwrap()).unwrap();
        assert_eq!(st.pos, [HOME[0] + 100, HOME[1], HOME[2]]);
        assert_eq!(st.last_ms, 1125);
        assert!(st.on_ground);
    }

    #[test]
    fn errors_and_missing_slots() {
        let p = default_params();
        let prev = spawn_state(&HOME, 1000.0, true);
        let q = flat();
        // Teleport.
        let r = check_move(
            &p,
            &prev,
            &[HOME[0] + 3000, HOME[1], HOME[2]],
            &[0; 3],
            true,
            1125.0,
            1125.0,
            0,
            0,
            &q,
            15,
        );
        assert_eq!(r[0], 1);
        // Own slot missing: reads Stone → Collision.
        let r = check_move(
            &p, &prev, &HOME, &[0; 3], true, 1125.0, 1125.0, 0, 0, &q, 0b1110,
        );
        assert_eq!(r[0], 2);
        // Time not advancing.
        let r = check_move(
            &p, &prev, &HOME, &[0; 3], true, 1000.0, 1125.0, 0, 0, &q, 15,
        );
        assert_eq!(r[0], 6);
        // Bad lengths.
        assert_eq!(
            check_move(
                &p[..47],
                &prev,
                &HOME,
                &[0; 3],
                true,
                1.0,
                1.0,
                0,
                0,
                &q,
                15
            )[0],
            BAD_INPUT
        );
        assert_eq!(
            check_move(
                &p,
                &prev,
                &HOME,
                &[0; 3],
                true,
                1125.0,
                1125.0,
                0,
                0,
                &q[1..],
                15
            )[0],
            BAD_INPUT
        );
    }

    #[test]
    fn stored_quad_matches() {
        let p = default_params();
        let prev = spawn_state(&HOME, 1000.0, true);
        let q = flat();
        for i in 0..4 {
            assert!(set_quad_slot(i, &q[i * CHUNK_VOL..(i + 1) * CHUNK_VOL]));
        }
        assert!(!set_quad_slot(4, &q[..CHUNK_VOL]));
        let pos = [HOME[0] + 100, HOME[1], HOME[2]];
        let a = check_move(&p, &prev, &pos, &[0; 3], true, 1125.0, 1125.0, 0, 0, &q, 15);
        let b = check_move_stored(&p, &prev, &pos, &[0; 3], true, 1125.0, 1125.0, 0, 0, 15);
        assert_eq!(a, b);
        assert_eq!(core_src_hash().len(), 16);
        assert_eq!(physics_constants()[3], 78);
    }

    #[test]
    fn helpers() {
        assert_eq!(validate_params(&default_params()), -1);
        assert_eq!(move_window(&HOME, &HOME), vec![0, 0]);
        assert_eq!(
            move_window(&[128, 0, 128], &[40 * 256, 0, 128]),
            Vec::<i32>::new()
        );
        assert_eq!(block_flags()[Block::Stone as usize] & 1, 1);
        assert_eq!(block_flags()[Block::WaterSource as usize] & 4, 4);
    }

    #[test]
    fn items_blocks_recipes() {
        let wood_pick = Item::WoodPickaxe as u16;
        assert_eq!(break_time_ms(Block::Stone as u8, 0), 7500);
        assert_eq!(break_time_ms(Block::Stone as u8, wood_pick), 3750);
        assert_eq!(break_time_ms(Block::Stone as u8, Item::Dirt as u16), 7500);
        assert_eq!(break_time_ms(Block::Bedrock as u8, wood_pick), 0);
        assert_eq!(break_time_ms(Block::Air as u8, 0), 0);
        assert_eq!(break_time_ms(200, 0), 0);
        assert!(!can_harvest(Block::Stone as u8, 0));
        assert!(can_harvest(Block::Stone as u8, wood_pick));
        assert_eq!(
            drop_item(Block::Stone as u8),
            vec![Item::Cobblestone as u16, 1]
        );
        assert!(drop_item(Block::Leaves as u8).is_empty());
        assert_eq!(item_ids().len(), Item::ALL.len());
        assert_eq!(item_info(wood_pick), vec![-1, 0, 1, 2, 1, 59, -1]);
        assert_eq!(
            item_info(Item::Planks as u16),
            vec![11, -1, 0, 1, 64, 0, -1]
        );
        assert_eq!(item_info(Item::CookedBeef as u16)[6], 8);
        assert!(item_info(8).is_empty());
        let t = recipe_table();
        // Recipe 0: 1 input (log × 1) → planks × 4, no station, no fuel.
        assert_eq!(
            &t[..7],
            &[1, Item::Log as u16, 1, Item::Planks as u16, 4, 0, 0]
        );

        let mut inv = Inventory::new();
        inv.add(Item::Log, 3);
        let b = inv.to_bytes();
        assert_eq!(max_crafts(&b, 0, false, false), 3);
        assert_eq!(max_crafts(&b, 5, true, false), 0);
        let r = craft(&b, 0, 2, false, false);
        assert_eq!(r[0], 0);
        let after = Inventory::from_bytes(r[1..].try_into().unwrap());
        assert_eq!(after.count(Item::Planks), 8);
        assert_eq!(craft(&b, 0, 4, false, false)[0], 3); // MissingInputs
        assert_eq!(craft(&b, 3, 1, false, false)[0], 2); // furnace needs a table
        assert_eq!(craft(&b[1..], 0, 1, false, false), vec![BAD_INPUT]);

        // Not monotonic: a full inventory with 64 planks fits 16 tables (the planks slot is
        // freed) but not 1..=15.
        let mut full = Inventory::new();
        full.add(Item::Dirt, 35 * 64);
        full.add(Item::Planks, 64);
        let fb = full.to_bytes();
        assert_eq!(craft(&fb, 2, 15, false, false)[0], 5); // NoSpace
        assert_eq!(craft(&fb, 2, 16, false, false)[0], 0);
        assert_eq!(max_crafts(&fb, 2, false, false), 16);
    }
}
