//! Worlds: `create_world` (ephemeral World sponsored by the Player, arms the day crank),
//! `request_seed` (VRF inside the ER, any delegated Player PDA pays), `callback_seed`,
//! `close_world` (reclaim an untouched world's rent).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::Discriminator;
use ephemeral_rollups_sdk::anchor::{vrf, vrf_callback, MagicProgram};
use ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;
use ephemeral_rollups_sdk::ephemeral_accounts::{rent, EphemeralAccount};
use ephemeral_rollups_sdk::vrf::consts::IDENTITY as VRF_IDENTITY_SEED;
use ephemeral_rollups_sdk::vrf::instructions::{
    create_request_randomness_ix, RequestRandomnessParams,
};
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;
use session_keys::{session_auth_or, Session, SessionError, SessionTokenV2};

use crate::auth::{chunk_seeds, player_seeds, world_seeds};
use crate::errors::MagicraftError;
use crate::instructions::crank::arm_day_crank;
use crate::scheduler;
use crate::state::{
    chunk_for, ensure_sponsor_reserve, presence_for, Player, TimeAnchor, World, WorldParams,
    PLAYER_SEED, WORLD_SEED,
};

/// VRF queue for the world seed: the ER queue (fee-exempt, so the Player PDA can pay).
/// Builds with the `localnet` feature (scripts/test.sh) use the local stack's test queue.
#[cfg(not(feature = "localnet"))]
pub const VRF_QUEUE: Pubkey = ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE;
#[cfg(feature = "localnet")]
pub const VRF_QUEUE: Pubkey = ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_TEST_QUEUE;

/// Byte size of the World account (≤ 10 240, so one create CPI suffices).
pub const WORLD_LEN: usize = 8 + World::INIT_SPACE;

// ---------- create_world (ER) ----------

#[derive(Accounts, Session)]
#[instruction(nonce: u64)]
pub struct CreateWorld<'info> {
    /// Wallet or session key (also the tx fee payer on the ER; fees are 0).
    pub signer: Signer<'info>,
    /// Sponsor: pays the World's ephemeral rent. Delegated.
    #[account(mut, seeds = [PLAYER_SEED, player.authority.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
    #[session(signer = signer, authority = player.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
    /// CHECK: the World PDA, created here via the Magic program (fails if it exists).
    #[account(
        mut,
        seeds = [WORLD_SEED, player.authority.as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub world: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

/// Creates the World (`["world", player.authority, nonce]`), sponsored by the Player, with
/// the seed unset and the clock anchored at `us_per_slot_hint` µs per slot (the client's
/// measurement of the ER slot rate; clamped to `MIN/MAX_US_PER_SLOT`, 0 = the 50 ms default),
/// and arms its day crank (World PDA = authority).
/// Next steps for the client: `request_seed`, then chunk (0,0) once the seed is set.
#[session_auth_or(
    ctx.accounts.player.authority == ctx.accounts.signer.key(),
    MagicraftError::Unauthorized
)]
pub fn create_world(
    ctx: Context<CreateWorld>,
    nonce: u64,
    name: [u8; 32],
    params: WorldParams,
    us_per_slot_hint: u32,
) -> Result<()> {
    params.validate()?;
    let a = &ctx.accounts;
    let player_ai = a.player.to_account_info();
    let world_ai = a.world.to_account_info();
    ensure_sponsor_reserve(&player_ai, rent(WORLD_LEN as u32))?;

    let creator = a.player.authority;
    let (pbump, wbump, nonce_le) = ([a.player.bump], [ctx.bumps.world], nonce.to_le_bytes());
    let pseeds = player_seeds(&creator, &pbump);
    let wseeds = world_seeds(&creator, &nonce_le, &wbump);
    EphemeralAccount::new(&player_ai, &world_ai, &a.vault.to_account_info())
        .with_signer_seeds(&[&pseeds, &wseeds])
        .create(WORLD_LEN as u32)?;

    let clock = Clock::get()?;
    let mut world = World {
        creator,
        nonce,
        bump: ctx.bumps.world,
        name,
        params,
        seed: [0; 32],
        seed_set: false,
        spawn: [0; 3],
        spawn_set: false,
        time_of_day_ms: 0,
        day_task_id: 0,
        last_tick_ms: 0,
        chunk_count: 0,
        clock: TimeAnchor::new(clock.slot, clock.unix_timestamp, us_per_slot_hint),
        day_ticks: 0,
        day_epoch: 0,
        first_join_ms: 0,
        players_online: 0,
        entries: 0,
        _reserved: [0; 1],
    };
    world.day_task_id = arm_day_crank(&world_ai, &world)?;
    world.try_serialize(&mut &mut world_ai.try_borrow_mut_data()?[..])?;
    Ok(())
}

// ---------- request_seed (ER) ----------

#[vrf]
#[derive(Accounts, Session)]
pub struct RequestSeed<'info> {
    /// Wallet or session key of `player`'s authority (any player, not only the creator:
    /// the VRF output is unbiasable, so who pays does not matter).
    pub signer: Signer<'info>,
    /// A delegated Player: the VRF payer (signs via its seeds; mut ⇒ delegated on the ER).
    #[account(mut, seeds = [PLAYER_SEED, player.authority.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
    #[session(signer = signer, authority = player.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
    #[account(constraint = !world.seed_set @ MagicraftError::SeedAlreadySet)]
    pub world: Account<'info, World>,
    /// CHECK: the ER VRF queue (address-constrained).
    #[account(mut, address = VRF_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
}

/// Requests the world seed; the VRF program calls `callback_seed` (~110 ms locally).
/// `client_seed` is mixed into the caller seed (lets a client issue distinct requests in
/// one slot). Repeats before fulfilment are harmless: only the first callback writes.
#[session_auth_or(
    ctx.accounts.player.authority == ctx.accounts.signer.key(),
    MagicraftError::Unauthorized
)]
pub fn request_seed(ctx: Context<RequestSeed>, client_seed: [u8; 32]) -> Result<()> {
    let a = &ctx.accounts;
    let world = a.world.key();
    let slot = Clock::get()?.slot.to_le_bytes();
    let caller_seed =
        solana_sha256_hasher::hashv(&[b"seed", world.as_ref(), &slot, &client_seed]).to_bytes();
    let ix = create_request_randomness_ix(RequestRandomnessParams {
        payer: a.player.key(),
        oracle_queue: a.oracle_queue.key(),
        callback_program_id: crate::ID,
        callback_discriminator: crate::instruction::CallbackSeed::DISCRIMINATOR.to_vec(),
        caller_seed,
        accounts_metas: Some(vec![SerializableAccountMeta {
            pubkey: world,
            is_signer: false,
            is_writable: true,
        }]),
        ..Default::default()
    });
    // Not `invoke_signed_vrf`: it signs with the identity seed only, and the payer here is
    // a PDA, so both seed sets are needed.
    let authority = a.player.authority;
    let pbump = [a.player.bump];
    invoke_signed(
        &ix,
        &[
            a.player.to_account_info(),
            a.program_identity.to_account_info(),
            a.oracle_queue.to_account_info(),
            a.system_program.to_account_info(),
            a.slot_hashes.to_account_info(),
        ],
        &[
            &[VRF_IDENTITY_SEED, &[ctx.bumps.program_identity]],
            &player_seeds(&authority, &pbump),
        ],
    )?;
    Ok(())
}

// ---------- callback_seed (VRF program → ER) ----------

#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackSeed<'info> {
    #[account(
        mut,
        seeds = [WORLD_SEED, world.creator.as_ref(), &world.nonce.to_le_bytes()],
        bump = world.bump
    )]
    pub world: Account<'info, World>,
}

/// Stores the VRF output as the world seed, once. Nothing else (≈ 260k CU available, no
/// generation here).
pub fn callback_seed(ctx: Context<CallbackSeed>, randomness: [u8; 32]) -> Result<()> {
    ctx.accounts.world.set_seed(randomness)
}

// ---------- close_world (ER) ----------

#[derive(Accounts, Session)]
pub struct CloseWorld<'info> {
    pub signer: Signer<'info>,
    /// The creator's Player (the World's sponsor); receives the refunds. Delegated.
    #[account(mut, seeds = [PLAYER_SEED, player.authority.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
    #[session(signer = signer, authority = player.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
    /// CHECK: owner + discriminator checked in the handler (closed here, so not an
    /// `Account`: its exit would write the data back).
    #[account(mut)]
    pub world: UncheckedAccount<'info>,
    /// CHECK: chunk (0,0)'s PDA; validated by `chunk_for` when the world has it.
    /// Writable iff it exists (the ER rejects a writable missing account; the close CPI
    /// needs it writable).
    pub chunk: UncheckedAccount<'info>,
    /// CHECK: its presence list; validated by `presence_for` when the chunk exists.
    /// Writable iff the chunk exists.
    pub presence: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

/// Closes an **untouched** World, refunding all its rent to the creator's Player. Creator
/// only (wallet or session key). Untouched: nobody ever joined (`first_join_ms == 0`) and
/// it holds at most the spawn chunk (`chunk_count ≤ 1`; (0,0) is always the first chunk
/// and never closable on its own, so `chunk_count == 1` means only (0,0)), else
/// `WorldInUse`. The spawn chunk, if any, must be paid by this Player (`Unauthorized`),
/// unedited (`ChunkEdited`) and empty (`ChunkOccupied`); it is closed with its presence
/// list and its tick crank cancelled (it has no neighbors to unlink). The day crank is
/// cancelled (unknown ids are a no-op). A pending VRF callback then simply fails.
#[session_auth_or(
    ctx.accounts.player.authority == ctx.accounts.signer.key(),
    MagicraftError::Unauthorized
)]
pub fn close_world(ctx: Context<CloseWorld>) -> Result<()> {
    let a = &ctx.accounts;
    let world_ai = a.world.to_account_info();
    require_keys_eq!(*world_ai.owner, crate::ID, MagicraftError::Unauthorized);
    let world = World::try_deserialize(&mut &world_ai.try_borrow_data()?[..])?;
    require_keys_eq!(
        world.creator,
        a.player.authority,
        MagicraftError::Unauthorized
    );
    require!(
        world.first_join_ms == 0 && world.chunk_count <= 1,
        MagicraftError::WorldInUse
    );

    let player_ai = a.player.to_account_info();
    let vault_ai = a.vault.to_account_info();
    let authority = a.player.authority;
    let pbump = [a.player.bump];
    let pseeds = player_seeds(&authority, &pbump);
    let mut closed_chunk = false;

    if world.chunk_count == 1 {
        let chunk_ai = a.chunk.to_account_info();
        let presence_ai = a.presence.to_account_info();
        let (task_id, cbump) = {
            let h = chunk_for(&chunk_ai, world_ai.key, 0, 0)?;
            require_keys_eq!(h.payer, a.player.key(), MagicraftError::Unauthorized);
            require!(h.edited == 0, MagicraftError::ChunkEdited);
            (h.task_id.get(), h.bump)
        };
        {
            let (h, _) = presence_for(&presence_ai, chunk_ai.key)?;
            require!(h.count.get() == 0, MagicraftError::ChunkOccupied);
        }
        if task_id != 0 {
            let (zero, b) = (0i32.to_le_bytes(), [cbump]);
            scheduler::cancel(
                &chunk_ai,
                &chunk_seeds(world_ai.key, &zero, &zero, &b),
                task_id,
            )?;
        }
        for eph in [&chunk_ai, &presence_ai] {
            EphemeralAccount::new(&player_ai, eph, &vault_ai)
                .with_signer_seeds(&[&pseeds])
                .close()?;
        }
        closed_chunk = true;
    }

    if world.day_task_id != 0 {
        let (nonce, wbump) = (world.nonce.to_le_bytes(), [world.bump]);
        scheduler::cancel(
            &world_ai,
            &world_seeds(&world.creator, &nonce, &wbump),
            world.day_task_id,
        )?;
    }
    EphemeralAccount::new(&player_ai, &world_ai, &vault_ai)
        .with_signer_seeds(&[&pseeds])
        .close()?;

    if closed_chunk {
        let p = &mut ctx.accounts.player;
        p.open_chunks = p.open_chunks.saturating_sub(1);
    }
    Ok(())
}
