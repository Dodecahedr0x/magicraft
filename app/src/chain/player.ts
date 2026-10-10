// Player lifecycle builders (base layer + withdraw on the ER), ported from
// tests/helpers/player.ts. Wallet-signed: the UI's wallet adapter signs and sends.
//
// - Onboarding: one base tx `init_player` + `deposit` + `delegate_player(validator)`.
// - Top-up while delegated: the e-SPL `lamportsDelegatedTransferIx` (base tx, any wallet;
//   the ER credits the Player in ~100 ms; costs amount + 300 000 setup lamports + fee). A
//   plain base transfer to the delegated PDA is NOT a top-up (the ER never sees it).
// - Withdraw: `withdraw` on the ER (commit + undelegate, wallet-signed), then, once the
//   Player is back on base, `withdraw_base(lamports)` (keeps the rent-exempt minimum).
import { BN } from "@anchor-lang/core";
import {
  Transaction,
  type Connection,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { ClusterConfig } from "./config";
import { decodePlayer, PLAYER_LEN, type PlayerAccount } from "./layout";
import type { MagicraftProgram } from "./program";
import { playerPda } from "./pdas";
import { delegationRecordPda, recordValidator } from "./delegation";
/** Lamports the e-SPL program charges per top-up on top of the amount. */
export const TOPUP_SETUP_LAMPORTS = 300_000;

/** The three base-layer ixs that create, fund and delegate a Player (pinned to
 *  `cfg.erValidator`). */
export async function onboardingIxs(
  program: MagicraftProgram,
  cfg: ClusterConfig,
  authority: PublicKey,
  lamports: number | bigint,
): Promise<TransactionInstruction[]> {
  return [
    await program.methods.initPlayer().accounts({ authority }).instruction(),
    await program.methods
      .deposit(new BN(lamports.toString()))
      .accounts({ authority })
      .instruction(),
    await program.methods.delegatePlayer(cfg.erValidator).accounts({ authority }).instruction(),
  ];
}

/** Unsigned base tx (fee payer = wallet) with `ixs` and a fresh blockhash. */
export async function walletTx(
  base: Connection,
  feePayer: PublicKey,
  ixs: TransactionInstruction[],
): Promise<Transaction> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = feePayer;
  tx.recentBlockhash = (await base.getLatestBlockhash("confirmed")).blockhash;
  return tx;
}

/** Onboarding tx: create + fund + delegate the wallet's Player. */
export async function onboardingTx(
  program: MagicraftProgram,
  cfg: ClusterConfig,
  base: Connection,
  authority: PublicKey,
  lamports: number | bigint,
): Promise<Transaction> {
  return walletTx(base, authority, await onboardingIxs(program, cfg, authority, lamports));
}

/** The MagicBlock SDK is only needed for top-ups, so it is loaded on first use (its own
 *  chunk; it pulls in sizeable crypto / attestation deps). */
const sdk = () => import("@magicblock-labs/ephemeral-rollups-sdk");

/** Top-up ix for a delegated Player (fresh random 32-byte salt per call: the salt seeds a
 *  single-use lamports PDA). `payer` is any wallet. */
export async function topUpIx(
  payer: PublicKey,
  player: PublicKey,
  lamports: number | bigint,
  salt: Uint8Array = crypto.getRandomValues(new Uint8Array(32)),
): Promise<TransactionInstruction> {
  if (salt.length !== 32) throw new Error("top-up salt must be 32 bytes");
  return (await sdk()).lamportsDelegatedTransferIx(payer, player, BigInt(lamports), salt);
}

/** The e-SPL global rent PDA (sponsors the top-up's lamports PDA; pre-funded on MagicBlock
 *  clusters, the local stack needs a manual transfer). */
export const eSplRentPda = async (): Promise<PublicKey> => (await sdk()).deriveRentPda()[0];

/** `withdraw` (ER, wallet-signed): commit + undelegate the Player. */
export async function withdrawIx(program: MagicraftProgram, authority: PublicKey) {
  return program.methods.withdraw().accounts({ authority }).instruction();
}

/** `withdraw_base(lamports)` (base, wallet-signed, after undelegation): moves lamports
 *  from the Player to the wallet, keeping the Player rent-exempt. */
export async function withdrawBaseIx(
  program: MagicraftProgram,
  authority: PublicKey,
  lamports: number | bigint,
) {
  return program.methods
    .withdrawBase(new BN(lamports.toString()))
    .accounts({ authority })
    .instruction();
}

export type PlayerStatus =
  | { state: "none"; player: PublicKey }
  | { state: "base"; player: PublicKey; lamports: number; account: PlayerAccount }
  | {
      state: "delegated";
      player: PublicKey;
      /** The validator it is delegated to (base delegation record; null: unreadable). */
      validator: PublicKey | null;
      /** ER balance on the queried ER (null if it has not cloned it yet). */
      erLamports: number | null;
      account: PlayerAccount | null;
    };

/** Where the wallet's Player is: missing, on base (undelegated) or delegated (with the
 *  validator it is delegated to, its balance and state on `er`; `open_chunks` drives the
 *  withdraw warning). `er` data is only meaningful if `validator` runs `er`. */
export async function playerStatus(
  programId: PublicKey,
  base: Connection,
  er: Connection,
  authority: PublicKey,
): Promise<PlayerStatus> {
  const player = playerPda(programId, authority);
  const [info, rec] = await base.getMultipleAccountsInfo([player, delegationRecordPda(player)], "confirmed");
  if (!info) return { state: "none", player };
  if (info.owner.equals(programId))
    return { state: "base", player, lamports: info.lamports, account: decodePlayer(info.data) };
  const ei = await er.getAccountInfo(player, "confirmed");
  return {
    state: "delegated",
    player,
    validator: recordValidator(rec),
    erLamports: ei?.lamports ?? null,
    account: ei && ei.data.length >= PLAYER_LEN ? decodePlayer(ei.data) : null,
  };
}
