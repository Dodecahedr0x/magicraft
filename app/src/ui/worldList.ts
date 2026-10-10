// World list: every World account on the ER (`getProgramAccounts` filtered by the World
// discriminator + data size), decoded, classified and sorted for the picker; and the silent
// players still counted in `World.playersOnline` (crashed clients), for `expire_players`.
import { utils } from "@anchor-lang/core";
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type Connection, type TransactionInstruction } from "@solana/web3.js";
import {
  chainEstimate,
  CHUNK_TOTAL_RENT,
  decodeWorld,
  ephemeralRent,
  EXPIRE_MS,
  expirePlayersIx,
  MAX_EXPIRE,
  PSTATE_DISCRIMINATOR,
  PSTATE_IN_WORLD_OFFSET,
  PSTATE_LEN,
  WORLD_DISCRIMINATOR,
  WORLD_LEN,
  type MagicraftProgram,
  type WorldAccount,
} from "../chain";

/** `ready`: joinable. `setup`: seeded but no spawn / (0,0) yet (its creator finishes it).
 *  `seeding`: waiting for the VRF seed. */
export type WorldStatus = "ready" | "setup" | "seeding";

export type WorldEntry = {
  pubkey: PublicKey;
  world: WorldAccount;
  mine: boolean;
  status: WorldStatus;
};

export const worldStatus = (w: Pick<WorldAccount, "seedSet" | "spawnSet">): WorldStatus =>
  w.spawnSet ? "ready" : w.seedSet ? "setup" : "seeding";

/** `close_world` accepts it: nobody ever joined and at most the spawn chunk exists
 *  (the creator check is `WorldEntry.mine`). */
export const worldClosable = (w: Pick<WorldAccount, "firstJoinMs" | "chunkCount">) => w.firstJoinMs === 0 && w.chunkCount <= 1;

/** Lamports `close_world` refunds: the World's rent, plus the spawn chunk's if it exists. */
export const worldCloseRefund = (w: Pick<WorldAccount, "chunkCount">) => ephemeralRent(WORLD_LEN) + (w.chunkCount ? CHUNK_TOTAL_RENT : 0);

/** `getProgramAccounts` filters selecting World accounts. */
export const worldFilters = () => [
  { dataSize: WORLD_LEN },
  { memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(WORLD_DISCRIMINATOR) } },
];

const RANK: Record<WorldStatus, number> = { ready: 0, setup: 1, seeding: 2 };

/** Decodes raw accounts (undecodable ones are skipped) and sorts them: playable first,
 *  then the viewer's own, then the busiest (most chunks), then by name. */
export function decodeWorldList(
  accounts: readonly { pubkey: PublicKey; account: { data: Uint8Array } }[],
  me: PublicKey | null,
): WorldEntry[] {
  const out: WorldEntry[] = [];
  for (const { pubkey, account } of accounts) {
    let world: WorldAccount;
    try {
      world = decodeWorld(account.data);
    } catch {
      continue;
    }
    out.push({ pubkey, world, mine: !!me && world.creator.equals(me), status: worldStatus(world) });
  }
  return out.sort(
    (a, b) =>
      RANK[a.status] - RANK[b.status] ||
      Number(b.mine) - Number(a.mine) ||
      b.world.chunkCount - a.world.chunkCount ||
      a.world.name.localeCompare(b.world.name) ||
      a.pubkey.toBase58().localeCompare(b.pubkey.toBase58()),
  );
}

/** What the picker shows: unfinished worlds only to their creator (who can finish them),
 *  narrowed by a case-insensitive name / creator / address query. */
export function visibleWorlds(entries: readonly WorldEntry[], query = ""): WorldEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter(
    (e) =>
      (e.status === "ready" || e.mine) &&
      (!q ||
        e.world.name.toLowerCase().includes(q) ||
        e.world.creator.toBase58().toLowerCase().startsWith(q) ||
        e.pubkey.toBase58().toLowerCase().startsWith(q)),
  );
}

/** Last fetched list per ER endpoint (= region) + program + viewer, so the picker can paint
 *  at once on re-entry; keyed by endpoint, a region switch never shows another ER's worlds
 *  (they only exist on the ER they were created on). */
const worldCache = new Map<string, WorldEntry[]>();
const cacheKey = (er: Pick<Connection, "rpcEndpoint">, programId: PublicKey, me: PublicKey | null) =>
  `${er.rpcEndpoint}|${programId.toBase58()}|${me?.toBase58() ?? ""}`;

/** The cached list for this ER / program / viewer (null if never fetched). */
export const cachedWorlds = (er: Pick<Connection, "rpcEndpoint">, programId: PublicKey, me: PublicKey | null): WorldEntry[] | null =>
  worldCache.get(cacheKey(er, programId, me)) ?? null;

/** Every World on `er` (the selected region's ER), decoded and sorted; refreshes the cache. */
export async function fetchWorlds(
  er: Pick<Connection, "rpcEndpoint" | "getProgramAccounts">,
  programId: PublicKey,
  me: PublicKey | null,
): Promise<WorldEntry[]> {
  const accs = await er.getProgramAccounts(programId, { commitment: "confirmed", filters: worldFilters() });
  const list = decodeWorldList(accs, me);
  worldCache.set(cacheKey(er, programId, me), list);
  return list;
}

// ---------------------------------------------------------------- players online

/** `PlayerState` bytes read per counted-in player: `world` @40 (32), `bump` @72, then the
 *  `MoveState`, whose `last_ms` i64 comes first (@73). */
const PS_SLICE = { offset: 40, length: 41 };

/** Counted-in PlayerStates (`in_world` = 1) per world (base58 → their keys) whose last move
 *  is older than `EXPIRE_MS` at chain time `nowOfWorld` (worlds without a reading: none). */
export function silentPlayers(
  states: readonly { pubkey: PublicKey; world: string; lastMs: number }[],
  nowOfWorld: ReadonlyMap<string, number>,
): Map<string, PublicKey[]> {
  const out = new Map<string, PublicKey[]>();
  for (const s of states) {
    const now = nowOfWorld.get(s.world);
    if (now === undefined || now - s.lastMs <= EXPIRE_MS + 1_000) continue;
    let l = out.get(s.world);
    if (!l) out.set(s.world, (l = []));
    l.push(s.pubkey);
  }
  return out;
}

/** The silent counted-in players of every world in `worlds` (one `getProgramAccounts` over
 *  the PlayerStates with `in_world` set, 41 bytes each), by world. A crashed or closed
 *  client stays counted in `World.playersOnline` until someone sends `expire_players`. */
export async function findSilentPlayers(er: Connection, programId: PublicKey, worlds: readonly WorldEntry[]): Promise<Map<string, PublicKey[]>> {
  const [accs, slot, clk] = await Promise.all([
    er.getProgramAccounts(programId, {
      commitment: "confirmed",
      dataSlice: PS_SLICE,
      filters: [
        { dataSize: PSTATE_LEN },
        { memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(PSTATE_DISCRIMINATOR) } },
        { memcmp: { offset: PSTATE_IN_WORLD_OFFSET, bytes: utils.bytes.bs58.encode(Uint8Array.of(1)) } },
      ],
    }),
    er.getSlot("confirmed"),
    er.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed"),
  ]);
  const states = accs.map(({ pubkey, account }) => {
    const d = account.data;
    return {
      pubkey,
      world: new PublicKey(d.subarray(0, 32)).toBase58(),
      lastMs: Number(new DataView(d.buffer, d.byteOffset, d.length).getBigInt64(33, true)),
    };
  });
  const wall = clk && clk.data.length >= 40 ? Number(new DataView(clk.data.buffer, clk.data.byteOffset).getBigInt64(32, true)) * 1000 + 500 : null;
  const nowOfWorld = new Map<string, number>();
  for (const e of worlds) {
    const now = chainEstimate(e.world, slot, wall);
    if (now !== null) nowOfWorld.set(e.pubkey.toBase58(), now);
  }
  return silentPlayers(states, nowOfWorld);
}

/** `expire_players` for the given silent players (≤ `MAX_EXPIRE` per tx); resolves to the
 *  number of txs that confirmed. */
export async function expireSilent(
  send: (build: () => Promise<TransactionInstruction>) => Promise<boolean>,
  program: MagicraftProgram,
  silent: ReadonlyMap<string, PublicKey[]>,
): Promise<number> {
  const sends: Promise<boolean>[] = [];
  for (const [w, keys] of silent)
    for (let i = 0; i < keys.length; i += MAX_EXPIRE) {
      const batch = keys.slice(i, i + MAX_EXPIRE);
      sends.push(send(() => expirePlayersIx(program, new PublicKey(w), batch)).catch(() => false));
    }
  return (await Promise.all(sends)).filter(Boolean).length;
}
