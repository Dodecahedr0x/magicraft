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
use crate::scheduler;
use magicraft_core::consts::CHUNK_VOL;

use crate::state::{
    check_chunk_identity, chunk_for, chunk_header, chunk_header_from, chunk_parts_mut,
    ensure_sponsor_reserve, init_chunk_header, init_presence_header, presence_for, presence_len,
    Player, World, CHUNK_BLOCKS_OFFSET, CHUNK_FULL_LEN, CHUNK_INITIAL_LEN, CHUNK_SEED, GEN_CREATED,
    GEN_DONE, GEN_STAGE1, PLAYER_SEED, PRESENCE_SEED,
};

/// Byte size of a fresh (empty) `ChunkPresence`.
pub const PRESENCE_EMPTY_LEN: usize = presence_len(0);

/// Rent a Player must be able to pay for one chunk over its life: the **full** chunk
/// (create + grow) plus the empty presence list.
pub const CHUNK_TOTAL_RENT: u64 = rent(CHUNK_FULL_LEN as u32) + rent(PRESENCE_EMPTY_LEN as u32);

/// `(cx, cz)` and `(nx, nz)` share an edge (N/S/E/W, not diagonal).
pub fn is_edge_neighbor(cx: i32, cz: i32, nx: i32, nz: i32) -> bool {
    let (dx, dz) = (cx as i64 - nx as i64, cz as i64 - nz as i64);
    dx.abs() + dz.abs() == 1
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
    /// CHECK: an existing N/S/E/W neighbor chunk of the same world (validated by
    /// `chunk_for` against its stored coordinates). Omit only for the world's first
    /// chunk (0,0).
    pub neighbor: Option<UncheckedAccount<'info>>,
    // TODO(Task 18): `player_state: Option<Account<PlayerState>>` — allow creating the
    // chunk the player currently stands in (`(cx, cz) == (player_state.cx, .cz)`), see
    // `check_adjacency`.
    /// CHECK: ephemeral rent vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

/// Adjacency rule: an existing, fully generated (`DONE`, else `ChunkNotReady`) edge neighbor
/// in `world` is passed, or the world has no chunks and this is (0,0). (Task 18 adds: the
/// player's current chunk.) `chunk_count` is why `create_chunk` / `close_chunk` take the
/// World writable; both are rare, so the write lock is acceptable (`populate_chunk` and
/// gameplay ixs take it read-only).
fn check_adjacency(
    neighbor: Option<&AccountInfo>,
    world: &Pubkey,
    chunk_count: u32,
    cx: i32,
    cz: i32,
) -> Result<()> {
    match neighbor {
        Some(n) => {
            let (nx, nz) = {
                let h = chunk_header(n)?;
                (h.cx.get(), h.cz.get())
            };
            // Identity (world, coordinates, PDA) of the neighbor itself, and it must be
            // fully generated (a squatted stage-0/1 chunk is not a foothold).
            let len = n.data_len();
            let stage = chunk_for(n, world, nx, nz)?.gen_stage;
            require!(
                stage == GEN_DONE && len >= CHUNK_FULL_LEN,
                MagicraftError::ChunkNotReady
            );
            require!(
                is_edge_neighbor(cx, cz, nx, nz),
                MagicraftError::NotAdjacent
            );
        }
        None => require!(
            chunk_count == 0 && cx == 0 && cz == 0,
            MagicraftError::NotAdjacent
        ),
    }
    Ok(())
}

/// Creates `Chunk (cx, cz)` at 10 240 bytes (`gen_stage = 0`) and its empty
/// `ChunkPresence`, both sponsored by the Player, which must be able to pay the rent of
/// the **full** chunk + presence and keep its reserve. `open_chunks += 1`,
/// `world.chunk_count += 1` (counters: checked `+1` here, saturating `−1` in `close_chunk`).
/// Follow with `grow_chunk` in the same tx.
#[session_auth_or(
    ctx.accounts.player.authority == ctx.accounts.signer.key(),
    MagicraftError::Unauthorized
)]
pub fn create_chunk(mut ctx: Context<CreateChunk>, cx: i32, cz: i32) -> Result<()> {
    let a = &ctx.accounts;
    let world_key = a.world.key();
    let neighbor = a.neighbor.as_ref().map(|n| n.to_account_info());
    check_adjacency(neighbor.as_ref(), &world_key, a.world.chunk_count, cx, cz)?;

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

    init_chunk_header(
        &mut chunk_ai.try_borrow_mut_data()?,
        a.player.key(),
        world_key,
        cx,
        cz,
        ctx.bumps.chunk,
    )?;
    init_presence_header(
        &mut presence_ai.try_borrow_mut_data()?,
        chunk_key,
        ctx.bumps.presence,
    )?;

    // TODO(Task 20): re-arm the existing neighbors' tick cranks (replace) so their
    // account lists include this chunk.
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
}

/// Stage 2 (caves, ores, trees, cacti, animals) on a `gen_stage == 1` chunk
/// (`WrongGenStage` otherwise); animals go into the mob slots; `gen_stage = DONE`. The
/// World is read-only; after populating (0,0) the client sends `set_spawn`.
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
    let (mut h, mut blocks) = chunk_parts_mut(&chunk_ai)?;
    let mut info = Box::new(Stage1Info::EMPTY);
    stage1_info_from_blocks(&blocks, &h.biomes, &mut info);
    let mut spawns = [MobSpawn::default(); MAX_SPAWNS];
    let n = generate_stage2(&seed, cx, cz, &mut blocks, &info, &mut spawns);
    for (i, s) in spawns.iter().take(n).enumerate() {
        h.set_mob(i, &Mob::from_spawn(s, cx, cz));
    }
    h.gen_stage = GEN_DONE;
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
/// coordinates of the feet block (Task 18 converts to FP). Permissionless; the client sends
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
/// original animals again. Cancels
/// the chunk's tick crank first if one was ever armed (unknown ids are a no-op).
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
    let (task_id, cbump) = {
        let h = chunk_for(&chunk_ai, &world_key, cx, cz)?;
        require_keys_eq!(h.payer, a.player.key(), MagicraftError::Unauthorized);
        require!(h.edited == 0, MagicraftError::ChunkEdited);
        require!(!h.has_blocking_mobs(), MagicraftError::ChunkHasMobs);
        (h.task_id.get(), h.bump)
    };
    {
        let (h, _) = presence_for(&presence_ai, chunk_ai.key)?;
        require!(h.count.get() == 0, MagicraftError::ChunkOccupied);
    }

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
    fn edge_neighbors_only() {
        assert!(is_edge_neighbor(0, 0, 1, 0));
        assert!(is_edge_neighbor(0, 0, 0, -1));
        assert!(is_edge_neighbor(i32::MIN, 5, i32::MIN + 1, 5));
        assert!(!is_edge_neighbor(0, 0, 1, 1));
        assert!(!is_edge_neighbor(0, 0, 0, 0));
        assert!(!is_edge_neighbor(0, 0, 2, 0));
        assert!(!is_edge_neighbor(i32::MAX, 0, i32::MIN, 0));
    }

    #[test]
    fn total_rent_is_full_chunk_plus_presence() {
        assert_eq!(CHUNK_TOTAL_RENT, (17_152 + 60) * 32 + (48 + 60) * 32);
    }
}
