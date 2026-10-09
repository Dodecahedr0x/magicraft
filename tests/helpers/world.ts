// Shared world helpers: params, PDAs, create_world / request_seed builders and
// `setupWorld()` (a seeded world sponsored by a fresh or given Player).
import { createHash, randomBytes } from "crypto";
import { BN, web3 } from "@anchor-lang/core";
import { ER_TEST_QUEUE, erConn, erProgram, sendEr, TxError } from "./env";
import { setupPlayer, TestPlayer, until } from "./player";

export const WORLD_LEN = 265;
/** Ephemeral rent: (data_len + 60) * 32 lamports. */
export const ephemeralRent = (len: number) => (len + 60) * 32;

/** core::physics::WorldParams::default(), with a 60 s day for the tests. */
export const PARAMS = {
  walkSpeed: 1101,
  sprintSpeed: 1434,
  swimSpeed: 512,
  jumpVelocity: 2290,
  gravity: 8192,
  maxFallSpeed: 19968,
  reach: 1280,
  attackCooldownMs: 600,
  daySecs: 60,
  mobTickMs: 333,
  fluidTickMs: 250,
  fallDamage: 1,
  hunger: 1,
  zombieCapPerChunk: 4,
  pad: 0,
};
export function params(over: Partial<typeof PARAMS> = {}) {
  const p = { ...PARAMS, ...over };
  const { daySecs, ...rest } = p;
  return { ...rest, dayLengthSecs: daySecs };
}
export type WorldParamsArg = ReturnType<typeof params>;

export const programId = erProgram.programId;

export function worldPda(creator: web3.PublicKey, nonce: BN): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("world"),
      creator.toBuffer(),
      nonce.toArrayLike(Buffer, "le", 8),
    ],
    programId
  )[0];
}

/** Day-crank task id: first 8 bytes of sha256("day" ‖ world), LE, masked positive. */
export function dayTaskId(world: web3.PublicKey): bigint {
  const h = createHash("sha256")
    .update(Buffer.from("day"))
    .update(world.toBuffer())
    .digest();
  const id = h.readBigInt64LE(0) & 0x7fff_ffff_ffff_ffffn;
  return id === 0n ? 1n : id;
}

export const nameBytes = (s: string) => {
  const b = Buffer.alloc(32);
  b.write(s, "utf8");
  return [...b];
};

export async function fetchWorld(world: web3.PublicKey) {
  const info = await erConn.getAccountInfo(world, "confirmed");
  if (!info) return null;
  return { info, acc: erProgram.coder.accounts.decode("world", info.data) };
}

/** Compute units consumed by an ER tx. */
export async function cu(sig: string): Promise<number | undefined> {
  const tx = await erConn.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  return tx?.meta?.computeUnitsConsumed;
}

/** Resolves to the TxError if `p` rejects, else null. */
export const fails = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: TxError) => e
  );

let nonceCounter = Date.now();
export const freshNonce = () => new BN(nonceCounter++);

export async function createWorldIx(
  p: TestPlayer,
  o: {
    nonce: BN;
    params?: WorldParamsArg;
    signer?: web3.PublicKey;
    sessionToken?: web3.PublicKey | null;
  }
) {
  return p.er.methods
    .createWorld(o.nonce, nameBytes("test world"), o.params ?? params())
    .accountsPartial({
      signer: o.signer ?? p.authority.publicKey,
      player: p.player,
      sessionToken: o.sessionToken ?? null,
      world: worldPda(p.authority.publicKey, o.nonce),
    })
    .instruction();
}

export async function requestSeedIx(
  p: TestPlayer,
  world: web3.PublicKey,
  o: { signer?: web3.PublicKey; sessionToken?: web3.PublicKey | null } = {}
) {
  return p.er.methods
    .requestSeed([...randomBytes(32)])
    .accountsPartial({
      signer: o.signer ?? p.authority.publicKey,
      player: p.player,
      sessionToken: o.sessionToken ?? null,
      world,
      oracleQueue: ER_TEST_QUEUE,
    })
    .instruction();
}

/** Polls until the World's VRF seed is set (null on timeout). */
export async function waitSeed(world: web3.PublicKey, timeoutMs = 10_000) {
  return until(
    async () => {
      const w = await fetchWorld(world);
      return w?.acc.seedSet ? w : null;
    },
    timeoutMs,
    20
  );
}

/** A seeded world created (and its seed paid) by `p` (default: a fresh Player
 *  with `depositSol`, default 0.05 SOL). */
export async function setupWorld(
  o: { player?: TestPlayer; depositSol?: number; params?: WorldParamsArg } = {}
) {
  const p =
    o.player ?? (await setupPlayer({ depositSol: o.depositSol ?? 0.05 }));
  const nonce = freshNonce();
  const world = worldPda(p.authority.publicKey, nonce);
  await sendEr(
    [await createWorldIx(p, { nonce, params: o.params })],
    [p.authority]
  );
  await sendEr([await requestSeedIx(p, world)], [p.authority]);
  const w = await waitSeed(world);
  if (!w) throw new Error(`world ${world.toBase58()}: VRF seed never arrived`);
  return {
    p,
    world,
    nonce,
    seed: Buffer.from(w.acc.seed as number[]),
  };
}

export type TestWorld = Awaited<ReturnType<typeof setupWorld>>;
