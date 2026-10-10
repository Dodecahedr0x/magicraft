// LIVE end-to-end check of the chain layer against the local stack (`scripts/test.sh` runs it
// with LIVE=1 after the Anchor suite). Everything goes through `app/src/chain` + `ErSender`:
// onboarding → session → world + VRF seed → chunk (0,0) create/grow/populate/set_spawn →
// join → walk across a chunk border → break the block under the player → place a block on
// the border. Skipped unless LIVE is set.
import {
  Keypair,
  LAMPORTS_PER_SOL,
  type Connection,
  type PublicKey,
  type Transaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  attackPlayerIx,
  breakBlockIx,
  createAndGrowIxs,
  createWorldIx,
  freshNonce,
  joinWorldIx,
  leaveWorldIx,
  measureUsPerSlot,
  moveIx,
  pickupItemIx,
  placeBlockIx,
  populateChunkIx,
  requestSeedIx,
  sessionAuth,
  setSpawnIx,
  viewOf,
  waitClientMs,
  type Auth,
} from "./actions";
import { loadConfig } from "./config";
import { makeConnections } from "./connections";
import {
  blockIndex,
  chunkBlocks,
  chunkReady,
  decodeChunkHeader,
  decodeGroundItems,
  decodePlayerState,
  decodePresence,
  decodeWorld,
  DEFAULT_WORLD_PARAMS,
  FP,
  type V3,
} from "./layout";
import { chunkKey, chunkPda, presencePda, pstatePda, worldPda } from "./pdas";
import { onboardingTx, playerStatus } from "./player";
import { makeProgram } from "./program";
import { ErSender, type IxSource, type SendOptions } from "./sender";
import { createSessionTx, verifySession, type Session } from "./session";
import { PresenceWatch } from "../player/presence";

const env = process.env;
const LIVE = !!env.LIVE;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(100);
  }
}

/** core::blocks::is_solid: everything but air, torch and water (23..=30). */
const isSolid = (b: number) => !(b === 0 || b === 17 || (b >= 23 && b <= 30));
/** Feet y on top of a column's topmost block, or null if that block isn't solid. */
function surface(blocks: Uint8Array, lx: number, lz: number): number | null {
  for (let y = 63; y >= 0; y--) {
    const b = blocks[blockIndex(lx, y, lz)];
    if (b !== 0) return isSolid(b) ? y + 1 : null;
  }
  return null;
}
/** Shortest walk over column centers (up ≤ 1, down ≤ 3) from `start` into chunk `target`
 *  (port of tests/helpers/play.ts `planWalk`). Waypoints `[x, feetY, z]`, start excluded. */
function planWalk(blocks: Map<string, Uint8Array>, start: [number, number], target: [number, number]): V3[] | null {
  const h = (x: number, z: number) => {
    const [cx, cz] = [Math.floor(x / 16), Math.floor(z / 16)];
    const b = blocks.get(chunkKey(cx, cz));
    return b ? surface(b, x - cx * 16, z - cz * 16) : null;
  };
  const key = (x: number, z: number) => `${x},${z}`;
  const prev = new Map<string, string | null>([[key(...start), null]]);
  const queue: [number, number][] = [start];
  while (queue.length) {
    const [x, z] = queue.shift()!;
    const hy = h(x, z);
    if (hy === null) continue;
    if (Math.floor(x / 16) === target[0] && Math.floor(z / 16) === target[1]) {
      const path: V3[] = [];
      for (let k: string | null = key(x, z); k && k !== key(...start); k = prev.get(k)!) {
        const [px, pz] = k.split(",").map(Number);
        path.unshift([px, h(px, pz)!, pz]);
      }
      return path;
    }
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const [nx, nz] = [x + dx, z + dz];
      if (prev.has(key(nx, nz))) continue;
      const nh = h(nx, nz);
      if (nh === null || nh - hy > 1 || hy - nh > 3) continue;
      prev.set(key(nx, nz), key(x, z));
      queue.push([nx, nz]);
    }
  }
  return null;
}
const center = (x: number, y: number, z: number): V3 => [x * FP + FP / 2, y * FP, z * FP + FP / 2];
/** Surface blocks a bare hand breaks *and* gets a placeable item from (grass → dirt, dirt,
 *  sand, gravel). */
const HAND_DROPS = new Set([1, 2, 5, 7]);

describe.skipIf(!LIVE)("LIVE: chain layer against the local stack", { timeout: 240_000 }, () => {
  const cfg = loadConfig({
    VITE_BASE_RPC: env.PROVIDER_ENDPOINT ?? "http://127.0.0.1:8799",
    VITE_BASE_WS: env.WS_ENDPOINT,
    VITE_ER_RPC: env.EPHEMERAL_PROVIDER_ENDPOINT ?? "http://127.0.0.1:7799",
    VITE_ER_WS: env.EPHEMERAL_WS_ENDPOINT,
  });
  const { base, er } = makeConnections(cfg);
  const program = makeProgram(cfg, er);
  const pid = cfg.programId;
  const wallet = Keypair.generate();
  const failures: string[] = [];
  let session: Session;
  let sender: ErSender;
  let auth: Auth;
  let player: PublicKey;

  async function sendBase(conn: Connection, tx: Transaction) {
    tx.partialSign(wallet);
    const sig = await conn.sendRawTransaction(tx.serialize());
    const bh = await conn.getLatestBlockhash("confirmed");
    const r = await conn.confirmTransaction({ signature: sig, ...bh, blockhash: tx.recentBlockhash! }, "confirmed");
    expect(r.value.err, `base tx ${sig}`).toBeNull();
    return sig;
  }
  /** Sends on the ER through the app sender; fails the test with the mapped error + logs. */
  async function ok(src: IxSource, opts: SendOptions = {}) {
    const r = await sender.send(src, { logs: true, ...opts });
    if (r.status !== "confirmed")
      throw new Error(`ER tx ${r.status}: ${r.status === "failed" ? `${r.error.message}\n${r.error.logs?.join("\n")}` : ""}`);
    return r.sig;
  }
  const account = async (pk: PublicKey) => (await er.getAccountInfo(pk, "confirmed"))?.data ?? null;

  it("onboards a Player (init + deposit + delegate) and the ER clones it", async () => {
    const sig = await base.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
    await base.confirmTransaction({ signature: sig, ...(await base.getLatestBlockhash()) }, "confirmed");
    await sendBase(base, await onboardingTx(program, cfg, base, wallet.publicKey, 0.2 * LAMPORTS_PER_SOL));
    const st = await until(
      async () => {
        const s = await playerStatus(pid, base, er, wallet.publicKey);
        return s.state === "delegated" && s.erLamports !== null ? s : null;
      },
      20_000,
      "ER clone of the Player",
    );
    player = st.player;
    expect(st.state === "delegated" && st.account?.authority.equals(wallet.publicKey)).toBe(true);
  });

  it("creates a session (0-lamport key) on the base layer", async () => {
    const { tx, session: s } = await createSessionTx(base, pid, wallet.publicKey);
    await sendBase(base, tx);
    session = s;
    expect(await verifySession(base, s)).toBe(true);
    expect(await base.getBalance(s.kp.publicKey)).toBe(0);
    auth = sessionAuth(s, player);
    sender = new ErSender(er, s.kp, { programId: pid, onError: (f) => failures.push(f.message) });
  });

  let world: PublicKey;
  let hint: number | undefined;
  let spawn: V3;
  const existing = new Set<string>();
  const view = () => viewOf(existing);
  let path: V3[] = [];

  async function generate(cx: number, cz: number) {
    await ok(() => createAndGrowIxs(program, auth, world, cx, cz, view()), { gen: true });
    await ok(async () => [await populateChunkIx(program, world, cx, cz)], { gen: true });
    expect(chunkReady((await account(chunkPda(pid, world, cx, cz)))!)).toBe(true);
    existing.add(chunkKey(cx, cz));
  }
  const blocksOf = async (cx: number, cz: number) => chunkBlocks((await account(chunkPda(pid, world, cx, cz)))!)!;

  it("creates a world, gets its VRF seed, generates (0,0), sets spawn, finds a border walk", async () => {
    for (let attempt = 0; attempt < 4 && !path.length; attempt++) {
      existing.clear();
      const nonce = freshNonce();
      world = worldPda(pid, wallet.publicKey, nonce);
      const params = { ...DEFAULT_WORLD_PARAMS, zombieCapPerChunk: 0, mobTickMs: 60_000, dayLengthSecs: 600 };
      hint ??= await measureUsPerSlot(er);
      await ok(async () => [await createWorldIx(program, auth, nonce, "live test", params, hint)]);
      await ok(async () => [await requestSeedIx(program, auth, world)]);
      const w = await until(
        async () => {
          const d = await account(world);
          return d && decodeWorld(d).seedSet ? decodeWorld(d) : null;
        },
        10_000,
        "VRF seed",
      );
      expect(w.params).toEqual(params);
      expect(w.creator.equals(wallet.publicKey)).toBe(true);

      await generate(0, 0);
      const h = decodeChunkHeader((await account(chunkPda(pid, world, 0, 0)))!);
      expect(h.payer.equals(player) && h.cx === 0 && h.cz === 0).toBe(true);
      await ok(async () => [await setSpawnIx(program, world)]);
      const ws = decodeWorld((await account(world))!);
      expect(ws.spawnSet).toBe(true);
      spawn = ws.spawn;

      // A walk from spawn into a neighbor that ends on a hand-breakable, item-dropping block.
      for (const t of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as [number, number][]) {
        await generate(t[0], t[1]);
        const blocks = new Map([
          ["0,0", await blocksOf(0, 0)],
          [chunkKey(...t), await blocksOf(...t)],
        ]);
        const p = planWalk(blocks, [spawn[0], spawn[2]], t);
        if (!p || p.length < 2) continue;
        const [x, y, z] = p[p.length - 1];
        const under = blocks.get(chunkKey(...t))![blockIndex(x - t[0] * 16, y - 1, z - t[1] * 16)];
        if (HAND_DROPS.has(under)) {
          path = p;
          break;
        }
      }
    }
    expect(path.length, "a walkable border crossing onto dirt/grass/sand/gravel").toBeGreaterThan(1);
  });

  const pstate = () => pstatePda(pid, world, player);
  const state = async () => decodePlayerState((await account(pstate()))!);

  it("joins at spawn", async () => {
    await ok(async () => [await joinWorldIx(program, auth, world)]);
    const s = await state();
    expect(s.health).toBe(20);
    expect(s.move.pos).toEqual(center(spawn[0], spawn[1], spawn[2]));
  });

  it("walks across the chunk border (coalesced 'move' lane)", async () => {
    let s = await state();
    let prev = s.move.pos;
    let lastMs = s.move.lastMs;
    for (const [x, y, z] of path) {
      const pos = center(x, y, z);
      const clientMs = await waitClientMs(er, world, lastMs, 300);
      await ok(async () => [await moveIx(program, auth, world, { prev, pos, onGround: true, clientMs, view: view() })], {
        key: "move",
      });
      prev = pos; // last confirmed position, tracked locally
      lastMs = clientMs;
    }
    s = await state();
    expect(s.move.pos).toEqual(prev);
    const [tx, , tz] = path[path.length - 1];
    const [cx, cz] = [Math.floor(tx / 16), Math.floor(tz / 16)];
    expect([s.cx, s.cz]).toEqual([cx, cz]);
    const here = decodePresence((await account(presencePda(pid, chunkPda(pid, world, cx, cz))))!);
    expect(here.entries.some((e) => e.player.equals(player))).toBe(true);
    const home = decodePresence((await account(presencePda(pid, chunkPda(pid, world, 0, 0))))!);
    expect(home.entries.some((e) => e.player.equals(player))).toBe(false);
  });

  it("breaks the block under the player, picks the drop up and places one on the border", async () => {
    const [x, y, z] = path[path.length - 1];
    const below: V3 = [x, y - 1, z];
    const [cx, cz] = [Math.floor(x / 16), Math.floor(z / 16)];
    const idx = (b: V3) => blockIndex(b[0] - Math.floor(b[0] / 16) * 16, b[1], b[2] - Math.floor(b[2] / 16) * 16);
    await ok(async () => [await breakBlockIx(program, auth, world, below, view())]);
    expect((await blocksOf(cx, cz))[idx(below)]).toBe(0);
    // The drop lands in the hole under the feet (in pickup reach): pick it up.
    const drops = decodeGroundItems((await account(chunkPda(pid, world, cx, cz)))!, -Infinity);
    expect(drops.length, "a ground item").toBeGreaterThan(0);
    await ok(async () => Promise.all(drops.map((g) => pickupItemIx(program, auth, world, cx, cz, g.idx))));
    const inv = (await state()).inventory;
    const slot = inv.findIndex((s) => s.count > 0 && s.item >= 1 && s.item <= 22);
    expect(slot, "a placeable drop").toBeGreaterThanOrEqual(0);
    const item = inv[slot].item;

    // The previous waypoint: the column on the other side of the border, feet-level air
    // above solid ground (face-adjacent), not overlapping the player.
    const target = path[path.length - 2];
    const [tcx, tcz] = [Math.floor(target[0] / 16), Math.floor(target[2] / 16)];
    expect([tcx, tcz]).not.toEqual([cx, cz]);
    await ok(async () => [await placeBlockIx(program, auth, world, target, slot, view())]);
    expect((await blocksOf(tcx, tcz))[idx(target)]).toBe(item);
    const after = (await state()).inventory[slot];
    expect(after.item === item ? after.count : 0).toBe(inv[slot].count - 1);
    expect(failures).toEqual([]);
    expect(session.kp.publicKey.equals(auth.signer)).toBe(true);
  });

  // ---------------------------------------------------------------- a second client

  const walletB = Keypair.generate();
  let playerB: PublicKey;
  let authB: Auth;
  let senderB: ErSender;
  const stateOf = async (p: PublicKey) => decodePlayerState((await account(pstatePda(pid, world, p)))!);
  async function okB(src: IxSource, opts: SendOptions = {}) {
    const r = await senderB.send(src, { logs: true, ...opts });
    if (r.status !== "confirmed") throw new Error(`ER tx (B) ${r.status}: ${r.status === "failed" ? `${r.error.name} ${r.error.message}` : ""}`);
    return r.sig;
  }
  async function failsB(src: IxSource) {
    const r = await senderB.send(src);
    return r.status === "failed" ? r.error.name : r.status;
  }
  /** A's client view of the presence lists around it (the app's watcher). */
  let watchA: PresenceWatch;

  it("a second player onboards, joins and walks next to the first; the first one's client sees it", async () => {
    const sig = await base.requestAirdrop(walletB.publicKey, 2 * LAMPORTS_PER_SOL);
    await base.confirmTransaction({ signature: sig, ...(await base.getLatestBlockhash()) }, "confirmed");
    const tx = await onboardingTx(program, cfg, base, walletB.publicKey, 0.2 * LAMPORTS_PER_SOL);
    tx.partialSign(walletB);
    const s2 = await base.sendRawTransaction(tx.serialize());
    await base.confirmTransaction({ signature: s2, ...(await base.getLatestBlockhash()) }, "confirmed");
    playerB = (
      await until(
        async () => {
          const st = await playerStatus(pid, base, er, walletB.publicKey);
          return st.state === "delegated" && st.erLamports !== null ? st : null;
        },
        20_000,
        "ER clone of player B",
      )
    ).player;
    const { tx: stx, session: sb } = await createSessionTx(base, pid, walletB.publicKey);
    stx.partialSign(walletB);
    const s3 = await base.sendRawTransaction(stx.serialize());
    await base.confirmTransaction({ signature: s3, ...(await base.getLatestBlockhash()) }, "confirmed");
    authB = sessionAuth(sb, playerB);
    senderB = new ErSender(er, sb.kp, { programId: pid });
    await okB(async () => [await joinWorldIx(program, authB, world)]);

    // Along A's route, stopping 2 columns short of A (A placed a block on the last-but-one).
    let s = await stateOf(playerB);
    let prev = s.move.pos;
    let lastMs = s.move.lastMs;
    for (const [x, y, z] of path.slice(0, -2)) {
      const pos = center(x, y, z);
      const clientMs = await waitClientMs(er, world, lastMs, 300);
      await okB(async () => [await moveIx(program, authB, world, { prev, pos, onGround: true, clientMs, view: view() })], { key: "move" });
      prev = pos;
      lastMs = clientMs;
    }
    // A's client: the presence watcher around A finds B fresh (B can be in 0,0 or the neighbor).
    const a = await state();
    watchA = new PresenceWatch(er, pid, world, 1);
    watchA.setCenter(a.cx, a.cz);
    const seen = await until(async () => watchA.find(playerB.toBase58(), Date.now()), 5_000, "B in A's presence view");
    expect(seen.entry.pos).toEqual(prev);
  });

  it("PvP: B hits A; A leaves the world (pending damage applied) → B can't hit it", async () => {
    const a = await state();
    // A (who broke the block under its feet) drops into that hole: fresh again.
    const down: V3 = [a.move.pos[0], a.move.pos[1] - FP, a.move.pos[2]];
    const clientMs = await waitClientMs(er, world, a.move.lastMs, 600);
    await ok(async () => [await moveIx(program, auth, world, { prev: a.move.pos, pos: down, onGround: true, clientMs, view: view() })], { key: "move" });
    const pa = await state();
    await okB(async () => [await attackPlayerIx(program, authB, world, player, pa.cx, pa.cz)]);
    const listed = async () => decodePresence((await account(presencePda(pid, chunkPda(pid, world, pa.cx, pa.cz))))!).entries;
    expect((await listed()).find((e) => e.player.equals(player))?.pendingDamage).toBe(1);

    // A leaves (the game's "Back to worlds"): pending damage applied, entry gone.
    const health = pa.health;
    await ok(async () => [await leaveWorldIx(program, auth, world, pa.cx, pa.cz)]);
    expect((await state()).health).toBe(health - 1);
    expect((await listed()).some((e) => e.player.equals(player))).toBe(false);
    await until(async () => watchA.find(player.toBase58(), Date.now()) === null || null, 3_000, "A gone from the watcher");
    // B's next attack: the target left the world.
    // B's attack cooldown, on chain time.
    await waitClientMs(er, world, (await stateOf(playerB)).attackUntilMs, 200);
    expect(await failsB(async () => [await attackPlayerIx(program, authB, world, player, pa.cx, pa.cz)])).toBe("NoPlayer");
    watchA.dispose();
  });
});
