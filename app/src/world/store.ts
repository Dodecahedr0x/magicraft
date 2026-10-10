// Chunk store: the client's live copy of the chunks around the player.
//
// - Loads every chunk within `radius` of the center (circle `dx² + dz² ≤ r² + r`): one
//   `onAccountChange` subscription per chunk (also for chunks that don't exist yet, so a
//   creation by anyone shows up) + one batched `getMultipleAccountsInfo` for the initial
//   state. Chunks beyond `keep` (default radius + 1) are unsubscribed and dropped.
// - On every account change the header is re-read and the block bytes are diffed against
//   the previous copy: header-only writes (crank ticks, mobs) don't re-mesh; changed blocks
//   mark the chunk dirty, and changes on a border column also mark that neighbor dirty
//   (its culled faces depend on our border), and any change marks all 8 neighbors: sky light
//   (skylight.ts) spreads up to 15 blocks across chunk borders. A chunk gaining or losing
//   blocks (created, grown, closed) marks itself and its 8 neighbors. Dirty keys are
//   flushed to `onDirty` after a short debounce (nearest first).
// - Implements `ChunkView` (`exists` / `ready`) for the chain builders and `getBlock` for
//   physics (Task 25).
// - Optimistic edits (Task 26): `setLocal` writes a block byte locally (break / place sent,
//   not confirmed yet) and keeps it as an overlay re-applied over every account update until
//   `clearLocal` (confirmed) or `revertLocal` (failed: restore + re-read the chunk).
import type { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import { accountKind, CHUNK_GEN_STAGE_OFFSET, CHUNK_HEADER_SIZE, chunkBlocks, chunkPda, chunkReady, chunkKey, GEN_DONE, type ChunkView } from "../chain";
import { isFluid as isFluidByte } from "./blocks";
import { borderOf, DIRS, type MeshInput } from "./mesher";
import { AROUND } from "./skylight";

export type StoreConn = Pick<
  Connection,
  "getMultipleAccountsInfo" | "getAccountInfo" | "onAccountChange" | "removeAccountChangeListener"
>;

export type ChunkStatus = "loading" | "missing" | "present";

export type ChunkEntry = {
  cx: number;
  cz: number;
  key: string;
  pda: PublicKey;
  status: ChunkStatus;
  /** Raw account data while present. */
  data: Uint8Array | null;
  /** The 16 384 block bytes (view into `data`) once the chunk is full size. */
  blocks: Uint8Array | null;
  /** `gen_stage` while present (0 created, 1 grown, 2 done), else −1. */
  genStage: number;
  /** Subscription id. */
  sub: number | null;
  /** Bumped on every applied update (guards fetch results racing subscription updates). */
  version: number;
};

export type StoreOptions = {
  conn: StoreConn;
  programId: PublicKey;
  world: PublicKey;
  /** Load radius in chunks (default 4). */
  radius?: number;
  /** Unload beyond this radius (default radius + 1). */
  keep?: number;
  /** Debounce of dirty flushes, ms (default 30). */
  debounceMs?: number;
  /** Chunks to (re)mesh — or to remove, when `meshInput(key)` is null. */
  onDirty?: (keys: string[]) => void;
  /** Any status / header / block change of a loaded chunk (after it is applied). */
  onChange?: (e: ChunkEntry) => void;
};

/** In the load circle of radius `r` (chunk units). */
export const inRadius = (dx: number, dz: number, r: number) => dx * dx + dz * dz <= r * r + r;
/** Opposite of a `DIRS` index (N↔S, E↔W). */
const OPP = [1, 0, 3, 2];

export class ChunkStore implements ChunkView {
  readonly radius: number;
  readonly keep: number;
  private map = new Map<string, ChunkEntry>();
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Optimistic edits per chunk key: local block index → edit. */
  private overlay = new Map<string, Map<number, { b: number; old: number; seq: number }>>();
  private editSeq = 0;
  /** `moveBlocks` copies (per chunk key, by entry version). */
  private moveCache = new Map<string, { version: number; blocks: Uint8Array }>();
  center: [number, number] | null = null;

  constructor(readonly opts: StoreOptions) {
    this.radius = opts.radius ?? 4;
    this.keep = opts.keep ?? this.radius + 1;
  }

  // ------------------------------------------------------------ queries

  get(cx: number, cz: number): ChunkEntry | undefined {
    return this.map.get(chunkKey(cx, cz));
  }
  entry(key: string): ChunkEntry | undefined {
    return this.map.get(key);
  }
  entries(): IterableIterator<ChunkEntry> {
    return this.map.values();
  }
  get size() {
    return this.map.size;
  }

  exists(cx: number, cz: number): boolean {
    return this.get(cx, cz)?.status === "present";
  }
  ready(cx: number, cz: number): boolean {
    const e = this.get(cx, cz);
    return e?.status === "present" && e.genStage === GEN_DONE && !!e.data && chunkReady(e.data);
  }
  /** Loaded (initial state known) and known not to exist. */
  missing(cx: number, cz: number): boolean {
    return this.get(cx, cz)?.status === "missing";
  }

  /** Block id at **integer** world block coords (callers floor positions first).
   *
   *  Contract (physics, Task 25): `null` = unknown — the chunk is not loaded, does not
   *  exist, or is not fully generated (`gen_stage != DONE`; its blocks may still change and
   *  the chain rejects moves into it) — and must be treated as **solid**. y < 0 is null
   *  (solid); y ≥ 64 is air (0). */
  getBlock(x: number, y: number, z: number): number | null {
    if (y >= 64) return 0;
    if (y < 0) return null;
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const e = this.get(cx, cz);
    if (!e?.blocks || e.genStage !== GEN_DONE) return null;
    return e.blocks[(y * 16 + (z - cz * 16)) * 16 + (x - cx * 16)];
  }

  /** Block bytes of a ready chunk (`gen_stage == DONE`, full size), else null: what
   *  `move_player` may be passed (physics pre-validation, Task 25). */
  readyBlocks(cx: number, cz: number): Uint8Array | null {
    const e = this.get(cx, cz);
    return e?.blocks && e.genStage === GEN_DONE && this.ready(cx, cz) ? e.blocks : null;
  }

  // ------------------------------------------------------------ optimistic edits

  private locate(x: number, y: number, z: number) {
    if (y < 0 || y >= 64) return null;
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const e = this.get(cx, cz);
    if (!e?.blocks || e.genStage !== GEN_DONE) return null;
    const [lx, lz] = [x - cx * 16, z - cz * 16];
    return { e, lx, lz, i: (y * 16 + lz) * 16 + lx };
  }

  /** Writes block `b` at `(x, y, z)` locally and keeps it over account updates until
   *  `clearLocal` / `revertLocal` with the returned edit `seq` (a later edit of the same
   *  voxel supersedes it). Null if the chunk is not ready (nothing written). */
  setLocal(x: number, y: number, z: number, b: number): { seq: number; old: number } | null {
    const l = this.locate(x, y, z);
    if (!l) return null;
    const old = l.e.blocks![l.i];
    let m = this.overlay.get(l.e.key);
    if (!m) this.overlay.set(l.e.key, (m = new Map()));
    const prev = m.get(l.i);
    const seq = ++this.editSeq;
    // The chain value under stacked edits is the first edit's `old`.
    m.set(l.i, { b, old: prev ? prev.old : old, seq });
    l.e.blocks![l.i] = b;
    this.moveCache.delete(l.e.key);
    this.markEdit(l.e);
    return { seq, old };
  }

  private takeEdit(x: number, y: number, z: number, seq: number) {
    const l = this.locate(x, y, z);
    const m = l && this.overlay.get(l.e.key);
    const ed = m?.get(l!.i);
    if (!l || !m || !ed || ed.seq !== seq) return null;
    m.delete(l.i);
    if (!m.size) this.overlay.delete(l.e.key);
    this.moveCache.delete(l.e.key);
    return { l, ed };
  }

  /** Edit `seq` at `(x, y, z)` was confirmed: stop re-applying it (the chain has it now). */
  clearLocal(x: number, y: number, z: number, seq: number) {
    this.takeEdit(x, y, z, seq);
  }

  /** Edit `seq` at `(x, y, z)` failed: drop it, put `old` back (if the byte is still the
   *  edit's) and re-read the chunk from the chain. */
  revertLocal(x: number, y: number, z: number, seq: number, old: number) {
    const t = this.takeEdit(x, y, z, seq);
    if (!t) return;
    const { l, ed } = t;
    if (l.e.blocks![l.i] === ed.b) {
      l.e.blocks![l.i] = old;
      this.markEdit(l.e);
    }
    void this.refresh(l.e.key);
  }

  /** Number of pending optimistic edits (stats / tests). */
  get localEdits() {
    let n = 0;
    for (const m of this.overlay.values()) n += m.size;
    return n;
  }

  /** Block bytes for move pre-validation: `readyBlocks` with every pending edit taken
   *  conservatively — a pending break keeps the chain's (solid) block, a pending place
   *  shows the placed one — so no move is pre-validated through a block the chain may
   *  still hold. Cached per chunk version. */
  moveBlocks(cx: number, cz: number): Uint8Array | null {
    const blocks = this.readyBlocks(cx, cz);
    const e = this.get(cx, cz);
    const m = e && this.overlay.get(e.key);
    if (!blocks || !e || !m) return blocks;
    const hit = this.moveCache.get(e.key);
    if (hit && hit.version === e.version && hit.blocks.length) return hit.blocks;
    const copy = blocks.slice();
    for (const [i, ed] of m) if (ed.b === 0 || isFluidByte(ed.b)) copy[i] = ed.old;
    this.moveCache.set(e.key, { version: e.version, blocks: copy });
    return copy;
  }

  private markEdit(e: ChunkEntry) {
    this.markDirty(e.key);
    this.markAround(e);
  }

  /** Marks the 8 neighbors (their sky light may reach into / out of `e`). */
  private markAround(e: ChunkEntry) {
    for (const [dx, dz] of AROUND) this.markNeighbor(e.cx + dx, e.cz + dz);
  }

  /** Mesher input for `key` (copies), or null when it has no blocks. */
  meshInput(key: string): MeshInput | null {
    const e = this.map.get(key);
    if (!e?.blocks) return null;
    const borders = DIRS.map(([dx, dz], d) => {
      const nb = this.get(e.cx + dx, e.cz + dz)?.blocks;
      return nb ? borderOf(nb, OPP[d]) : null;
    });
    const around = AROUND.map(([dx, dz]) => this.get(e.cx + dx, e.cz + dz)?.blocks?.slice() ?? null);
    return { blocks: e.blocks.slice(), borders, around };
  }

  // ------------------------------------------------------------ loading

  /** Moves the load circle to `(cx, cz)`: subscribes + fetches new chunks, drops far ones.
   *  Resolves when the new chunks' initial state is applied. */
  async setCenter(cx: number, cz: number): Promise<void> {
    if (this.disposed) return;
    if (this.center && this.center[0] === cx && this.center[1] === cz) return;
    this.center = [cx, cz];
    for (const e of [...this.map.values()]) if (!inRadius(e.cx - cx, e.cz - cz, this.keep)) this.unload(e);
    const added: ChunkEntry[] = [];
    const r = this.radius;
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        if (!inRadius(dx, dz, r)) continue;
        const key = chunkKey(cx + dx, cz + dz);
        if (this.map.has(key)) continue;
        added.push(this.load(cx + dx, cz + dz));
      }
    added.sort((a, b) => this.dist(a) - this.dist(b));
    for (let i = 0; i < added.length; i += 100) await this.fetch(added.slice(i, i + 100));
  }

  private dist(e: { cx: number; cz: number }) {
    const c = this.center ?? [0, 0];
    return (e.cx - c[0]) ** 2 + (e.cz - c[1]) ** 2;
  }

  private load(cx: number, cz: number): ChunkEntry {
    const { conn, programId, world } = this.opts;
    const key = chunkKey(cx, cz);
    const pda = chunkPda(programId, world, cx, cz);
    const e: ChunkEntry = { cx, cz, key, pda, status: "loading", data: null, blocks: null, genStage: -1, sub: null, version: 0 };
    this.map.set(key, e);
    e.sub = conn.onAccountChange(pda, (info) => this.map.get(key) === e && this.apply(e, info), { commitment: "confirmed" });
    return e;
  }

  private unload(e: ChunkEntry) {
    this.map.delete(e.key);
    this.overlay.delete(e.key);
    this.moveCache.delete(e.key);
    if (e.sub !== null) void Promise.resolve(this.opts.conn.removeAccountChangeListener(e.sub)).catch(() => {});
    e.sub = null;
    // Removal of its mesh (meshInput is null now).
    if (e.blocks) this.markDirty(e.key);
  }

  private async fetch(es: ChunkEntry[]): Promise<void> {
    if (!es.length) return;
    const versions = es.map((e) => e.version);
    let infos: (AccountInfo<Uint8Array> | null)[];
    try {
      infos = await this.opts.conn.getMultipleAccountsInfo(
        es.map((e) => e.pda),
        "confirmed",
      );
    } catch (err) {
      console.warn("chunk fetch failed; retrying", err);
      await new Promise((r) => setTimeout(r, 1000));
      const left = es.filter((e) => this.map.get(e.key) === e && e.status === "loading");
      return this.fetch(left);
    }
    es.forEach((e, i) => {
      // Skip if unloaded meanwhile or a subscription update already arrived (newer).
      if (this.map.get(e.key) !== e || e.version !== versions[i]) return;
      this.apply(e, infos[i]);
    });
  }

  /** Re-reads one chunk now (after a tx that changed it, before its notification). */
  async refresh(key: string): Promise<void> {
    const e = this.map.get(key);
    if (!e) return;
    const v = e.version;
    try {
      const info = await this.opts.conn.getAccountInfo(e.pda, "confirmed");
      if (this.map.get(key) === e && e.version === v) this.apply(e, info);
    } catch {
      /* the subscription will catch up */
    }
  }

  // ------------------------------------------------------------ updates

  private apply(e: ChunkEntry, info: AccountInfo<Uint8Array> | null) {
    if (this.disposed) return;
    const ok =
      !!info && info.owner.equals(this.opts.programId) && info.data.length >= CHUNK_HEADER_SIZE && accountKind(info.data) === "chunk";
    const data = ok ? Uint8Array.from(info.data) : null;
    const prev = e.blocks;
    e.version++;
    e.status = data ? "present" : "missing";
    e.data = data;
    e.genStage = data ? data[CHUNK_GEN_STAGE_OFFSET] : -1;
    e.blocks = data ? chunkBlocks(data) : null;
    const next = e.blocks;
    const ov = this.overlay.get(e.key);
    if (ov && next) for (const [i, ed] of ov) next[i] = ed.b;
    else if (ov && !data) this.overlay.delete(e.key);
    this.moveCache.delete(e.key);
    if (!prev !== !next) {
      this.markDirty(e.key);
      this.markAround(e);
    } else if (prev && next) {
      let changed = false;
      for (let i = 0; i < next.length && !changed; i++) changed = prev[i] !== next[i];
      if (changed) {
        this.markDirty(e.key);
        this.markAround(e);
      }
    }
    try {
      this.opts.onChange?.(e);
    } catch (err) {
      console.error(err);
    }
  }

  private markNeighbor(cx: number, cz: number) {
    const nb = this.get(cx, cz);
    if (nb?.blocks) this.markDirty(nb.key);
  }

  private markDirty(key: string) {
    this.dirty.add(key);
    if (this.timer !== null || this.disposed) return;
    this.timer = setTimeout(() => this.flush(), this.opts.debounceMs ?? 30);
  }

  /** Emits the pending dirty keys now (nearest first). */
  flush() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty.size || this.disposed) return;
    const keys = [...this.dirty];
    this.dirty.clear();
    const c = this.center ?? [0, 0];
    const d = (k: string) => {
      const [x, z] = k.split(",").map(Number);
      return (x - c[0]) ** 2 + (z - c[1]) ** 2;
    };
    keys.sort((a, b) => d(a) - d(b));
    this.opts.onDirty?.(keys);
  }

  dispose() {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const e of this.map.values())
      if (e.sub !== null) void Promise.resolve(this.opts.conn.removeAccountChangeListener(e.sub)).catch(() => {});
    this.map.clear();
    this.overlay.clear();
    this.moveCache.clear();
    this.dirty.clear();
  }
}
