// Chunk helpers: PDAs, layout constants, generation tx builders and the
// `magicraft-core` reference generator (crates/core/examples/gen.rs).
import { execFileSync } from "child_process";
import * as path from "path";
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

/** Neighbor offsets N, S, E, W (`chunk_n/s/e/w`). */
export const NBR_OFF: [number, number][] = [
  [0, -1],
  [0, 1],
  [1, 0],
  [-1, 0],
];

/** The 4 neighbor slots of create_chunk / close_chunk: each neighbor's chunk
 *  PDA, writable iff it exists on the ER (the ER rejects a non-existent
 *  writable account). `over` replaces slots by index (tests). */
export async function neighborSlots(
  world: web3.PublicKey,
  cx: number,
  cz: number,
  over: (web3.PublicKey | null)[] = []
) {
  const keys = NBR_OFF.map(
    ([dx, dz], i) => over[i] ?? chunkPda(world, cx + dx, cz + dz)
  );
  const infos = await erConn.getMultipleAccountsInfo(keys, "confirmed");
  return keys.map((pubkey, i) => ({
    pubkey,
    writable: !!infos[i] && infos[i]!.owner.equals(programId),
  }));
}

/** Sets the writability of the `chunk_n/s/e/w` metas of a built ix. */
function applySlots(
  ix: web3.TransactionInstruction,
  slots: { pubkey: web3.PublicKey; writable: boolean }[]
) {
  for (const s of slots)
    for (const m of ix.keys)
      if (m.pubkey.equals(s.pubkey)) m.isWritable = s.writable;
  return ix;
}

export const computeBudgetIx = (units = 1_400_000) =>
  web3.ComputeBudgetProgram.setComputeUnitLimit({ units });

export async function createChunkIx(
  p: TestPlayer,
  world: web3.PublicKey,
  cx: number,
  cz: number,
  o: {
    /** Replaces neighbor slots (N, S, E, W) by index. */
    slots?: (web3.PublicKey | null)[];
    /** The player's PlayerState in `world` (creating its current chunk). */
    playerState?: web3.PublicKey | null;
    signer?: web3.PublicKey;
    sessionToken?: web3.PublicKey | null;
  } = {}
) {
  const chunk = chunkPda(world, cx, cz);
  const slots = await neighborSlots(world, cx, cz, o.slots);
  const ix = await p.er.methods
    .createChunk(cx, cz)
    .accountsPartial({
      signer: o.signer ?? p.authority.publicKey,
      player: p.player,
      sessionToken: o.sessionToken ?? null,
      world,
      chunk,
      presence: presencePda(chunk),
      chunkN: slots[0].pubkey,
      chunkS: slots[1].pubkey,
      chunkE: slots[2].pubkey,
      chunkW: slots[3].pubkey,
      playerState: o.playerState ?? null,
    })
    .instruction();
  return applySlots(ix, slots);
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
  const slots = await neighborSlots(world, cx, cz);
  const ix = await p.er.methods
    .closeChunk(cx, cz)
    .accountsPartial({
      signer: o.signer ?? p.authority.publicKey,
      player: p.player,
      sessionToken: o.sessionToken ?? null,
      world,
      chunk,
      presence: presencePda(chunk),
      chunkN: slots[0].pubkey,
      chunkS: slots[1].pubkey,
      chunkE: slots[2].pubkey,
      chunkW: slots[3].pubkey,
    })
    .instruction();
  return applySlots(ix, slots);
}

/** The client's generation tx 1: ComputeBudget 1.4M + create_chunk + grow_chunk
 *  (the neighbor slots are derived; an existing `DONE` neighbor is the foothold). */
export async function createAndGrow(
  p: TestPlayer,
  world: web3.PublicKey,
  cx: number,
  cz: number,
  units = 1_400_000
): Promise<string> {
  return sendEr(
    [
      computeBudgetIx(units),
      await createChunkIx(p, world, cx, cz),
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

let genBin: string | null = null;

/** Reference generation of chunk `(cx, cz)` for `seed` by magicraft-core
 *  (builds the `gen` example once per process, then runs the binary). */
export function referenceChunk(seed: Buffer, cx: number, cz: number): RefChunk {
  if (!genBin) {
    execFileSync("cargo", [
      "build",
      "--release",
      "-q",
      "-p",
      "magicraft-core",
      "--example",
      "gen",
    ]);
    genBin = path.join(__dirname, "../../target/release/examples/gen");
  }
  const out = execFileSync(
    genBin,
    [seed.toString("hex"), String(cx), String(cz)],
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
