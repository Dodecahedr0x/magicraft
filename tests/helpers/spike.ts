// Shared setup for the Task 4 spikes (crank + economics). Temporary, like the
// spike_* instructions it drives.
import { BN, web3 } from "@anchor-lang/core";
import {
  airdrop,
  baseConn,
  erConn,
  erProgramFor,
  programFor,
  sendEr,
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

export const CHUNK_LEN = 16_896;

/** A fresh wallet with a funded, delegated Player (base) and, optionally, a
 *  16 896-byte ephemeral spike chunk at (0, 0) on the ER (create + resize). */
export async function setupPlayer(opts: {
  depositSol: number;
  chunk?: boolean;
}) {
  const authority = web3.Keypair.generate();
  const base = programFor(baseConn, authority);
  const er = erProgramFor(authority);
  const [player] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("player"), authority.publicKey.toBuffer()],
    base.programId
  );
  const [chunk] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("chunk"), player.toBuffer(), i32le(0), i32le(0)],
    base.programId
  );
  await airdrop(authority.publicKey, 2);
  const tx = new web3.Transaction().add(
    await base.methods
      .initPlayer()
      .accounts({ authority: authority.publicKey })
      .instruction(),
    await base.methods
      .deposit(new BN(opts.depositSol * LAMPORTS))
      .accounts({ authority: authority.publicKey })
      .instruction(),
    await base.methods
      .delegatePlayer(LOCAL_ER_VALIDATOR)
      .accounts({ authority: authority.publicKey })
      .instruction()
  );
  await base.provider.sendAndConfirm!(tx, [], { skipPreflight: true });
  await waitForEr(player);
  if (opts.chunk) {
    await sendEr(
      [
        await er.methods
          .spikeChunk(0, 0, 10_240)
          .accounts({ authority: authority.publicKey })
          .instruction(),
        await er.methods
          .spikeResize(0, 0, CHUNK_LEN)
          .accounts({ authority: authority.publicKey })
          .instruction(),
      ],
      [authority]
    );
  }
  return { authority, base, er, player, chunk };
}

export type SpikePlayer = Awaited<ReturnType<typeof setupPlayer>>;
