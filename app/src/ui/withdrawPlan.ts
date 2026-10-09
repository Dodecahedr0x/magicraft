// Withdraw planning: the chunks a Player sponsors (ER `getProgramAccounts`, Chunk
// discriminator + `payer == player` at offset 8, header prefix only) and which of them
// `close_chunk` can reclaim before the withdraw (unedited, presence empty).
import { utils } from "@anchor-lang/core";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  CHUNK_DISCRIMINATOR,
  CHUNK_TOTAL_RENT,
  accountKind,
  chunkPda,
  decodePresence,
  presencePda,
} from "../chain";

/** Header prefix fetched per chunk: discriminator, payer @8, world @40, cx @72, cz @76,
 *  bump @80, edited @81, gen_stage @82. */
export const CHUNK_PREFIX_LEN = 83;

export type SponsoredChunk = {
  pubkey: PublicKey;
  world: PublicKey;
  cx: number;
  cz: number;
  edited: boolean;
  genStage: number;
};

/** Parses a chunk header prefix (null if it is not a chunk paid by `player`). */
export function parseChunkPrefix(pubkey: PublicKey, d: Uint8Array, player: PublicKey): SponsoredChunk | null {
  if (d.length < CHUNK_PREFIX_LEN) return null;
  for (let i = 0; i < 8; i++) if (d[i] !== CHUNK_DISCRIMINATOR[i]) return null;
  if (!new PublicKey(d.subarray(8, 40)).equals(player)) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    pubkey,
    world: new PublicKey(d.subarray(40, 72)),
    cx: dv.getInt32(72, true),
    cz: dv.getInt32(76, true),
    edited: d[81] !== 0,
    genStage: d[82],
  };
}

export type WithdrawPlan = {
  /** Unedited, nobody inside: `close_chunk` refunds `CHUNK_TOTAL_RENT` each. */
  closable: SponsoredChunk[];
  /** Edited: rent stays locked (by design). */
  edited: SponsoredChunk[];
  /** Spawn chunks (0,0): `close_chunk` refuses them (`SpawnChunk`); rent stays locked. */
  spawn: SponsoredChunk[];
  /** Unedited but someone (maybe a stale entry of yours) is listed inside: can't close now;
   *  left open, its rent is only reclaimable after delegating again. */
  occupied: SponsoredChunk[];
  /** Lamports the closable chunks refund. */
  refund: number;
};

/** Splits `chunks` by reclaimability; `presenceCount` maps a chunk PDA (base58) to its
 *  presence entry count (missing = unknown → treated as occupied). */
export function planWithdraw(chunks: readonly SponsoredChunk[], presenceCount: ReadonlyMap<string, number>): WithdrawPlan {
  const plan: WithdrawPlan = { closable: [], edited: [], spawn: [], occupied: [], refund: 0 };
  const sorted = [...chunks].sort(
    (a, b) => a.world.toBase58().localeCompare(b.world.toBase58()) || a.cx - b.cx || a.cz - b.cz,
  );
  for (const c of sorted) {
    if (c.cx === 0 && c.cz === 0) plan.spawn.push(c);
    else if (c.edited) plan.edited.push(c);
    else if (presenceCount.get(c.pubkey.toBase58()) !== 0) plan.occupied.push(c);
    else plan.closable.push(c);
  }
  // Close the farthest from (0,0) first: a chunk's neighbors stay linked until they close.
  plan.closable.sort((a, b) => Math.abs(b.cx) + Math.abs(b.cz) - (Math.abs(a.cx) + Math.abs(a.cz)));
  plan.refund = plan.closable.length * CHUNK_TOTAL_RENT;
  return plan;
}

/** Fetches the chunks `player` sponsors and their presence counts, then plans. */
export async function fetchWithdrawPlan(er: Connection, programId: PublicKey, player: PublicKey): Promise<WithdrawPlan> {
  const accs = await er.getProgramAccounts(programId, {
    commitment: "confirmed",
    dataSlice: { offset: 0, length: CHUNK_PREFIX_LEN },
    filters: [
      { memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(CHUNK_DISCRIMINATOR) } },
      { memcmp: { offset: 8, bytes: player.toBase58() } },
    ],
  });
  const chunks = accs.flatMap((a) => parseChunkPrefix(a.pubkey, a.account.data, player) ?? []).filter((c) => prefixMatches(programId, c));
  const counts = new Map<string, number>();
  const presences = chunks.map((c) => presencePda(programId, c.pubkey));
  for (let i = 0; i < presences.length; i += 100) {
    const infos = await er.getMultipleAccountsInfo(presences.slice(i, i + 100), "confirmed");
    infos.forEach((info, j) => {
      const c = chunks[i + j];
      if (info && accountKind(info.data) === "presence") counts.set(c.pubkey.toBase58(), decodePresence(info.data).count);
    });
  }
  return planWithdraw(chunks, counts);
}

/** Sanity: the chunk PDA of a parsed prefix matches its address (guards a bad slice). */
export const prefixMatches = (programId: PublicKey, c: SponsoredChunk) =>
  chunkPda(programId, c.world, c.cx, c.cz).equals(c.pubkey);

// ---------------------------------------------------------------- withdraw phases

/** Where an interrupted withdraw stands, from chain state:
 *  - `withdrawBase`: the Player is back on base (owned by our program) with SOL above its
 *    rent-exempt minimum → `withdraw_base`; `done` if nothing is left.
 *  - `settling`: base still delegated, but the ER no longer holds it delegated (or our
 *    `withdraw` tx is known to have landed) → wait for the base settlement.
 *  - `withdraw`: still delegated and live on the ER → send `withdraw`.
 *  - `none`: no Player on base. */
export type WithdrawPhase = "withdraw" | "settling" | "withdrawBase" | "done" | "none";

export function withdrawPhase(o: {
  programId: PublicKey;
  /** Owner of the Player on base (null: missing). */
  baseOwner: PublicKey | null;
  /** Base lamports above the rent-exempt minimum. */
  spendable: number;
  /** The ER holds the Player as a live delegated account. */
  onEr: boolean;
  /** A `withdraw` tx of ours confirmed on the ER. */
  withdrawLanded: boolean;
}): WithdrawPhase {
  if (!o.baseOwner) return "none";
  if (o.baseOwner.equals(o.programId)) return o.spendable > 0 ? "withdrawBase" : "done";
  if (o.withdrawLanded || !o.onEr) return "settling";
  return "withdraw";
}
