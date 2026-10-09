// Shared test setup: a fresh wallet with a funded Player delegated to the
// local ER, plus small polling utilities.
import { BN, web3 } from "@anchor-lang/core";
import {
  airdrop,
  baseConn,
  erConn,
  erProgramFor,
  program,
  programFor,
} from "./env";

export const LOCAL_ER_VALIDATOR = new web3.PublicKey(
  "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev"
);
export const LAMPORTS = web3.LAMPORTS_PER_SOL;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function i32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
}

/** Wait until the ER has the account (it clones delegated accounts on demand). */
export async function waitForEr(pk: web3.PublicKey, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await erConn.getAccountInfo(pk, "confirmed");
    if (info) return info;
    if (Date.now() > deadline) throw new Error(`ER never cloned ${pk}`);
    await sleep(300);
  }
}

/** Poll `fn` until it returns a truthy value or the timeout expires. */
export async function until<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  everyMs = 100
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > deadline) return v;
    await sleep(everyMs);
  }
}

export function playerPda(
  authority: web3.PublicKey,
  programId: web3.PublicKey
): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("player"), authority.toBuffer()],
    programId
  )[0];
}

/** The three base-layer ixs that create, fund and delegate a Player. */
export async function initDepositDelegateIxs(
  authority: web3.PublicKey,
  lamports: number,
  validator: web3.PublicKey = LOCAL_ER_VALIDATOR
): Promise<web3.TransactionInstruction[]> {
  const base = program; // ix builder only; signer comes from the tx
  return [
    await base.methods.initPlayer().accounts({ authority }).instruction(),
    await base.methods
      .deposit(new BN(lamports))
      .accounts({ authority })
      .instruction(),
    await base.methods
      .delegatePlayer(validator)
      .accounts({ authority })
      .instruction(),
  ];
}

/** A fresh wallet whose Player is created, funded with `depositSol` and
 *  delegated in one base tx, and already cloned by the ER. */
export async function setupPlayer(opts: { depositSol: number }) {
  const authority = web3.Keypair.generate();
  const base = programFor(baseConn, authority);
  const er = erProgramFor(authority);
  const player = playerPda(authority.publicKey, base.programId);
  await airdrop(authority.publicKey, 2);
  const tx = new web3.Transaction().add(
    ...(await initDepositDelegateIxs(
      authority.publicKey,
      opts.depositSol * LAMPORTS
    ))
  );
  await base.provider.sendAndConfirm!(tx, [], { skipPreflight: true });
  await waitForEr(player);
  return { authority, base, er, player };
}

export type TestPlayer = Awaited<ReturnType<typeof setupPlayer>>;
