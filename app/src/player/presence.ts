// Presence lists near the player (Task 26: `place_block` must not overlap any fresh
// presence entry). Subscribes to the `ChunkPresence` accounts of the 3×3 chunks around the
// player's chunk; lists outside that ring are fetched on demand. Task 27 (other players)
// can read the same cache.
import type { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import { accountKind, chunkKey, chunkPda, decodePresence, PRESENCE_STALE_MS, presencePda, type PresenceEntry } from "../chain";

/** Extra age an entry may have and still count as fresh for the overlap check, ms. */
export const FRESH_MARGIN_MS = 250;

type Slot = { key: string; sub: number | null; entries: PresenceEntry[] | null };

export type PresenceConn = Pick<Connection, "onAccountChange" | "removeAccountChangeListener" | "getMultipleAccountsInfo">;

export class PresenceWatch {
  private slots = new Map<string, Slot>();
  private center: string | null = null;
  private disposed = false;

  constructor(
    readonly conn: PresenceConn,
    readonly programId: PublicKey,
    readonly world: PublicKey,
  ) {}

  private pda(cx: number, cz: number) {
    return presencePda(this.programId, chunkPda(this.programId, this.world, cx, cz));
  }

  private decode(info: AccountInfo<Uint8Array> | null): PresenceEntry[] {
    if (!info || !info.owner.equals(this.programId) || accountKind(info.data) !== "presence") return [];
    try {
      return decodePresence(info.data).entries;
    } catch {
      return [];
    }
  }

  /** Keeps the 3×3 chunks around `(cx, cz)` subscribed. */
  setCenter(cx: number, cz: number) {
    const k = chunkKey(cx, cz);
    if (this.disposed || k === this.center) return;
    this.center = k;
    const want = new Set<string>();
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) want.add(chunkKey(cx + dx, cz + dz));
    for (const [key, s] of this.slots)
      if (!want.has(key)) {
        if (s.sub !== null) void Promise.resolve(this.conn.removeAccountChangeListener(s.sub)).catch(() => {});
        this.slots.delete(key);
      }
    const fresh: [number, number][] = [];
    for (const key of want) {
      if (this.slots.has(key)) continue;
      const [x, z] = key.split(",").map(Number);
      const s: Slot = { key, sub: null, entries: null };
      s.sub = this.conn.onAccountChange(this.pda(x, z), (i) => this.slots.get(key) === s && (s.entries = this.decode(i)), { commitment: "confirmed" });
      this.slots.set(key, s);
      fresh.push([x, z]);
    }
    void this.fetch(fresh).catch(() => {});
  }

  private async fetch(coords: [number, number][]): Promise<Map<string, PresenceEntry[]>> {
    const out = new Map<string, PresenceEntry[]>();
    if (!coords.length) return out;
    const infos = await this.conn.getMultipleAccountsInfo(
      coords.map(([x, z]) => this.pda(x, z)),
      "confirmed",
    );
    coords.forEach(([x, z], i) => {
      const key = chunkKey(x, z);
      const entries = this.decode(infos[i]);
      out.set(key, entries);
      const s = this.slots.get(key);
      if (s && s.entries === null) s.entries = entries;
    });
    return out;
  }

  /** Entries of the given chunks (cached, or fetched now), fresh at chain time `nowMs`
   *  within `PRESENCE_STALE_MS + FRESH_MARGIN_MS` (the clock estimate and the tx's landing
   *  time are a little off: err on counting an entry), or all of them when `nowMs` is null
   *  (unknown: the stricter choice). */
  async fresh(chunks: [number, number][], nowMs: number | null): Promise<PresenceEntry[]> {
    const out: PresenceEntry[] = [];
    const missing: [number, number][] = [];
    for (const [x, z] of chunks) {
      const e = this.slots.get(chunkKey(x, z))?.entries;
      if (e) out.push(...e);
      else missing.push([x, z]);
    }
    if (missing.length) for (const e of (await this.fetch(missing)).values()) out.push(...e);
    return nowMs === null ? out : out.filter((e) => nowMs - e.lastSeenMs <= PRESENCE_STALE_MS + FRESH_MARGIN_MS);
  }

  dispose() {
    this.disposed = true;
    for (const s of this.slots.values()) if (s.sub !== null) void Promise.resolve(this.conn.removeAccountChangeListener(s.sub)).catch(() => {});
    this.slots.clear();
  }
}

/** Chunks whose presence lists `place_block` checks for block `(x, _, z)`: its own chunk
 *  plus `actions::needed_neighbors` (x-edge, z-edge, diagonal). */
export function placePresenceChunks(x: number, z: number): [number, number][] {
  const cx = Math.floor(x / 16);
  const cz = Math.floor(z / 16);
  const edge = (l: number) => (l === 0 ? -1 : l === 15 ? 1 : 0);
  const dx = edge(x - cx * 16);
  const dz = edge(z - cz * 16);
  const out: [number, number][] = [[cx, cz]];
  if (dx) out.push([cx + dx, cz]);
  if (dz) out.push([cx, cz + dz]);
  if (dx && dz) out.push([cx + dx, cz + dz]);
  return out;
}
