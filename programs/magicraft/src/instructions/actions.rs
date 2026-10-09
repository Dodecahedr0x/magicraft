//! Player actions: `break_block`, `place_block`, `select_slot`, `craft`, `attack_mob`,
//! `eat`, `respawn`. All delegate the rules to `magicraft-core`.
//!
//! # Common to every action
//! - Session auth: `#[session_auth_or(player.authority == signer, Unauthorized)]` with an
//!   optional `SessionTokenV2` (same pattern as `move_player`).
//! - `player` is any `Player` account (owner + discriminator); it is tied to the caller by
//!   `player_state.player == player` (only `join_world` writes that field, at the PDA of the
//!   pair it stores), so no PDA derivation (~1.5k CU) is needed: the Player is never a
//!   signer or rent sponsor here, and it is passed **read-only**.
//! - `World` is read-only (params, spawn, seed, chain time via `World::chain_ms_ro`).
//! - Dead players (`health == 0`) are rejected with `Dead`, except by `respawn`.
//! - Positions come from the stored `MoveState` (the last accepted move).
//!
//! # Reach
//! From the eye (feet + [`EYE_FP`], 1.62 blocks) to the block center, squared in `u64`
//! (no division, no signed multiply): `≤ params.reach +` [`REACH_SLACK_FP`] (0.5 block: the
//! stored position lags the client's by up to one move). Mobs: [`ATTACK_REACH_FP`] (3
//! blocks, the design's fixed melee reach) + slack, to the nearest point of the mob's
//! 2-block point column. There is **no line-of-sight check**: every chunk's blocks are
//! public account data anyway, so hiding a block behind a wall protects nothing.
//!
//! # `break_block(x, y, z)` — cooldown model
//! `now ≥ break_until_ms` (else `Cooldown`), then `break_until_ms = now +
//! break_time_ms(block, held tool)`. The client shows the mining progress *before* sending,
//! so the chain enforces the rate (one block per break time) without a start/finish
//! handshake. Air, water and bedrock (and out-of-palette bytes) → `Unbreakable`. The drop
//! (`can_harvest` + `drop_item`) goes to the inventory; **if it does not fit it is lost and
//! the block still breaks** (Minecraft would drop it on the ground, which we don't model).
//! A held tool loses one durability per break (`Inventory::damage_tool`, breaks at 0).
//!
//! # `place_block(x, y, z, slot)`
//! Target is Air or water (`InvalidTarget`); the slot's item must be a block item
//! (`NotPlaceable`); one of the 6 face neighbours must be solid (`NotFaceAdjacent`; a
//! neighbour in a chunk that was not passed counts as **not** solid, so omitting a chunk
//! cannot fake support). A solid block must not overlap ([`box_overlaps_block`], the
//! client-sized box: half-width [`PLACE_HALF_W`], height [`PLACE_BODY_H`]) the placer
//! (stored position) **or any fresh presence entry** (`now − last_seen ≤ STALE_MS`) of the
//! target chunk or of the neighbour chunks a box could reach the block from (`SelfOverlap`):
//! - `presence` = the target chunk's list (read-only, required);
//! - `remaining_accounts`, per needed neighbour in the order of [`needed_neighbors`]
//!   (x neighbour if `lx ∈ {0, 15}`, then z neighbour if `lz ∈ {0, 15}`, then the
//!   diagonal if both): the neighbour chunk (read-only; validated by stored identity, like
//!   every gameplay chunk) followed by its presence list — or, if that chunk does not
//!   exist, only the chunk's PDA address (must be empty: no chunk, no players; this case
//!   costs a `find_program_address`). Missing or wrong → `InvalidPresence` /
//!   `InvalidChunk`. These are **required** (not optional): otherwise a placer could omit
//!   them and trap a player standing across the border (whose stuck-escape is limited to
//!   1 block).
//!
//! Stale entries (dead players, quitters) never block: they stop counting 5 s after their
//! last move, though pruning may remove them only later.
//!
//! # Fluid (both edits)
//! The block write sets `edited = 1`. If water can be affected — the old block was water,
//! one of the 10 voxels `enqueue_neighbors` would look at is water, or the block is on a
//! border whose neighbour chunk was not passed (its water is unknown) — the edit calls
//! `fluid::enqueue_neighbors` over a `ChunkNeighborhood` of the target chunk plus the
//! optional `chunk_n` (`cz−1`), `chunk_s` (`cz+1`), `chunk_e` (`cx+1`), `chunk_w` (`cx−1`)
//! (writable; validated by stored identity). Cross-border effects (pushes into a neighbour's
//! queue) happen only for passed neighbours; otherwise they are skipped: the target's own
//! voxel is still queued, and its tick (which sees all neighbours) carries the flow on, but
//! a neighbour voxel that depended on the edited one is only re-evaluated when something
//! else queues it. Clients should pass the neighbour chunk when editing a border block.
//! Every chunk whose queue has work afterwards goes through `crank::maybe_arm_chunk`.
//!
//! # `craft(recipe_id, count, table, furnace)`
//! Optional station claims: a block position plus the (read-only) chunk containing it
//! (`table_chunk` / `furnace_chunk`, may be the same account). A claim counts if the block
//! there is a CraftingTable / Furnace within block reach; core `recipes::craft` (atomic)
//! then decides (`WrongStation` if a needed station is missing).
//!
//! # `attack_mob(idx)` (mob slot `idx` of `chunk`, any ready chunk of the world)
//! Mob present (`NoMob`), in reach (`OutOfReach`), `now ≥ attack_until_ms` (`Cooldown`;
//! then `+ params.attack_cooldown_ms`). Damage = held tool's `tool_info` damage, else 1
//! (fist); a held tool loses one durability. On death: `mobs::drops(kind, world seed,
//! nonce)` with `nonce = (mob.id << 32) ^ chain_ms ^ slot` (not retryable for a reroll in
//! the same slot; a killer could still pick the timing of the last blow, which only shifts
//! a 1-3 item roll), items added (overflow lost), slot cleared.
//!
//! # `eat(slot)`, `select_slot(slot)`, `respawn()`
//! `eat`: core `inventory::eat` (`NotFood`, `FoodFull`, …). `select_slot`: sets
//! `held_slot` (< 36, `BadSlot`) — the tool used by `break_block` / `attack_mob`.
//! `respawn`: only at health 0 (`NotDead`); clears the inventory, health/food 20,
//! exhaustion 0, cooldowns 0, `MoveState::spawn(World.spawn, chain_ms)` (the client's next
//! move must carry `client_ms > last_ms`), `cx/cz` = the spawn chunk. The presence entry in
//! the death chunk is left alone: it is stale (no moves while dead) so it blocks nothing,
//! and movers prune it (≤ 5 s, or 60 s with pending damage).

use core::cell::RefMut;

use anchor_lang::prelude::*;
use magicraft_core::blocks::{self as blk, Block};
use magicraft_core::consts::{CHUNK_H, CHUNK_VOL};
use magicraft_core::coords::block_index;
use magicraft_core::fluid::{
    enqueue_neighbors, BlockAccess, ChunkNeighborhood, FluidQueue, EAST, NORTH, SOUTH, WEST,
};
use magicraft_core::hash::Seed;
use magicraft_core::inventory::{eat as core_eat, INV_SLOTS, MAX_FOOD};
use magicraft_core::mobs::{damage_mob, drops, MOB_SLOTS};
use magicraft_core::physics::{MoveState, GROUND_HALF_W};
use magicraft_core::recipes::{craft as core_craft, Stations};
use session_keys::{session_auth_or, Session, SessionError, SessionTokenV2};

use crate::errors::MagicraftError;
use crate::instructions::crank::maybe_arm_chunk;
use crate::instructions::play::{chunk_of, spawn_pos};
use crate::presence::STALE_MS;
use crate::state::{
    chunk_header, chunk_header_mut, presence_entries_ro, ready_chunk_blocks_ro,
    ready_chunk_mut_for, ChunkHeader, Player, PlayerState, World, CHUNK_SEED, MAX_HEALTH,
};

/// Eye height above the feet, FP (1.62 blocks).
pub const EYE_FP: i64 = 415;
/// Added to every reach limit, FP (0.5 block): the stored position lags the client's.
pub const REACH_SLACK_FP: i64 = 128;
/// Melee reach to a mob, FP (3 blocks; slack added on top).
pub const ATTACK_REACH_FP: i64 = 3 * 256;
/// Height of a mob's point column (feet block + head block), FP.
pub const MOB_HEIGHT_FP: i64 = 2 * 256;
/// Half-width of the box a placed block must not overlap, FP (≥ the client's 0.3 block
/// and the server's collision box).
pub const PLACE_HALF_W: i64 = GROUND_HALF_W as i64;
/// Height of that box above the feet, FP (≥ the client's 1.8 blocks).
pub const PLACE_BODY_H: i64 = 461;

const AIR: u8 = Block::Air as u8;
/// Neighbour offsets `(dcx, dcz)` in `chunk_n/s/e/w` order (= fluid slots 1..=4).
const NBR_OFF: [(i32, i32); 4] = [(0, -1), (0, 1), (1, 0), (-1, 0)];

// ---------- pure helpers (unit-tested) ----------

/// `|d| ≤ r` with `d` in FP, squared in `u64` (no division, no signed multiply). Each
/// component is bounded by `r` first, so the squares cannot overflow.
pub fn within(d: [i64; 3], r: i64) -> bool {
    let r = r.max(0) as u64;
    let [a, b, c] = d.map(|v| v.unsigned_abs());
    if a > r || b > r || c > r {
        return false;
    }
    a.wrapping_mul(a) + b.wrapping_mul(b) + c.wrapping_mul(c) <= r.wrapping_mul(r)
}

/// Block `b` is within `reach` (+ slack) of the eye of a player with feet at `pos`.
pub fn block_in_reach(pos: [i32; 3], b: [i32; 3], reach: u32) -> bool {
    let c = |v: i32| ((v as i64) << 8) + 128;
    within(
        [
            c(b[0]) - pos[0] as i64,
            c(b[1]) - (pos[1] as i64 + EYE_FP),
            c(b[2]) - pos[2] as i64,
        ],
        reach as i64 + REACH_SLACK_FP,
    )
}

/// A mob with feet at `mob` (point column, [`MOB_HEIGHT_FP`] tall) is within melee reach
/// of the eye of a player with feet at `pos`.
pub fn mob_in_reach(pos: [i32; 3], mob: [i32; 3]) -> bool {
    let eye = pos[1] as i64 + EYE_FP;
    let lo = mob[1] as i64;
    let nearest = eye.clamp(lo, lo + MOB_HEIGHT_FP);
    within(
        [
            mob[0] as i64 - pos[0] as i64,
            nearest - eye,
            mob[2] as i64 - pos[2] as i64,
        ],
        ATTACK_REACH_FP + REACH_SLACK_FP,
    )
}

/// The box of a player with feet at `pos` (half-open: `[x ± PLACE_HALF_W) × [y, y +
/// PLACE_BODY_H) × [z ± PLACE_HALF_W)`) overlaps block `b`.
pub fn box_overlaps_block(pos: [i32; 3], b: [i32; 3]) -> bool {
    let span = |lo: i64, hi: i64, bc: i32| {
        let b0 = (bc as i64) << 8;
        lo < b0 + 256 && hi > b0
    };
    let (x, y, z) = (pos[0] as i64, pos[1] as i64, pos[2] as i64);
    span(x - PLACE_HALF_W, x + PLACE_HALF_W, b[0])
        && span(y, y + PLACE_BODY_H, b[1])
        && span(z - PLACE_HALF_W, z + PLACE_HALF_W, b[2])
}

/// Chunk offsets `(dcx, dcz)` from whose presence lists a player box can overlap block
/// `(x, _, z)` (the target chunk itself excluded), in the `remaining_accounts` order of
/// `place_block`: x neighbour, z neighbour, diagonal. Returns the offsets and their count.
pub fn needed_neighbors(x: i32, z: i32) -> ([(i32, i32); 3], usize) {
    let edge = |l: i32| match l {
        0 => -1,
        15 => 1,
        _ => 0,
    };
    let (dx, dz) = (edge(x & 15), edge(z & 15));
    let mut out = [(0, 0); 3];
    let mut n = 0;
    if dx != 0 {
        out[n] = (dx, 0);
        n += 1;
    }
    if dz != 0 {
        out[n] = (0, dz);
        n += 1;
    }
    if dx != 0 && dz != 0 {
        out[n] = (dx, dz);
        n += 1;
    }
    (out, n)
}

/// Some voxel `fluid::enqueue_neighbors` looks at around `(x, y, z)` (below, above, the
/// 4 horizontal neighbours and the 4 above those) is water.
fn fluid_near(w: &impl BlockAccess, x: i32, y: i32, z: i32) -> bool {
    let f = |dx: i32, dy: i32, dz: i32| {
        blk::is_fluid_u8(w.get(x.wrapping_add(dx), y + dy, z.wrapping_add(dz)))
    };
    if f(0, -1, 0) || f(0, 1, 0) {
        return true;
    }
    [(1, 0), (-1, 0), (0, 1), (0, -1)]
        .iter()
        .any(|&(dx, dz)| f(dx, 0, dz) || f(dx, 1, dz))
}

/// Some face neighbour of `(x, y, z)` is solid **in a chunk that was passed**
/// (`present` in fluid slot order; other chunks and out-of-world count as not solid).
fn has_solid_face(
    w: &ChunkNeighborhood,
    present: &[bool; 5],
    (cx, cz): (i32, i32),
    (x, y, z): (i32, i32, i32),
) -> bool {
    const FACES: [(i32, i32, i32); 6] = [
        (0, -1, 0),
        (0, 1, 0),
        (1, 0, 0),
        (-1, 0, 0),
        (0, 0, 1),
        (0, 0, -1),
    ];
    FACES.iter().any(|&(dx, dy, dz)| {
        let (nx, ny, nz) = (x.wrapping_add(dx), y + dy, z.wrapping_add(dz));
        if !(0..CHUNK_H as i32).contains(&ny) {
            return false;
        }
        let slot = match ((nx >> 4).wrapping_sub(cx), (nz >> 4).wrapping_sub(cz)) {
            (0, 0) => 0,
            (0, -1) => NORTH,
            (0, 1) => SOUTH,
            (1, 0) => EAST,
            (-1, 0) => WEST,
            _ => return false,
        };
        present[slot] && blk::is_solid_u8(w.get(nx, ny, nz))
    })
}

// ---------- block edit core ----------

/// Outcome of [`edit_block`].
struct Edit {
    /// The block byte before the edit.
    old: u8,
    /// Fluid queue has work afterwards: target chunk, then N, S, E, W.
    has_work: [bool; 5],
}

/// Loads the target chunk of block `p` (mut, ready, stored identity) and the optional
/// N/S/E/W neighbours, lets `decide(old, hood, present)` validate and return the new
/// block byte, writes it, sets `edited`, and notifies the fluid system (module docs).
fn edit_block(
    chunk: &AccountInfo,
    nbr: [Option<&AccountInfo>; 4],
    world: &Pubkey,
    p: [i32; 3],
    decide: impl FnOnce(u8, &ChunkNeighborhood, &[bool; 5]) -> Result<u8>,
) -> Result<Edit> {
    let (x, y, z) = (p[0], p[1], p[2]);
    let (cx, cz) = (x >> 4, z >> 4);
    let mut heads: [Option<RefMut<ChunkHeader>>; 4] = [None, None, None, None];
    let mut blocks: [Option<RefMut<[u8; CHUNK_VOL]>>; 4] = [None, None, None, None];
    for (i, ai) in nbr.iter().enumerate() {
        if let Some(ai) = ai {
            let (dx, dz) = NBR_OFF[i];
            let (h, b) = ready_chunk_mut_for(ai, world, cx.wrapping_add(dx), cz.wrapping_add(dz))?;
            heads[i] = Some(h);
            blocks[i] = Some(b);
        }
    }
    let (mut ch, mut cb) = ready_chunk_mut_for(chunk, world, cx, cz)?;
    let present = [
        true,
        nbr[0].is_some(),
        nbr[1].is_some(),
        nbr[2].is_some(),
        nbr[3].is_some(),
    ];
    let [bn, bs, be, bw] = &mut blocks;
    let mut hood = ChunkNeighborhood::new(
        cx,
        cz,
        &mut cb,
        [
            bn.as_deref_mut(),
            bs.as_deref_mut(),
            be.as_deref_mut(),
            bw.as_deref_mut(),
        ],
    );
    let old = hood.get(x, y, z);
    let new = decide(old, &hood, &present)?;
    hood.set(x, y, z, new);
    ch.edited = 1;

    let (lx, lz) = (x & 15, z & 15);
    let unknown_border = (lz == 0 && !present[NORTH])
        || (lz == 15 && !present[SOUTH])
        || (lx == 15 && !present[EAST])
        || (lx == 0 && !present[WEST]);
    let mut has_work = [false; 5];
    if blk::is_fluid_u8(old) || unknown_border || fluid_near(&hood, x, y, z) {
        let mut qs = [FluidQueue::new(); 5];
        qs[0] = ch.fluid_queue();
        for (i, h) in heads.iter().enumerate() {
            if let Some(h) = h {
                qs[i + 1] = h.fluid_queue();
            }
        }
        {
            let [q0, q1, q2, q3, q4] = &mut qs;
            let mut queues = [
                Some(q0),
                present[NORTH].then_some(q1),
                present[SOUTH].then_some(q2),
                present[EAST].then_some(q3),
                present[WEST].then_some(q4),
            ];
            enqueue_neighbors(&hood, &mut queues, x, y, z);
        }
        ch.set_fluid_queue(&qs[0]);
        for (i, h) in heads.iter_mut().enumerate() {
            if let Some(h) = h {
                h.set_fluid_queue(&qs[i + 1]);
                has_work[i + 1] = qs[i + 1].has_work();
            }
        }
        has_work[0] = qs[0].has_work();
    } else {
        // Keeps the watchdog contract: a chunk with pending work gets its crank checked.
        has_work[0] = ch.fluid_queue().has_work();
    }
    Ok(Edit { old, has_work })
}

/// `crank::maybe_arm_chunk` for every chunk whose queue has work (after all borrows of
/// them are released).
fn arm_chunks(
    chunk: &AccountInfo,
    nbr: [Option<&AccountInfo>; 4],
    has_work: [bool; 5],
    now: i64,
) -> Result<()> {
    if has_work[0] {
        maybe_arm_chunk(chunk, now)?;
    }
    for (i, ai) in nbr.iter().enumerate() {
        if let (true, Some(ai)) = (has_work[i + 1], ai) {
            maybe_arm_chunk(ai, now)?;
        }
    }
    Ok(())
}

/// No fresh entry of the presence lists that can reach block `b` overlaps it (module
/// docs). `own` = the target chunk's list; `nbr` = the validated N/S/E/W chunk accounts.
fn check_presence_overlap(
    world: &Pubkey,
    b: [i32; 3],
    chunk_key: &Pubkey,
    own: &AccountInfo,
    nbr: [Option<&AccountInfo>; 4],
    extra: &[AccountInfo],
    now: i64,
) -> Result<()> {
    let blocks_it = |ai: &AccountInfo, key: &Pubkey| -> Result<()> {
        let entries = presence_entries_ro(ai, key)?;
        for e in entries.iter() {
            if now.saturating_sub(e.last_seen_ms.get()) <= STALE_MS
                && box_overlaps_block(e.pos.map(|v| v.get()), b)
            {
                return err!(MagicraftError::SelfOverlap);
            }
        }
        Ok(())
    };
    blocks_it(own, chunk_key)?;
    let (cx, cz) = (b[0] >> 4, b[2] >> 4);
    let (need, n) = needed_neighbors(b[0], b[2]);
    let mut rest = extra.iter();
    let mut next = || rest.next().ok_or(error!(MagicraftError::InvalidPresence));
    for &(dx, dz) in &need[..n] {
        let (ncx, ncz) = (cx.wrapping_add(dx), cz.wrapping_add(dz));
        let ai = next()?;
        if *ai.owner == crate::ID {
            // An existing chunk, then its presence list. A chunk also passed as
            // `chunk_n/s/e/w` is already validated (and mutably borrowed).
            let validated = nbr.iter().flatten().any(|c| c.key == ai.key);
            if !validated {
                let h = chunk_header(ai)?;
                require!(
                    h.world == *world && h.cx.get() == ncx && h.cz.get() == ncz,
                    MagicraftError::InvalidChunk
                );
            }
            blocks_it(next()?, ai.key)?;
        } else {
            // No such chunk ⇒ no presence list ⇒ no players there.
            let key = Pubkey::find_program_address(
                &[
                    CHUNK_SEED,
                    world.as_ref(),
                    &ncx.to_le_bytes(),
                    &ncz.to_le_bytes(),
                ],
                &crate::ID,
            )
            .0;
            require!(
                *ai.key == key && ai.data_is_empty(),
                MagicraftError::InvalidPresence
            );
        }
    }
    Ok(())
}

// ---------- accounts ----------

#[derive(Accounts, Session)]
pub struct BreakBlock<'info> {
    /// Wallet or session key of `player`'s authority.
    pub signer: Signer<'info>,
    /// Read-only; tied to `player_state` (see the module docs).
    pub player: Account<'info, Player>,
    #[session(signer = signer, authority = player.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
    /// Read-only: params, chain time.
    pub world: Account<'info, World>,
    #[account(
        mut,
        constraint = player_state.player == player.key() @ MagicraftError::Unauthorized,
        constraint = player_state.world == world.key() @ MagicraftError::Unauthorized
    )]
    pub player_state: Account<'info, PlayerState>,
    /// CHECK: chunk containing the block (`ready_chunk_mut_for`).
    #[account(mut)]
    pub chunk: UncheckedAccount<'info>,
    /// CHECK: optional neighbour `(cx, cz − 1)` for cross-border fluid updates.
    #[account(mut)]
    pub chunk_n: Option<UncheckedAccount<'info>>,
    /// CHECK: optional neighbour `(cx, cz + 1)`.
    #[account(mut)]
    pub chunk_s: Option<UncheckedAccount<'info>>,
    /// CHECK: optional neighbour `(cx + 1, cz)`.
    #[account(mut)]
    pub chunk_e: Option<UncheckedAccount<'info>>,
    /// CHECK: optional neighbour `(cx − 1, cz)`.
    #[account(mut)]
    pub chunk_w: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts, Session)]
pub struct PlaceBlock<'info> {
    /// Wallet or session key of `player`'s authority.
    pub signer: Signer<'info>,
    /// Read-only; tied to `player_state`.
    pub player: Account<'info, Player>,
    #[session(signer = signer, authority = player.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
    pub world: Account<'info, World>,
    #[account(
        mut,
        constraint = player_state.player == player.key() @ MagicraftError::Unauthorized,
        constraint = player_state.world == world.key() @ MagicraftError::Unauthorized
    )]
    pub player_state: Account<'info, PlayerState>,
    /// CHECK: chunk containing the block (`ready_chunk_mut_for`).
    #[account(mut)]
    pub chunk: UncheckedAccount<'info>,
    /// CHECK: presence list of `chunk` (read-only; `presence_entries_ro`).
    pub presence: UncheckedAccount<'info>,
    /// CHECK: optional neighbour `(cx, cz − 1)`.
    #[account(mut)]
    pub chunk_n: Option<UncheckedAccount<'info>>,
    /// CHECK: optional neighbour `(cx, cz + 1)`.
    #[account(mut)]
    pub chunk_s: Option<UncheckedAccount<'info>>,
    /// CHECK: optional neighbour `(cx + 1, cz)`.
    #[account(mut)]
    pub chunk_e: Option<UncheckedAccount<'info>>,
    /// CHECK: optional neighbour `(cx − 1, cz)`.
    #[account(mut)]
    pub chunk_w: Option<UncheckedAccount<'info>>,
}

/// Accounts of the actions that only touch the player's own state.
#[derive(Accounts, Session)]
pub struct SelfAction<'info> {
    pub signer: Signer<'info>,
    pub player: Account<'info, Player>,
    #[session(signer = signer, authority = player.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
    #[account(
        mut,
        constraint = player_state.player == player.key() @ MagicraftError::Unauthorized
    )]
    pub player_state: Account<'info, PlayerState>,
}

#[derive(Accounts, Session)]
pub struct Craft<'info> {
    pub signer: Signer<'info>,
    pub player: Account<'info, Player>,
    #[session(signer = signer, authority = player.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
    pub world: Account<'info, World>,
    #[account(
        mut,
        constraint = player_state.player == player.key() @ MagicraftError::Unauthorized,
        constraint = player_state.world == world.key() @ MagicraftError::Unauthorized
    )]
    pub player_state: Account<'info, PlayerState>,
    /// CHECK: chunk containing the claimed crafting table (read-only).
    pub table_chunk: Option<UncheckedAccount<'info>>,
    /// CHECK: chunk containing the claimed furnace (read-only).
    pub furnace_chunk: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts, Session)]
pub struct AttackMob<'info> {
    pub signer: Signer<'info>,
    pub player: Account<'info, Player>,
    #[session(signer = signer, authority = player.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
    /// Read-only: seed (drops), params, chain time.
    pub world: Account<'info, World>,
    #[account(
        mut,
        constraint = player_state.player == player.key() @ MagicraftError::Unauthorized,
        constraint = player_state.world == world.key() @ MagicraftError::Unauthorized
    )]
    pub player_state: Account<'info, PlayerState>,
    /// CHECK: the chunk whose mob slot is attacked (any ready chunk of `world`).
    #[account(mut)]
    pub chunk: UncheckedAccount<'info>,
}

#[derive(Accounts, Session)]
pub struct Respawn<'info> {
    pub signer: Signer<'info>,
    pub player: Account<'info, Player>,
    #[session(signer = signer, authority = player.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
    /// Read-only: spawn, chain time.
    pub world: Account<'info, World>,
    #[account(
        mut,
        constraint = player_state.player == player.key() @ MagicraftError::Unauthorized,
        constraint = player_state.world == world.key() @ MagicraftError::Unauthorized
    )]
    pub player_state: Account<'info, PlayerState>,
}

// ---------- handlers ----------

/// Breaks block `(x, y, z)` (see the module docs).
#[session_auth_or(
    ctx.accounts.player.authority == ctx.accounts.signer.key(),
    MagicraftError::Unauthorized
)]
pub fn break_block(ctx: Context<BreakBlock>, x: i32, y: i32, z: i32) -> Result<()> {
    let (inv, until) = {
        let a = &ctx.accounts;
        let ps = &a.player_state;
        require!(!ps.is_dead(), MagicraftError::Dead);
        require!(
            (0..CHUNK_H as i32).contains(&y),
            MagicraftError::InvalidTarget
        );
        let pos = ps.move_state()?.pos;
        require!(
            block_in_reach(pos, [x, y, z], a.world.params.reach),
            MagicraftError::OutOfReach
        );
        let now = a.world.chain_ms_ro(&Clock::get()?).ms;
        require!(now >= ps.break_until_ms, MagicraftError::Cooldown);

        let mut inv = ps.inventory();
        let held = ps.held_slot as usize;
        let tool = inv
            .slot(held)
            .and_then(|s| s.get_item())
            .and_then(|it| it.tool());
        let nbr = [
            a.chunk_n.as_deref(),
            a.chunk_s.as_deref(),
            a.chunk_e.as_deref(),
            a.chunk_w.as_deref(),
        ];
        let mut time = 0u32;
        let e = edit_block(&a.chunk, nbr, &a.world.key(), [x, y, z], |old, _, _| {
            time = Block::from_u8(old)
                .and_then(|b| blk::break_time_ms(b, tool))
                .ok_or(error!(MagicraftError::Unbreakable))?;
            Ok(AIR)
        })?;
        arm_chunks(&a.chunk, nbr, e.has_work, now)?;

        if let Some(b) = Block::from_u8(e.old) {
            if blk::can_harvest(b, tool) {
                if let Some((item, n)) = blk::drop_item(b) {
                    // Leftover (inventory full) is lost; the block breaks anyway.
                    inv.add(item, n as u32);
                }
            }
        }
        if tool.is_some() {
            inv.damage_tool(held);
        }
        (inv, now.saturating_add(time as i64))
    };
    let ps = &mut ctx.accounts.player_state;
    ps.set_inventory(&inv);
    ps.break_until_ms = until;
    Ok(())
}

/// Places the block item of inventory `slot` at `(x, y, z)` (see the module docs).
/// `remaining_accounts`: the neighbour presence lists of [`needed_neighbors`].
#[session_auth_or(
    ctx.accounts.player.authority == ctx.accounts.signer.key(),
    MagicraftError::Unauthorized
)]
pub fn place_block(ctx: Context<PlaceBlock>, x: i32, y: i32, z: i32, slot: u8) -> Result<()> {
    let inv = {
        let a = &ctx.accounts;
        let ps = &a.player_state;
        require!(!ps.is_dead(), MagicraftError::Dead);
        require!(
            (0..CHUNK_H as i32).contains(&y),
            MagicraftError::InvalidTarget
        );
        let pos = ps.move_state()?.pos;
        let b = [x, y, z];
        require!(
            block_in_reach(pos, b, a.world.params.reach),
            MagicraftError::OutOfReach
        );
        let mut inv = ps.inventory();
        let item = inv
            .slot(slot as usize)
            .ok_or(error!(MagicraftError::BadSlot))?
            .get_item()
            .ok_or(error!(MagicraftError::EmptySlot))?;
        let block = item
            .as_block()
            .ok_or(error!(MagicraftError::NotPlaceable))?;
        let now = a.world.chain_ms_ro(&Clock::get()?).ms;
        let world = a.world.key();
        let nbr = [
            a.chunk_n.as_deref(),
            a.chunk_s.as_deref(),
            a.chunk_e.as_deref(),
            a.chunk_w.as_deref(),
        ];
        let e = edit_block(&a.chunk, nbr, &world, b, |old, hood, present| {
            require!(
                old == AIR || blk::is_fluid_u8(old),
                MagicraftError::InvalidTarget
            );
            require!(
                has_solid_face(hood, present, (x >> 4, z >> 4), (x, y, z)),
                MagicraftError::NotFaceAdjacent
            );
            if blk::is_solid(block) {
                require!(!box_overlaps_block(pos, b), MagicraftError::SelfOverlap);
                check_presence_overlap(
                    &world,
                    b,
                    a.chunk.key,
                    &a.presence,
                    nbr,
                    ctx.remaining_accounts,
                    now,
                )?;
            }
            Ok(block as u8)
        })?;
        arm_chunks(&a.chunk, nbr, e.has_work, now)?;
        inv.remove_at(slot as usize, 1)
            .map_err(MagicraftError::from)?;
        inv
    };
    ctx.accounts.player_state.set_inventory(&inv);
    Ok(())
}

/// Selects the held inventory slot (the tool `break_block` / `attack_mob` use).
#[session_auth_or(
    ctx.accounts.player.authority == ctx.accounts.signer.key(),
    MagicraftError::Unauthorized
)]
pub fn select_slot(ctx: Context<SelfAction>, slot: u8) -> Result<()> {
    let ps = &mut ctx.accounts.player_state;
    require!(!ps.is_dead(), MagicraftError::Dead);
    require!((slot as usize) < INV_SLOTS, MagicraftError::BadSlot);
    ps.held_slot = slot;
    Ok(())
}

/// Eats the food in inventory `slot` (core `inventory::eat`).
#[session_auth_or(
    ctx.accounts.player.authority == ctx.accounts.signer.key(),
    MagicraftError::Unauthorized
)]
pub fn eat(ctx: Context<SelfAction>, slot: u8) -> Result<()> {
    let ps = &mut ctx.accounts.player_state;
    require!(!ps.is_dead(), MagicraftError::Dead);
    let mut inv = ps.inventory();
    let food = core_eat(&mut inv, slot as usize, ps.food).map_err(MagicraftError::from)?;
    ps.food = food;
    ps.set_inventory(&inv);
    Ok(())
}

/// Whether the claimed station block at `claim` (in `chunk`) is a `want` within reach.
fn station_ok(
    pos: [i32; 3],
    reach: u32,
    world: &Pubkey,
    claim: Option<[i32; 3]>,
    chunk: Option<&AccountInfo>,
    want: Block,
) -> Result<bool> {
    let (Some(b), Some(ai)) = (claim, chunk) else {
        return Ok(false);
    };
    if !(0..CHUNK_H as i32).contains(&b[1]) || !block_in_reach(pos, b, reach) {
        return Ok(false);
    }
    let blocks = ready_chunk_blocks_ro(ai, world, b[0] >> 4, b[2] >> 4)?;
    let i = block_index((b[0] & 15) as usize, b[1] as usize, (b[2] & 15) as usize);
    Ok(blocks[i] == want as u8)
}

/// Crafts recipe `recipe_id` `count` times (core `recipes::craft`, atomic) with the
/// claimed stations (see the module docs).
#[session_auth_or(
    ctx.accounts.player.authority == ctx.accounts.signer.key(),
    MagicraftError::Unauthorized
)]
pub fn craft(
    ctx: Context<Craft>,
    recipe_id: u16,
    count: u8,
    table: Option<[i32; 3]>,
    furnace: Option<[i32; 3]>,
) -> Result<()> {
    let inv = {
        let a = &ctx.accounts;
        let ps = &a.player_state;
        require!(!ps.is_dead(), MagicraftError::Dead);
        let pos = ps.move_state()?.pos;
        let (reach, world) = (a.world.params.reach, a.world.key());
        let near = Stations {
            table: station_ok(
                pos,
                reach,
                &world,
                table,
                a.table_chunk.as_deref(),
                Block::CraftingTable,
            )?,
            furnace: station_ok(
                pos,
                reach,
                &world,
                furnace,
                a.furnace_chunk.as_deref(),
                Block::Furnace,
            )?,
        };
        let mut inv = ps.inventory();
        core_craft(&mut inv, recipe_id, count, near).map_err(MagicraftError::from)?;
        inv
    };
    ctx.accounts.player_state.set_inventory(&inv);
    Ok(())
}

/// Attacks the mob in slot `idx` of `chunk` (see the module docs).
#[session_auth_or(
    ctx.accounts.player.authority == ctx.accounts.signer.key(),
    MagicraftError::Unauthorized
)]
pub fn attack_mob(ctx: Context<AttackMob>, idx: u8) -> Result<()> {
    let (inv, until) = {
        let a = &ctx.accounts;
        let ps = &a.player_state;
        require!(!ps.is_dead(), MagicraftError::Dead);
        require!((idx as usize) < MOB_SLOTS, MagicraftError::NoMob);
        let pos = ps.move_state()?.pos;
        let mut h = chunk_header_mut(&a.chunk)?;
        require!(
            h.world == a.world.key() && h.is_done(),
            MagicraftError::InvalidChunk
        );
        let mut mob = h.mob(idx as usize);
        require!(!mob.is_empty() && mob.hp > 0, MagicraftError::NoMob);
        require!(mob_in_reach(pos, mob.pos), MagicraftError::OutOfReach);
        let clock = Clock::get()?;
        let now = a.world.chain_ms_ro(&clock).ms;
        require!(now >= ps.attack_until_ms, MagicraftError::Cooldown);

        let mut inv = ps.inventory();
        let held = ps.held_slot as usize;
        let info = inv
            .slot(held)
            .and_then(|s| s.get_item())
            .and_then(|it| it.tool_info());
        let dmg = info.map_or(1, |(_, _, d)| d);
        if info.is_some() {
            inv.damage_tool(held);
        }
        if damage_mob(&mut mob, dmg) {
            let nonce = ((mob.id as u64) << 32) ^ (now as u64) ^ clock.slot;
            for (item, n) in drops(mob.kind, &Seed::new(&a.world.seed), nonce) {
                if n > 0 {
                    inv.add(item, n as u32); // overflow lost
                }
            }
            mob.clear();
        }
        h.set_mob(idx as usize, &mob);
        (
            inv,
            now.saturating_add(a.world.params.attack_cooldown_ms as i64),
        )
    };
    let ps = &mut ctx.accounts.player_state;
    ps.set_inventory(&inv);
    ps.attack_until_ms = until;
    Ok(())
}

/// Respawns a dead player at the world spawn with an empty inventory (module docs).
#[session_auth_or(
    ctx.accounts.player.authority == ctx.accounts.signer.key(),
    MagicraftError::Unauthorized
)]
pub fn respawn(ctx: Context<Respawn>) -> Result<()> {
    let (pos, now) = {
        let a = &ctx.accounts;
        require!(a.player_state.is_dead(), MagicraftError::NotDead);
        let now = a.world.chain_ms_ro(&Clock::get()?).ms;
        (spawn_pos(a.world.spawn), now)
    };
    let ps = &mut ctx.accounts.player_state;
    let mut inv = ps.inventory();
    inv.clear();
    ps.set_inventory(&inv);
    ps.set_move_state(&MoveState::spawn(pos, now));
    ps.health = MAX_HEALTH;
    ps.food = MAX_FOOD;
    ps.exhaustion = 0;
    ps.food_tick_ms = now;
    ps.break_until_ms = 0;
    ps.attack_until_ms = 0;
    ps.cx = chunk_of(pos[0]);
    ps.cz = chunk_of(pos[2]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const B: i32 = 256;
    /// Feet at the center of block column (x, z), standing at y.
    fn feet(x: i32, y: i32, z: i32) -> [i32; 3] {
        [x * B + 128, y * B, z * B + 128]
    }

    #[test]
    fn within_is_euclidean_and_total() {
        assert!(within([3, 4, 0], 5));
        assert!(!within([3, 4, 1], 5));
        assert!(within([0, 0, 0], 0));
        assert!(!within([i64::MIN, 0, 0], 4096));
        assert!(!within([0, i64::MAX, 0], 4096));
        assert!(!within([1, 0, 0], -5));
    }

    #[test]
    fn block_reach_from_the_eye() {
        let reach = 5 * B as u32; // default params
        let p = feet(0, 40, 0);
        // Eye at 41.62: the block under the feet (center 39.5) is 2.12 away.
        assert!(block_in_reach(p, [0, 39, 0], reach));
        // 5 blocks sideways at eye level (center dx = 5): within 5 + 0.5 slack.
        assert!(block_in_reach(p, [5, 41, 0], reach));
        assert!(!block_in_reach(p, [6, 41, 0], reach));
        // Straight down: center 35.5 → 6.12 > 5.5.
        assert!(!block_in_reach(p, [0, 35, 0], reach));
        assert!(block_in_reach(p, [0, 36, 0], reach));
        // Far-away coordinates don't overflow.
        assert!(!block_in_reach(p, [i32::MAX, 0, i32::MIN], 16 * B as u32));
        assert!(!block_in_reach([i32::MIN; 3], [i32::MAX; 3], 16 * B as u32));
    }

    #[test]
    fn mob_reach_to_the_column() {
        let p = feet(0, 40, 0);
        // Same height, 3 blocks away: in; 4 away: out.
        assert!(mob_in_reach(p, feet(3, 40, 0)));
        assert!(!mob_in_reach(p, feet(4, 40, 0)));
        // A mob 2 blocks below, 2 sideways: nearest point is its head top (40) vs eye 41.62.
        assert!(mob_in_reach(p, feet(2, 38, 0)));
        // Far below.
        assert!(!mob_in_reach(p, feet(0, 30, 0)));
    }

    #[test]
    fn overlap_box() {
        let p = feet(5, 40, 5);
        // Feet and head blocks.
        assert!(box_overlaps_block(p, [5, 40, 5]));
        assert!(box_overlaps_block(p, [5, 41, 5]));
        // Block under the feet and above the head: no.
        assert!(!box_overlaps_block(p, [5, 39, 5]));
        assert!(!box_overlaps_block(p, [5, 42, 5]));
        // Neighbour column: no (center ± 78 stays inside the column).
        assert!(!box_overlaps_block(p, [6, 40, 5]));
        assert!(!box_overlaps_block(p, [5, 40, 4]));
        // Standing near the +x edge of a column overlaps the next one.
        let edge = [5 * B + 200, 40 * B, 5 * B + 128];
        assert!(box_overlaps_block(edge, [6, 40, 5]));
        // Mid-jump 1.2 blocks up: the old feet block is free (pillaring).
        let up = [5 * B + 128, 40 * B + 307, 5 * B + 128];
        assert!(!box_overlaps_block(up, [5, 40, 5]));
        assert!(box_overlaps_block(up, [5, 41, 5]));
        // Negative coordinates.
        assert!(box_overlaps_block(feet(-1, 40, -1), [-1, 41, -1]));
        assert!(!box_overlaps_block(feet(-1, 40, -1), [0, 41, -1]));
        assert!(box_overlaps_block([-10, 40 * B, 128], [0, 40, 0]));
    }

    #[test]
    fn needed_neighbors_by_edge() {
        assert_eq!(needed_neighbors(5, 5).1, 0);
        let (o, n) = needed_neighbors(16, 31); // lx 0, lz 15
        assert_eq!(&o[..n], &[(-1, 0), (0, 1), (-1, 1)]);
        let (o, n) = needed_neighbors(-1, 3); // lx 15
        assert_eq!(&o[..n], &[(1, 0)]);
        let (o, n) = needed_neighbors(7, -16); // lz 0
        assert_eq!(&o[..n], &[(0, -1)]);
        // Any player box overlapping a block lies in the chunk of the block or one of these.
        for bx in [0, 1, 14, 15] {
            for bz in [0, 1, 14, 15] {
                let (o, n) = needed_neighbors(bx, bz);
                for px in (bx * B - 100)..(bx * B + 356) {
                    for pz in [bz * B - 79, bz * B + 128, bz * B + 334] {
                        let p = [px, 0, pz];
                        if box_overlaps_block(p, [bx, 0, bz]) {
                            let c = (px >> 12, pz >> 12);
                            assert!(c == (0, 0) || o[..n].contains(&c), "{bx} {bz} {px} {pz}");
                        }
                    }
                }
            }
        }
    }

    fn hood_parts() -> Vec<Box<[u8; CHUNK_VOL]>> {
        (0..5).map(|_| Box::new([AIR; CHUNK_VOL])).collect()
    }

    #[test]
    fn solid_face_ignores_missing_chunks() {
        let mut parts = hood_parts();
        let (c, rest) = parts.split_at_mut(1);
        let [n, s, e, w] = rest else { unreachable!() };
        // Stone at local (15, 10, 5) of the west neighbour = world (-1, 10, 5).
        w[block_index(15, 10, 5)] = Block::Stone as u8;
        let hood = ChunkNeighborhood::new(
            0,
            0,
            &mut c[0],
            [
                Some(&mut **n),
                Some(&mut **s),
                Some(&mut **e),
                Some(&mut **w),
            ],
        );
        let all = [true; 5];
        assert!(has_solid_face(&hood, &all, (0, 0), (0, 10, 5)));
        // Same hood, but the west chunk "not passed": no support.
        let no_w = [true, true, true, true, false];
        assert!(!has_solid_face(&hood, &no_w, (0, 0), (0, 10, 5)));
        // Mid-air in the center: none.
        assert!(!has_solid_face(&hood, &all, (0, 0), (8, 10, 8)));
        // Out-of-world neighbours (y = 0 below, y = 63 above) are not support.
        assert!(!has_solid_face(&hood, &all, (0, 0), (8, 0, 8)));
        assert!(!has_solid_face(&hood, &all, (0, 0), (8, 63, 8)));
    }

    #[test]
    fn fluid_near_sees_the_enqueue_set() {
        let mut parts = hood_parts();
        let (c, _) = parts.split_at_mut(1);
        c[0][block_index(9, 11, 8)] = Block::Water3 as u8; // H(above) of (8, 10, 8)
        let hood = ChunkNeighborhood::new(0, 0, &mut c[0], [None, None, None, None]);
        assert!(fluid_near(&hood, 8, 10, 8));
        assert!(!fluid_near(&hood, 8, 5, 8));
        // Diagonal neighbours are not in the set.
        assert!(!fluid_near(&hood, 10, 10, 9));
    }
}
