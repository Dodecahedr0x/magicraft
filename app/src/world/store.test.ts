import { Keypair, type AccountInfo, type PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { CHUNK_BLOCKS_OFFSET, CHUNK_GEN_STAGE_OFFSET, CHUNK_DISCRIMINATOR, CHUNK_FULL_LEN, chunkPda, GEN_DONE } from "../chain";
import { ChunkStore, inRadius, type StoreConn } from "./store";

const programId = Keypair.generate().publicKey;
const world = Keypair.generate().publicKey;

/** A fake ER: accounts by pubkey, subscriptions that tests can fire. */
function fakeConn() {
  const accounts = new Map<string, Uint8Array>();
  const subs = new Map<number, { pk: string; cb: (i: AccountInfo<Uint8Array>) => void }>();
  let next = 1;
  const info = (d: Uint8Array): AccountInfo<Uint8Array> => ({ data: d, owner: programId, lamports: 1, executable: false });
  const conn: StoreConn = {
    getMultipleAccountsInfo: vi.fn(async (pks: PublicKey[]) => pks.map((p) => (accounts.has(p.toBase58()) ? info(accounts.get(p.toBase58())!) : null))) as never,
    getAccountInfo: vi.fn(async (p: PublicKey) => (accounts.has(p.toBase58()) ? info(accounts.get(p.toBase58())!) : null)) as never,
    onAccountChange: vi.fn((pk: PublicKey, cb: (i: AccountInfo<Uint8Array>) => void) => {
      subs.set(next, { pk: pk.toBase58(), cb });
      return next++;
    }) as never,
    removeAccountChangeListener: vi.fn(async (id: number) => {
      subs.delete(id);
    }) as never,
  };
  const pk = (cx: number, cz: number) => chunkPda(programId, world, cx, cz).toBase58();
  return {
    conn,
    subs,
    put(cx: number, cz: number, d: Uint8Array) {
      accounts.set(pk(cx, cz), d);
    },
    /** Pushes a change notification for chunk (cx, cz). */
    push(cx: number, cz: number, d: Uint8Array) {
      accounts.set(pk(cx, cz), d);
      for (const s of subs.values()) if (s.pk === pk(cx, cz)) s.cb(info(d));
    },
    subscribed: () => new Set([...subs.values()].map((s) => s.pk)),
    pk,
  };
}

function chunkData(fill: (blocks: Uint8Array) => void = () => {}) {
  const d = new Uint8Array(CHUNK_FULL_LEN);
  d.set(CHUNK_DISCRIMINATOR, 0);
  d[CHUNK_GEN_STAGE_OFFSET] = GEN_DONE;
  fill(d.subarray(CHUNK_BLOCKS_OFFSET));
  return d;
}
const bi = (x: number, y: number, z: number) => (y * 16 + z) * 16 + x;

function countIn(r: number) {
  let n = 0;
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (inRadius(dx, dz, r)) n++;
  return n;
}

describe("ChunkStore", () => {
  it("subscribes within the radius and unsubscribes beyond keep", async () => {
    const f = fakeConn();
    const store = new ChunkStore({ conn: f.conn, programId, world, radius: 2, keep: 3 });
    await store.setCenter(0, 0);
    expect(f.subs.size).toBe(countIn(2));
    expect(f.subscribed().has(f.pk(2, 0))).toBe(true);
    expect(f.subscribed().has(f.pk(3, 0))).toBe(false);
    expect(f.conn.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
    // Move one chunk east: (−2, 0) is still within keep 3 of (1, 0).
    await store.setCenter(1, 0);
    expect(f.subscribed().has(f.pk(-2, 0))).toBe(true);
    expect(f.subscribed().has(f.pk(3, 0))).toBe(true);
    // Far away: everything old is dropped.
    await store.setCenter(20, 0);
    expect(f.subs.size).toBe(countIn(2));
    expect(f.subscribed().has(f.pk(0, 0))).toBe(false);
    expect(f.conn.removeAccountChangeListener).toHaveBeenCalled();
    store.dispose();
    expect(f.subs.size).toBe(0);
  });

  it("exposes ChunkView and getBlock", async () => {
    const f = fakeConn();
    f.put(0, 0, chunkData((b) => (b[bi(3, 10, 4)] = 7)));
    const stage1 = chunkData();
    stage1[CHUNK_GEN_STAGE_OFFSET] = 1;
    f.put(1, 0, stage1);
    const store = new ChunkStore({ conn: f.conn, programId, world, radius: 1 });
    await store.setCenter(0, 0);
    expect(store.exists(0, 0) && store.ready(0, 0)).toBe(true);
    expect(store.exists(1, 0)).toBe(true);
    expect(store.ready(1, 0)).toBe(false);
    expect(store.exists(0, 1) || store.ready(0, 1)).toBe(false);
    expect(store.missing(0, 1)).toBe(true);
    expect(store.missing(9, 9)).toBe(false); // not loaded: unknown
    expect(store.getBlock(3, 10, 4)).toBe(7);
    expect(store.getBlock(3, 11, 4)).toBe(0);
    expect(store.getBlock(3, 70, 4)).toBe(0);
    expect(store.getBlock(-1, 10, 4)).toBeNull(); // not loaded
    expect(store.getBlock(17, 10, 4)).toBeNull(); // (1,0) exists but is not generated
    expect(store.getBlock(3, -1, 4)).toBeNull();
  });

  it("re-meshes on block changes only, and border neighbors too", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeConn();
      f.put(0, 0, chunkData());
      f.put(-1, 0, chunkData());
      f.put(0, 1, chunkData());
      const dirty: string[][] = [];
      const store = new ChunkStore({ conn: f.conn, programId, world, radius: 1, onDirty: (k) => dirty.push(k) });
      await store.setCenter(0, 0);
      vi.runAllTimers();
      expect(new Set(dirty.flat())).toEqual(new Set(["0,0", "-1,0", "0,1"]));
      dirty.length = 0;

      // Header-only change: no re-mesh.
      const h = chunkData();
      h[100] = 9;
      f.push(0, 0, h);
      vi.runAllTimers();
      expect(dirty).toEqual([]);

      // Interior change: only (0,0).
      f.push(0, 0, chunkData((b) => (b[bi(5, 5, 5)] = 3)));
      vi.runAllTimers();
      expect(dirty).toEqual([["0,0"]]);
      dirty.length = 0;

      // West border column (lx = 0) changes: (0,0) and its west neighbor (−1,0).
      f.push(0, 0, chunkData((b) => ((b[bi(5, 5, 5)] = 3), (b[bi(0, 5, 5)] = 3))));
      vi.runAllTimers();
      expect(new Set(dirty.flat())).toEqual(new Set(["0,0", "-1,0"]));
      dirty.length = 0;

      // A chunk appearing marks itself and its loaded neighbors.
      f.push(1, 0, chunkData());
      vi.runAllTimers();
      expect(new Set(dirty.flat())).toEqual(new Set(["1,0", "0,0"]));
      expect(store.meshInput("0,0")!.borders.map((b) => !!b)).toEqual([false, true, true, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a subscription update that races the initial fetch wins", async () => {
    const f = fakeConn();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = f.conn.getMultipleAccountsInfo;
    f.conn.getMultipleAccountsInfo = (async (...a: Parameters<typeof orig>) => {
      const res = await orig(...a); // old state: (0,0) missing
      await gate;
      return res;
    }) as never;
    const store = new ChunkStore({ conn: f.conn, programId, world, radius: 0 });
    const p = store.setCenter(0, 0);
    await Promise.resolve();
    f.push(0, 0, chunkData()); // created while the fetch is in flight
    release();
    await p;
    expect(store.ready(0, 0)).toBe(true);
  });

  it("keeps optimistic edits over updates until cleared or reverted", async () => {
    const f = fakeConn();
    f.put(0, 0, chunkData((b) => (b[bi(15, 10, 3)] = 3)));
    f.put(1, 0, chunkData());
    const dirty: string[][] = [];
    const store = new ChunkStore({ conn: f.conn, programId, world, radius: 1, debounceMs: 0, onDirty: (k) => dirty.push(k) });
    await store.setCenter(0, 0);
    store.flush();
    dirty.length = 0;
    // Break (15, 10, 3) locally: the border neighbor (1, 0) re-meshes too.
    expect(store.setLocal(15, 10, 3, 0)).toBe(3);
    expect(store.getBlock(15, 10, 3)).toBe(0);
    expect(store.localEdits).toBe(1);
    store.flush();
    expect(dirty.flat().sort()).toEqual(["0,0", "1,0"]);
    // An unrelated update (crank tick) still carries the old block: the overlay wins.
    f.push(0, 0, chunkData((b) => (b[bi(15, 10, 3)] = 3)));
    expect(store.getBlock(15, 10, 3)).toBe(0);
    // Confirmed: overlay dropped; the chain's state arrives with the next update.
    store.clearLocal(15, 10, 3);
    expect(store.localEdits).toBe(0);
    f.push(0, 0, chunkData());
    expect(store.getBlock(15, 10, 3)).toBe(0);
    // A failed place is reverted (and the chunk re-read).
    expect(store.setLocal(4, 11, 4, 2)).toBe(0);
    expect(store.getBlock(4, 11, 4)).toBe(2);
    store.revertLocal(4, 11, 4, 0);
    expect(store.getBlock(4, 11, 4)).toBe(0);
    expect(store.localEdits).toBe(0);
    await Promise.resolve();
    expect(f.conn.getAccountInfo).toHaveBeenCalled();
    // Unknown chunk: nothing written.
    expect(store.setLocal(100, 10, 0, 0)).toBeNull();
    store.dispose();
  });
});
