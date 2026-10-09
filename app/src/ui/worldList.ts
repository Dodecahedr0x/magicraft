// World list: every World account on the ER (`getProgramAccounts` filtered by the World
// discriminator + data size), decoded, classified and sorted for the picker.
import { utils } from "@anchor-lang/core";
import type { Connection, PublicKey } from "@solana/web3.js";
import { decodeWorld, WORLD_DISCRIMINATOR, WORLD_LEN, type WorldAccount } from "../chain";

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

export async function fetchWorlds(er: Connection, programId: PublicKey, me: PublicKey | null): Promise<WorldEntry[]> {
  const accs = await er.getProgramAccounts(programId, { commitment: "confirmed", filters: worldFilters() });
  return decodeWorldList(accs, me);
}
