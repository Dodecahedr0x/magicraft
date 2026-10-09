// Chunk helpers: PDAs, layout constants, generation tx builders and the
// `magicraft-core` reference generator (crates/core/examples/gen.rs).
import { execFileSync } from "child_process";
import { web3 } from "@anchor-lang/core";
import { erConn, erProgram, sendEr } from "./env";
import { TestPlayer } from "./player";
import { ephemeralRent } from "./world";

export const CHUNK_INITIAL_LEN = 10_240;
export const CHUNK_BLOCKS_OFFSET = 768;
export const CHUNK_VOL = 16_384;
export const CHUNK_FULL_LEN = CHUNK_BLOCKS_OFFSET + CHUNK_VOL; // 17 152
export const PRESENCE_EMPTY_LEN = 48;
/** Rent of one full chunk + its empty presence list. */
export const CHUNK_TOTAL_RENT =
  ephemeralRent(CHUNK_FULL_LEN) + ephemeralRent(PRESENCE_EMPTY_LEN);
/** `SPONSOR_RESERVE_MARGIN` in state.rs. */
export const SPONSOR_RESERVE_MARGIN = 100_000;
export const GEN_CREATED = 0;
export const GEN_STAGE1 = 1;
export const GEN_DONE = 2;

const programId = erProgram.programId;

const i32le = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v);
  return b;
};

export function chunkPda(
  world: web3.PublicKey,
  cx: number,
  cz: number
): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("chunk"), world.toBuffer(), i32le(cx), i32le(cz)],
    programId
  )[0];
}

export function presencePda(chunk: web3.PublicKey): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("presence"), chunk.toBuffer()],
    programId
  )[0];
}

export const computeBudgetIx = (units = 1_400_000) =>
  web3.ComputeBudgetProgram.setComputeUnitLimit({ units });

export async function createChunkIx(
  p: TestPlayer,
  world: web3.PublicKey,
  cx: number,
  cz: number,
  o: {
    neighbor?: web3.PublicKey | null;
    signer?: web3.PublicKey;
    sessionToken?: web3.PublicKey | null;
  } = {}
) {
  const chunk = chunkPda(world, cx, cz);
  return p.er.methods
    .createChunk(cx, cz)
    .accountsPartial({
      signer: o.signer ?? p.authority.publicKey,
      player: p.player,
      sessionToken: o.sessionToken ?? null,
      world,
      chunk,
      presence: presencePda(chunk),
      neighbor: o.neighbor ?? null,
    })
    .instruction();
}

/** Permissionless: any fee payer; `player` must be the chunk's payer Player. */
export async function growChunkIx(
  player: web3.PublicKey,
  world: web3.PublicKey,
  cx: number,
  cz: number
) {
  return erProgram.methods
    .growChunk(cx, cz)
    .accountsPartial({ player, world, chunk: chunkPda(world, cx, cz) })
    .instruction();
}

/** Permissionless: any fee payer. */
export async function populateChunkIx(
  world: web3.PublicKey,
  cx: number,
  cz: number
) {
  return erProgram.methods
    .populateChunk(cx, cz)
    .accountsPartial({ world, chunk: chunkPda(world, cx, cz) })
    .instruction();
}

export async function closeChunkIx(
  p: TestPlayer,
  world: web3.PublicKey,
  cx: number,
  cz: number,
  o: { signer?: web3.PublicKey; sessionToken?: web3.PublicKey | null } = {}
) {
  const chunk = chunkPda(world, cx, cz);
  return p.er.methods
    .closeChunk(cx, cz)
    .accountsPartial({
      signer: o.signer ?? p.authority.publicKey,
      player: p.player,
      sessionToken: o.sessionToken ?? null,
      world,
      chunk,
      presence: presencePda(chunk),
    })
    .instruction();
}

/** The client's generation tx 1: ComputeBudget 1.4M + create_chunk + grow_chunk. */
export async function createAndGrow(
  p: TestPlayer,
  world: web3.PublicKey,
  cx: number,
  cz: number,
  neighbor: web3.PublicKey | null = null
): Promise<string> {
  return sendEr(
    [
      computeBudgetIx(),
      await createChunkIx(p, world, cx, cz, { neighbor }),
      await growChunkIx(p.player, world, cx, cz),
    ],
    [p.authority]
  );
}

/** Permissionless: sets the world spawn from the populated chunk (0,0). */
export async function setSpawnIx(world: web3.PublicKey) {
  return erProgram.methods
    .setSpawn()
    .accountsPartial({ world, chunk: chunkPda(world, 0, 0) })
    .instruction();
}

/** Generation tx 2: ComputeBudget 1.4M + populate_chunk, paid by `payer`
 *  (default: a fresh 0-lamport keypair; populate is permissionless). */
export async function populate(
  world: web3.PublicKey,
  cx: number,
  cz: number,
  payer: web3.Keypair = web3.Keypair.generate()
): Promise<string> {
  return sendEr(
    [computeBudgetIx(), await populateChunkIx(world, cx, cz)],
    [payer]
  );
}

/** Raw chunk account data on the ER (null if absent). */
export async function chunkData(chunk: web3.PublicKey): Promise<Buffer | null> {
  return (await erConn.getAccountInfo(chunk, "confirmed"))?.data ?? null;
}

/** Decoded `ChunkHeader` fields used by tests (offsets: state.rs). */
export function chunkHeader(d: Buffer) {
  return {
    payer: new web3.PublicKey(d.subarray(8, 40)),
    world: new web3.PublicKey(d.subarray(40, 72)),
    cx: d.readInt32LE(72),
    cz: d.readInt32LE(76),
    bump: d[80],
    edited: d[81],
    genStage: d[82],
    crankArmed: d[83],
    taskId: d.readBigInt64LE(84),
    biomes: d.subarray(108, 364),
    mobs: d.subarray(364, 620),
  };
}

/** Output of `cargo run --release -p magicraft-core --example gen`. */
export type RefChunk = {
  stage1: Buffer;
  biomes: Buffer;
  blocks: Buffer;
  spawns: { kind: number; x: number; y: number; z: number }[];
  spawn: [number, number, number];
};

/** Reference generation of chunk `(cx, cz)` for `seed` by magicraft-core. */
export function referenceChunk(seed: Buffer, cx: number, cz: number): RefChunk {
  const out = execFileSync(
    "cargo",
    [
      "run",
      "--release",
      "-q",
      "-p",
      "magicraft-core",
      "--example",
      "gen",
      "--",
      seed.toString("hex"),
      String(cx),
      String(cz),
    ],
    { maxBuffer: 1 << 20 }
  );
  let o = 0;
  const take = (n: number) => out.subarray(o, (o += n));
  const stage1 = take(CHUNK_VOL);
  const biomes = take(256);
  const blocks = take(CHUNK_VOL);
  const n = take(1)[0];
  const spawns = [];
  for (let i = 0; i < 3; i++) {
    const [kind, x, y, z] = take(4);
    if (i < n) spawns.push({ kind, x, y, z });
  }
  const [sx, sy, sz] = take(3);
  if (o !== out.length)
    throw new Error(`gen: ${out.length} bytes, parsed ${o}`);
  return { stage1, biomes, blocks, spawns, spawn: [sx, sy, sz] };
}

/** CU consumed by each top-level magicraft ix of an ER tx, in order, plus the tx total. */
export async function ixCus(
  sig: string
): Promise<{ ixs: number[]; total: number }> {
  const tx = await erConn.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const re = new RegExp(`^Program ${programId.toBase58()} consumed (\\d+) of`);
  const ixs = (tx?.meta?.logMessages ?? [])
    .map((l) => re.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Number(m[1]));
  return { ixs, total: tx?.meta?.computeUnitsConsumed ?? 0 };
}
