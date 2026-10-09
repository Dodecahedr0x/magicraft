//! Chunks: `create_chunk` → `grow_chunk` (stage 1) → `populate_chunk` (stage 2), and
//! `close_chunk` (reclaim an unedited chunk's rent).
//!
//! Client flow (see the design doc, "Terrain generation"):
//! 1. one ER tx: `ComputeBudget(1_400_000)` + `create_chunk` + `grow_chunk`;
//! 2. one ER tx: `ComputeBudget(1_400_000)` + `populate_chunk`.
//!
//! Accounts > 10 240 bytes need two top-level ixs (one CPI may grow an account by at most
//! 10 KiB), hence create at [`CHUNK_INITIAL_LEN`] and resize in `grow_chunk`.
//!
//! The block buffer is the account data itself (`&mut [u8; CHUNK_VOL]` over the data
//! slice), never a stack copy; [`Stage1Info`] (1.25 KB) is boxed on the heap.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::MagicProgram;
use ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;
use ephemeral_rollups_sdk::ephemeral_accounts::{rent, EphemeralAccount};
use magicraft_core::hash::Seed;
use magicraft_core::mobs::Mob;
use magicraft_core::populate::{generate_stage2, spawn_point, MobSpawn, MAX_SPAWNS};
use magicraft_core::terrain::{generate_stage1, stage1_info_from_blocks, Stage1Info};
use session_keys::{session_auth_or, Session, SessionError, SessionTokenV2};

use crate::auth::{chunk_seeds, player_seeds, presence_seeds};
use crate::errors::MagicraftError;
use crate::instructions::crank::{
    cancel_tick, chunk_key, derive_tick_ix, maybe_arm_chunk, prepare_arm, schedule_tick,
    tick_interval_ms, CrankKeys, NBR_OFF, TICK_TASK_TAG,
};
use crate::scheduler;
use magicraft_core::consts::CHUNK_VOL;

use crate::state::{
    check_chunk_identity, chunk_for, chunk_header, chunk_header_from, chunk_header_mut,
    chunk_parts_mut, ensure_sponsor_reserve, init_chunk_header, init_presence_header, presence_for,
    presence_len, Player, PlayerState, World, CHUNK_BLOCKS_OFFSET, CHUNK_FULL_LEN,
    CHUNK_INITIAL_LEN, CHUNK_SEED, GEN_CREATED, GEN_DONE, GEN_STAGE1, PLAYER_SEED, PRESENCE_SEED,
};

/// Byte size of a fresh (empty) `ChunkPresence`.
pub const PRESENCE_EMPTY_LEN: usize = presence_len(0);

/// Rent a Player must be able to pay for one chunk over its life: the **full** chunk
/// (create + grow) plus the empty presence list.
pub const CHUNK_TOTAL_RENT: u64 = rent(CHUNK_FULL_LEN as u32) + rent(PRESENCE_EMPTY_LEN as u32);

/// The N, S, E, W neighbor chunk PDAs of `(cx, cz)` and the bumps of those PDAs, then of
/// their presence PDAs (`ChunkHeader::nbr_bumps`; 8 bump searches, once per chunk at
/// `create_chunk`).
pub fn neighbor_pdas(world: &Pubkey, cx: i32, cz: i32) -> ([Pubkey; 4], [u8; 8]) {
    let mut keys = [Pubkey::default(); 4];
    let mut out = [0u8; 8];
    for (i, (dx, dz)) in NBR_OFF.iter().enumerate() {
        let (ncx, ncz) = (cx.wrapping_add(*dx), cz.wrapping_add(*dz));
        let (key, b) = Pubkey::find_program_address(
            &[
                CHUNK_SEED,
                world.as_ref(),
                &ncx.to_le_bytes(),
                &ncz.to_le_bytes(),
            ],
            &crate::ID,
        );
        keys[i] = key;
        out[i] = b;
        out[4 + i] = Pubkey::find_program_address(&[PRESENCE_SEED, key.as_ref()], &crate::ID).1;
    }
    (keys, out)
}

/// The 4 neighbor slots of `create_chunk` / `close_chunk` (N, S, E, W): each must be the
/// neighbor's chunk PDA (`expected`, else `InvalidChunk`); an existing one (owned by this
/// program) must be passed **writable** (its `nbr_mask` is updated; `InvalidChunk`
/// otherwise), a missing one read-only (the ER rejects a non-existent writable account).
/// Returns which exist and which of those are fully generated.
fn check_slots(
    slots: &[&AccountInfo; 4],
    expected: &[Pubkey; 4],
) -> Result<([bool; 4], [bool; 4])> {
    let (mut exists, mut done) = ([false; 4], [false; 4]);
    for i in 0..4 {
        let ai = slots[i];
        require_keys_eq!(*ai.key, expected[i], MagicraftError::InvalidChunk);
        if *ai.owner == crate::ID && !ai.data_is_empty() {
            require!(ai.is_writable, MagicraftError::InvalidChunk);
            let len = ai.data_len();
            let h = chunk_header(ai)?;
            exists[i] = true;
            done[i] = h.is_done() && len >= CHUNK_FULL_LEN;
        }
    }
    Ok((exists, done))
}

/// Sets (`linked`) or clears bit `i ^ 1` (the direction back to the chunk in slot `i`'s
/// opposite) in every existing neighbor's `nbr_mask`, then re-arms each neighbor whose
/// crank is armed (its tick account list changed). Call with no borrows held.
fn relink_neighbors<'info>(
    slots: &[&AccountInfo<'info>; 4],
    exists: &[bool; 4],
    linked: bool,
    now_ms: i64,
    interval_ms: i64,
) -> Result<()> {
    for i in 0..4 {
        if !exists[i] {
            continue;
        }
        let ai = slots[i];
        let keys = {
            let mut h = chunk_header_mut(ai)?;
            let bit = 1u8 << (i ^ 1);
            if linked {
                h.nbr_mask |= bit;
            } else {
                h.nbr_mask &= !bit;
            }
            if h.crank_armed == 0 {
                continue;
            }
            let old = prepare_arm(&mut h, ai.key, now_ms);
            (CrankKeys::of(&h), old)
        };
        let (keys, old) = keys;
        if let Some(old) = old {
            cancel_tick(ai, &keys, old)?;
        }
        schedule_tick(ai, &keys, interval_ms, derive_tick_ix(ai.key, &keys)?)?;
        msg!("neighbor {} crank re-armed", i);
    }
    Ok(())
}

// ---------- create_chunk (ER) ----------

#[derive(Accounts, Session)]
#[instruction(cx: i32, cz: i32)]
pub struct CreateChunk<'info> {
    /// Wallet or session key of `player`'s authority (fee payer; ER fees are 0).
    pub signer: Signer<'info>,
    /// Sponsor (pays the ephemeral rent). `mut` ⇒ delegated on the ER.
    #[account(mut, seeds = [PLAYER_SEED, player.authority.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
    #[session(signer = signer, authority = player.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
    /// `chunk_count` is updated; the seed must be set.
    #[account(mut, constraint = world.seed_set @ MagicraftError::SeedPending)]
    pub world: Account<'info, World>,
    /// CHECK: the Chunk PDA, created here via the Magic program (fails if it exists).
    #[account(
        mut,
        seeds = [CHUNK_SEED, world.key().as_ref(), &cx.to_le_bytes(), &cz.to_le_bytes()],
        bump
    )]
    pub chunk: UncheckedAccount<'info>,
    /// CHECK: the chunk's presence PDA, created here.
    #[account(mut, seeds = [PRESENCE_SEED, chunk.key().as_ref()], bump)]
    pub presence: UncheckedAccount<'info>,
    /// CHECK: neighbor slot `(cx, cz − 1)`: its chunk PDA, writable iff it exists
    /// (`check_slots`).
    pub chunk_n: UncheckedAccount<'info>,
    /// CHECK: neighbor slot `(cx, cz + 1)`.
    pub chunk_s: UncheckedAccount<'info>,
    /// CHECK: neighbor slot `(cx + 1, cz)`.
    pub chunk_e: UncheckedAccount<'info>,
    /// CHECK: neighbor slot `(cx − 1, cz)`.
    pub chunk_w: UncheckedAccount<'info>,
    /// The signing player's `PlayerState` in `world` (identity checked in the handler):
    /// allows creating the chunk the player currently stands in, see `check_adjacency`.
    pub player_state: Option<Account<'info, PlayerState>>,
    /// CHECK: ephemeral rent vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

/// Adjacency rule: `(cx, cz)` is the player's current chunk (`own_chunk`, from its
/// `PlayerState` in this world), or an edge neighbor exists and is fully generated
/// (`DONE`; existing ones that are not → `ChunkNotReady`), or the world has no chunks and
/// this is (0,0) (else `NotAdjacent`). `chunk_count` is why `create_chunk` / `close_chunk`
/// take the World writable; both are rare, so the write lock is acceptable
/// (`populate_chunk` and gameplay ixs take it read-only).
///
/// Why the player's own chunk: `move_player` reads a missing chunk as Stone, so a player
/// whose current chunk no longer exists could never move again. That happens when the
/// player is away long enough for its presence entry to be pruned (stale after 5 s) and the
/// chunk's payer then closes it (unedited, empty presence) — possibly with no remaining
/// neighbor. Recreating it regenerates identical terrain.
fn check_adjacency(
    exists: &[bool; 4],
    done: &[bool; 4],
    own_chunk: Option<(i32, i32)>,
    chunk_count: u32,
    cx: i32,
    cz: i32,
) -> Result<()> {
    if own_chunk == Some((cx, cz)) || done.iter().any(|d| *d) {
        return Ok(());
    }
    require!(!exists.iter().any(|e| *e), MagicraftError::ChunkNotReady);
    require!(
        chunk_count == 0 && cx == 0 && cz == 0,
        MagicraftError::NotAdjacent
    );
    Ok(())
}

/// Creates `Chunk (cx, cz)` at 10 240 bytes (`gen_stage = 0`) and its empty
/// `ChunkPresence`, both sponsored by the Player, which must be able to pay the rent of
/// the **full** chunk + presence and keep its reserve. `open_chunks += 1`,
/// `world.chunk_count += 1` (counters: checked `+1` here, saturating `−1` in `close_chunk`).
/// Header: tick task id, presence bump, the 8 neighbor bumps and `nbr_mask` (which of the 4
/// neighbor slots exist, `check_slots`); every existing neighbor gets this chunk's bit and,
/// if its tick crank is armed, is re-armed with its new account list (see `crank`).
/// Follow with `grow_chunk` in the same tx.
#[session_auth_or(
    ctx.accounts.player.authority == ctx.accounts.signer.key(),
    MagicraftError::Unauthorized
)]
pub fn create_chunk(mut ctx: Context<CreateChunk>, cx: i32, cz: i32) -> Result<()> {
    let a = &ctx.accounts;
    let world_key = a.world.key();
    let slot_infos = [
        a.chunk_n.to_account_info(),
        a.chunk_s.to_account_info(),
        a.chunk_e.to_account_info(),
        a.chunk_w.to_account_info(),
    ];
    let slots = [
        &slot_infos[0],
        &slot_infos[1],
        &slot_infos[2],
        &slot_infos[3],
    ];
    let (nbr_keys, nbr_bumps) = neighbor_pdas(&world_key, cx, cz);
    let (exists, done) = check_slots(&slots, &nbr_keys)?;
    let own_chunk = match &a.player_state {
        Some(ps) => {
            require!(
                ps.player == a.player.key() && ps.world == world_key,
                MagicraftError::Unauthorized
            );
            Some((ps.cx, ps.cz))
        }
        None => None,
    };
    check_adjacency(&exists, &done, own_chunk, a.world.chunk_count, cx, cz)?;

    let player_ai = a.player.to_account_info();
    ensure_sponsor_reserve(&player_ai, CHUNK_TOTAL_RENT)?;

    let chunk_ai = a.chunk.to_account_info();
    let presence_ai = a.presence.to_account_info();
    let vault_ai = a.vault.to_account_info();
    let authority = a.player.authority;
    let (pbump, cbump, sbump) = ([a.player.bump], [ctx.bumps.chunk], [ctx.bumps.presence]);
    let (cxb, czb) = (cx.to_le_bytes(), cz.to_le_bytes());
    let pseeds = player_seeds(&authority, &pbump);
    let cseeds = chunk_seeds(&world_key, &cxb, &czb, &cbump);
    let chunk_key = chunk_ai.key();
    let sseeds = presence_seeds(&chunk_key, &sbump);

    EphemeralAccount::new(&player_ai, &chunk_ai, &vault_ai)
        .with_signer_seeds(&[&pseeds, &cseeds])
        .create(CHUNK_INITIAL_LEN as u32)?;
    EphemeralAccount::new(&player_ai, &presence_ai, &vault_ai)
        .with_signer_seeds(&[&pseeds, &sseeds])
        .create(PRESENCE_EMPTY_LEN as u32)?;

    {
        let mut data = chunk_ai.try_borrow_mut_data()?;
        let h = init_chunk_header(
            &mut data,
            a.player.key(),
            world_key,
            cx,
            cz,
            ctx.bumps.chunk,
        )?;
        h.task_id
            .set(scheduler::task_id(TICK_TASK_TAG, &chunk_key, 0));
        h.presence_bump = ctx.bumps.presence;
        h.nbr_bumps = nbr_bumps;
        h.nbr_mask = (0..4).fold(0, |m, i| m | ((exists[i] as u8) << i));
    }
    init_presence_header(
        &mut presence_ai.try_borrow_mut_data()?,
        chunk_key,
        ctx.bumps.presence,
    )?;

    // Existing neighbors now have this chunk next to them: link it and re-arm their
    // cranks (their tick account lists change, see `crank`).
    let now = a.world.chain_ms_ro(&Clock::get()?).ms;
    relink_neighbors(
        &slots,
        &exists,
        true,
        now,
        tick_interval_ms(&a.world.params),
    )?;
    let a = &mut ctx.accounts;
    a.player.open_chunks = a
        .player
        .open_chunks
        .checked_add(1)
        .ok_or(MagicraftError::Overflow)?;
    a.world.chunk_count = a
        .world
        .chunk_count
        .checked_add(1)
        .ok_or(MagicraftError::Overflow)?;
    Ok(())
}

// ---------- grow_chunk (ER) ----------

#[derive(Accounts)]
pub struct GrowChunk<'info> {
    /// The chunk's payer (`chunk.payer`, checked): sponsors the resize, signing with its
    /// stored PDA seeds. No user signature: the rent was reserved at `create_chunk`.
    #[account(mut, seeds = [PLAYER_SEED, player.authority.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
    pub world: Account<'info, World>,
    /// CHECK: validated by `chunk_for` (owner, discriminator, world, coordinates, PDA).
    #[account(mut)]
    pub chunk: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

/// Resizes the chunk to [`CHUNK_FULL_LEN`] (requires `gen_stage == 0` **and** length
/// 10 240, else `WrongGenStage`, so it never resizes twice), writes stage-1 terrain into
/// the block region in place and the 256 biome bytes into the header; `gen_stage = 1`.
///
/// **Permissionless** (anti-squatting): anyone may grow a created chunk, so a creator who
/// stops after `create_chunk` cannot block the coordinates. The sponsor is the chunk's own
/// payer Player (`InvalidChunk` if another Player is passed); its reserve for the full
/// chunk was checked at create (re-checked here for the resize delta).
pub fn grow_chunk(ctx: Context<GrowChunk>, cx: i32, cz: i32) -> Result<()> {
    let a = &ctx.accounts;
    let world_key = a.world.key();
    let chunk_ai = a.chunk.to_account_info();
    // Read before `chunk_for` mutably borrows the data (`data_len` borrows it too).
    let len = chunk_ai.data_len();
    {
        let h = chunk_for(&chunk_ai, &world_key, cx, cz)?;
        require_keys_eq!(h.payer, a.player.key(), MagicraftError::InvalidChunk);
        require!(
            h.gen_stage == GEN_CREATED && len == CHUNK_INITIAL_LEN,
            MagicraftError::WrongGenStage
        );
    }

    let player_ai = a.player.to_account_info();
    ensure_sponsor_reserve(
        &player_ai,
        rent(CHUNK_FULL_LEN as u32) - rent(CHUNK_INITIAL_LEN as u32),
    )?;
    let authority = a.player.authority;
    let pbump = [a.player.bump];
    EphemeralAccount::new(&player_ai, &chunk_ai, &a.vault.to_account_info())
        .with_signer_seeds(&[&player_seeds(&authority, &pbump)])
        .resize(CHUNK_FULL_LEN as u32)?;

    let seed = Seed::new(&a.world.seed);
    let mut info = Box::new(Stage1Info::EMPTY);
    let (mut h, mut blocks) = chunk_parts_mut(&chunk_ai)?;
    generate_stage1(&seed, cx, cz, &mut blocks, &mut info);
    for (dst, b) in h.biomes.iter_mut().zip(info.biomes.iter()) {
        *dst = *b as u8;
    }
    h.gen_stage = GEN_STAGE1;
    Ok(())
}

// ---------- populate_chunk (ER, permissionless) ----------

#[derive(Accounts)]
pub struct PopulateChunk<'info> {
    /// Read-only (the spawn is set by `set_spawn`).
    pub world: Account<'info, World>,
    /// CHECK: validated by `chunk_for`.
    #[account(mut)]
    pub chunk: UncheckedAccount<'info>,
    /// Arms the tick crank when animals were placed.
    pub magic_program: Program<'info, MagicProgram>,
}

/// Stage 2 (caves, ores, trees, cacti, animals) on a `gen_stage == 1` chunk
/// (`WrongGenStage` otherwise); animals go into the mob slots; `gen_stage = DONE`. The
/// World is read-only; after populating (0,0) the client sends `set_spawn`. A chunk with
/// animals gets its tick crank armed (they wander for one arm, ≤ 60 s, unless a player comes
/// near).
///
/// **Permissionless** (no signer besides the fee payer): the result is a pure function of
/// the seed and the stage-1 blocks, so anyone may finish a half-generated chunk (e.g. if
/// its creator went away between the two txs); the caller pays nothing.
pub fn populate_chunk(ctx: Context<PopulateChunk>, cx: i32, cz: i32) -> Result<()> {
    let world_key = ctx.accounts.world.key();
    let chunk_ai = ctx.accounts.chunk.to_account_info();
    {
        let h = chunk_for(&chunk_ai, &world_key, cx, cz)?;
        require!(h.gen_stage == GEN_STAGE1, MagicraftError::WrongGenStage);
    }
    let seed = Seed::new(&ctx.accounts.world.seed);
    let animals = {
        let (mut h, mut blocks) = chunk_parts_mut(&chunk_ai)?;
        let mut info = Box::new(Stage1Info::EMPTY);
        stage1_info_from_blocks(&blocks, &h.biomes, &mut info);
        let mut spawns = [MobSpawn::default(); MAX_SPAWNS];
        let n = generate_stage2(&seed, cx, cz, &mut blocks, &info, &mut spawns);
        for (i, s) in spawns.iter().take(n).enumerate() {
            h.set_mob(i, &Mob::from_spawn(s, cx, cz));
        }
        h.gen_stage = GEN_DONE;
        h.has_mobs()
    };
    if animals {
        // Animals wander for one arm (≤ TICK_ITERATIONS) unless someone comes near.
        let world = &ctx.accounts.world;
        let now = world.chain_ms_ro(&Clock::get()?).ms;
        maybe_arm_chunk(&chunk_ai, world, now)?;
    }
    Ok(())
}

// ---------- set_spawn (ER, permissionless) ----------

#[derive(Accounts)]
pub struct SetSpawn<'info> {
    #[account(mut, constraint = !world.spawn_set @ MagicraftError::SpawnAlreadySet)]
    pub world: Account<'info, World>,
    /// CHECK: chunk (0,0) of `world`, validated by `chunk_for`; read-only.
    pub chunk: UncheckedAccount<'info>,
}

/// Sets `World.spawn` once (`SpawnAlreadySet` afterwards) from the populated chunk (0,0)
/// (`ChunkNotReady` unless full size and `DONE`): [`spawn_point`], in **block**
/// coordinates of the feet block (`join_world` converts to FP). Permissionless; the client sends
/// it right after `populate_chunk(0, 0)`. Kept out of `populate_chunk` so that one takes the
/// World read-only. If (0,0) was edited before anyone called this, the spawn reflects the
/// edited blocks (harmless: it is still ground with 2 air above, or the center fallback).
pub fn set_spawn(ctx: Context<SetSpawn>) -> Result<()> {
    let world_key = ctx.accounts.world.key();
    let chunk_ai = ctx.accounts.chunk.to_account_info();
    let len = chunk_ai.data_len();
    let data = chunk_ai.try_borrow_data()?;
    let h = chunk_header_from(&data)?;
    require_keys_eq!(*chunk_ai.owner, crate::ID, MagicraftError::InvalidChunk);
    check_chunk_identity(h, chunk_ai.key, &world_key, 0, 0)?;
    require!(
        h.is_done() && len >= CHUNK_FULL_LEN,
        MagicraftError::ChunkNotReady
    );
    let blocks: &[u8; CHUNK_VOL] = data[CHUNK_BLOCKS_OFFSET..CHUNK_FULL_LEN]
        .try_into()
        .unwrap();
    let (x, y, z) = spawn_point(blocks);
    drop(data);
    let w = &mut ctx.accounts.world;
    w.spawn = [x as i32, y as i32, z as i32];
    w.spawn_set = true;
    Ok(())
}

// ---------- close_chunk (ER) ----------

#[derive(Accounts, Session)]
pub struct CloseChunk<'info> {
    pub signer: Signer<'info>,
    /// The chunk's payer; receives the refund. `mut` ⇒ must be delegated.
    #[account(mut, seeds = [PLAYER_SEED, player.authority.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
    #[session(signer = signer, authority = player.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
    #[account(mut)]
    pub world: Account<'info, World>,
    /// CHECK: validated by `chunk_for`; signs the crank cancel with its seeds.
    #[account(mut)]
    pub chunk: UncheckedAccount<'info>,
    /// CHECK: validated by `presence_for` against `chunk`.
    #[account(mut)]
    pub presence: UncheckedAccount<'info>,
    /// CHECK: neighbor slot `(cx, cz − 1)`: its chunk PDA, writable iff it exists.
    pub chunk_n: UncheckedAccount<'info>,
    /// CHECK: neighbor slot `(cx, cz + 1)`.
    pub chunk_s: UncheckedAccount<'info>,
    /// CHECK: neighbor slot `(cx + 1, cz)`.
    pub chunk_e: UncheckedAccount<'info>,
    /// CHECK: neighbor slot `(cx − 1, cz)`.
    pub chunk_w: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

/// Closes an unedited chunk and its presence list, refunding all rent to the payer Player
/// (on the ER; the next commit carries it to base). Payer only (wallet or session key).
/// Requires `!edited` (`ChunkEdited`), no zombies or other non-passive mobs (`ChunkHasMobs`)
/// and an empty presence list (`ChunkOccupied`); any `gen_stage` (a half-generated chunk
/// can be reclaimed). **Passive animals do not block**: they are dropped with the chunk
/// (whatever happened to them is lost) and the populate of a regenerated chunk spawns the
/// original animals again. Clears this chunk's bit in every existing neighbor's `nbr_mask`
/// (the 4 neighbor slots, as in `create_chunk`) and re-arms their armed cranks with the new
/// account lists, then cancels this chunk's tick crank (unknown ids are a no-op).
/// `open_chunks −= 1`, `world.chunk_count −= 1` (saturating).
#[session_auth_or(
    ctx.accounts.player.authority == ctx.accounts.signer.key(),
    MagicraftError::Unauthorized
)]
pub fn close_chunk(mut ctx: Context<CloseChunk>, cx: i32, cz: i32) -> Result<()> {
    let a = &ctx.accounts;
    let world_key = a.world.key();
    let chunk_ai = a.chunk.to_account_info();
    let presence_ai = a.presence.to_account_info();
    let (task_id, cbump, keys) = {
        let h = chunk_for(&chunk_ai, &world_key, cx, cz)?;
        require_keys_eq!(h.payer, a.player.key(), MagicraftError::Unauthorized);
        require!(h.edited == 0, MagicraftError::ChunkEdited);
        require!(!h.has_blocking_mobs(), MagicraftError::ChunkHasMobs);
        (h.task_id.get(), h.bump, CrankKeys::of(&h))
    };
    {
        let (h, _) = presence_for(&presence_ai, chunk_ai.key)?;
        require!(h.count.get() == 0, MagicraftError::ChunkOccupied);
    }

    // Neighbors lose this chunk: unlink it and re-arm their cranks (new account lists).
    let slot_infos = [
        a.chunk_n.to_account_info(),
        a.chunk_s.to_account_info(),
        a.chunk_e.to_account_info(),
        a.chunk_w.to_account_info(),
    ];
    let slots = [
        &slot_infos[0],
        &slot_infos[1],
        &slot_infos[2],
        &slot_infos[3],
    ];
    let mut nbr_keys = [Pubkey::default(); 4];
    for (i, k) in nbr_keys.iter_mut().enumerate() {
        let (ncx, ncz) = keys.nbr(i);
        *k = chunk_key(&world_key, ncx, ncz, keys.nbr_bumps[i])?;
    }
    let (exists, _) = check_slots(&slots, &nbr_keys)?;
    let now = a.world.chain_ms_ro(&Clock::get()?).ms;
    relink_neighbors(
        &slots,
        &exists,
        false,
        now,
        tick_interval_ms(&a.world.params),
    )?;

    if task_id != 0 {
        let (cxb, czb, b) = (cx.to_le_bytes(), cz.to_le_bytes(), [cbump]);
        scheduler::cancel(&chunk_ai, &chunk_seeds(&world_key, &cxb, &czb, &b), task_id)?;
    }

    let player_ai = a.player.to_account_info();
    let vault_ai = a.vault.to_account_info();
    let authority = a.player.authority;
    let pbump = [a.player.bump];
    let pseeds = player_seeds(&authority, &pbump);
    for eph in [&chunk_ai, &presence_ai] {
        EphemeralAccount::new(&player_ai, eph, &vault_ai)
            .with_signer_seeds(&[&pseeds])
            .close()?;
    }

    let a = &mut ctx.accounts;
    a.player.open_chunks = a.player.open_chunks.saturating_sub(1);
    a.world.chunk_count = a.world.chunk_count.saturating_sub(1);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adjacency_rules() {
        let none = [false; 4];
        let mut one = [false; 4];
        one[2] = true;
        // Player standing in (5, -3): creatable without any neighbor, in a non-empty world.
        assert!(check_adjacency(&none, &none, Some((5, -3)), 7, 5, -3).is_ok());
        let e = check_adjacency(&none, &none, Some((5, -3)), 7, 5, -2).unwrap_err();
        assert_eq!(e, error!(MagicraftError::NotAdjacent));
        assert!(check_adjacency(&none, &none, None, 7, 5, -3).is_err());
        // The first-chunk rule.
        assert!(check_adjacency(&none, &none, None, 0, 0, 0).is_ok());
        assert!(check_adjacency(&none, &none, Some((1, 1)), 1, 0, 0).is_err());
        // A DONE neighbor is a foothold; an existing unfinished one is not.
        assert!(check_adjacency(&one, &one, None, 3, 9, 9).is_ok());
        let e = check_adjacency(&one, &none, None, 3, 9, 9).unwrap_err();
        assert_eq!(e, error!(MagicraftError::ChunkNotReady));
    }

    #[test]
    fn neighbor_pdas_match_the_seeds() {
        let w = Pubkey::new_unique();
        let (keys, bumps) = neighbor_pdas(&w, 3, -4);
        for (i, (dx, dz)) in NBR_OFF.iter().enumerate() {
            let (k, b) = Pubkey::find_program_address(
                &[
                    CHUNK_SEED,
                    w.as_ref(),
                    &(3 + dx).to_le_bytes(),
                    &(-4 + dz).to_le_bytes(),
                ],
                &crate::ID,
            );
            assert_eq!((keys[i], bumps[i]), (k, b));
            assert_eq!(chunk_key(&w, 3 + dx, -4 + dz, bumps[i]).unwrap(), k);
            let pb = Pubkey::find_program_address(&[PRESENCE_SEED, k.as_ref()], &crate::ID).1;
            assert_eq!(bumps[4 + i], pb);
        }
    }

    #[test]
    fn total_rent_is_full_chunk_plus_presence() {
        assert_eq!(CHUNK_TOTAL_RENT, (17_152 + 60) * 32 + (48 + 60) * 32);
    }
}
