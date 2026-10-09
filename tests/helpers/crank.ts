// Chunk tick crank helpers: header crank fields, arm / debug-cancel builders and
// the executed `tick_chunk` txs of a chunk (with CU).
import { createHash } from "crypto";
import { web3 } from "@anchor-lang/core";
import { erConn, erProgram } from "./env";
import { chunkData } from "./chunk";

const programId = erProgram.programId;
const CRANK = new web3.PublicKey("Crank11111111111111111111111111111111111111");

/** Tick-crank task id: first 8 bytes of sha256("tick" ‖ chunk ‖ epoch u8),
 *  LE, masked positive (epoch 0 at create_chunk; a stale writable re-arm bumps it). */
export function tickTaskId(chunk: web3.PublicKey, epoch = 0): bigint {
  const h = createHash("sha256")
    .update(Buffer.from("tick"))
    .update(chunk.toBuffer())
    .update(Buffer.from([epoch]))
    .digest();
  const id = h.readBigInt64LE(0) & 0x7fff_ffff_ffff_ffffn;
  return id === 0n ? 1n : id;
}

/** Crank fields of a chunk header (offsets: state.rs). */
export function crankState(d: Buffer) {
  return {
    armed: d[83],
    taskId: d.readBigInt64LE(84),
    taskEpoch: d[765],
    lastTickMs: Number(d.readBigInt64LE(92)),
    tickCount: Number(d.readBigUInt64LE(100)),
  };
}

export async function crankOf(chunk: web3.PublicKey) {
  const d = await chunkData(chunk);
  return d ? crankState(d) : null;
}

/** Permissionless watchdog re-arm (`arm_chunk`). */
export async function armChunkIx(world: web3.PublicKey, chunk: web3.PublicKey) {
  return erProgram.methods
    .armChunk()
    .accountsPartial({ world, chunk })
    .instruction();
}

/** Localnet-only: cancel a chunk's tick task, header untouched. */
export async function debugCancelTickIx(
  world: web3.PublicKey,
  chunk: web3.PublicKey
) {
  return erProgram.methods
    .debugCancelTick()
    .accountsPartial({ world, chunk })
    .instruction();
}

export type TickTx = {
  sig: string;
  ok: boolean;
  cu: number;
  logs: string[];
  /** All account keys of the tx. */
  accounts: web3.PublicKey[];
};

const cuRe = new RegExp(`^Program ${programId.toBase58()} consumed (\\d+) of`);

/** Executed `tick_chunk` txs whose **center** is `chunk` (newest first; the
 *  last `limit` txs touching the chunk are inspected). */
export async function tickTxs(
  chunk: web3.PublicKey,
  limit = 60
): Promise<TickTx[]> {
  const sigs = await erConn.getSignaturesForAddress(
    chunk,
    { limit },
    "confirmed"
  );
  const out: TickTx[] = [];
  for (const s of sigs) {
    const tx = await erConn.getTransaction(s.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) continue;
    const logs = tx.meta?.logMessages ?? [];
    if (!logs.some((l) => l.includes("Instruction: TickChunk"))) continue;
    // Crank executions wrap the tick: a `Crank1111…` ix with accounts
    // `[validator, executor, program, ...tick accounts]` (tick at depth 2);
    // a direct call is a top-level magicraft ix. The center chunk is tick
    // account 1.
    const msg = tx.transaction.message;
    const keys = msg.getAccountKeys();
    const centerOf = (ix: (typeof msg.compiledInstructions)[number]) => {
      const prog = keys.get(ix.programIdIndex);
      const at = prog?.equals(programId) ? 1 : prog?.equals(CRANK) ? 4 : -1;
      return at >= 0 && ix.accountKeyIndexes.length > at
        ? keys.get(ix.accountKeyIndexes[at])
        : undefined;
    };
    if (!msg.compiledInstructions.some((ix) => centerOf(ix)?.equals(chunk)))
      continue;
    const m = logs.map((l) => cuRe.exec(l)).find((x) => x);
    out.push({
      sig: s.signature,
      ok: !s.err,
      cu: m ? Number(m[1]) : 0,
      logs,
      accounts: keys.staticAccountKeys,
    });
  }
  return out;
}

/** Ticks per second of a chunk's crank over `ms` of wall time. */
export async function tickRate(chunk: web3.PublicKey, ms: number) {
  const a = (await crankOf(chunk))!.tickCount;
  await new Promise((r) => setTimeout(r, ms));
  const b = (await crankOf(chunk))!.tickCount;
  return ((b - a) * 1000) / ms;
}

/** Summary line for a list of CU samples. */
export const cuStats = (v: number[]) =>
  v.length
    ? `min ${Math.min(...v)}, median ${
        [...v].sort((a, b) => a - b)[v.length >> 1]
      }, max ${Math.max(...v)} (${v.length})`
    : "none";

/** Localnet-only: puts a mob of `kind` (full hp) at FP feet `pos` into a free
 *  slot of the chunk holding it and arms that chunk's crank. */
export async function debugSpawnMobIx(
  world: web3.PublicKey,
  chunk: web3.PublicKey,
  kind: number,
  pos: number[]
) {
  return erProgram.methods
    .debugSpawnMob(kind, pos as [number, number, number])
    .accountsPartial({ world, chunk })
    .instruction();
}
