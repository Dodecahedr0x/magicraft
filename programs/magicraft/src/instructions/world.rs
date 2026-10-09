//! Worlds: `create_world` (ephemeral World sponsored by the Player, arms the day crank),
//! `request_seed` (VRF inside the ER, any delegated Player PDA pays), `callback_seed`.

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

use crate::auth::{player_seeds, world_seeds};
use crate::errors::MagicraftError;
use crate::instructions::crank::arm_day_crank;
use crate::state::{
    ensure_sponsor_reserve, Player, TimeAnchor, World, WorldParams, PLAYER_SEED, WORLD_SEED,
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
/// the seed unset and the clock anchored, and arms its day crank (World PDA = authority).
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
        clock: TimeAnchor::new(clock.slot, clock.unix_timestamp),
        day_ticks: 0,
        _reserved: [0; 18],
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
