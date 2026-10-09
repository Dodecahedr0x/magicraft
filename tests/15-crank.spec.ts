// Chunk tick crank: `tick_chunk` scheduled with the Chunk PDA as task
// authority, armed by populate (animals), moves (watchdog), block edits (fluid
// work) and `arm_chunk`; idle ticks cancel their own task; busy ones renew it.
// Terrain is planned over magicraft-core reference blocks (`helpers/scout.ts`).
import { expect } from "chai";
import { web3 } from "@anchor-lang/core";
import { erConn, sendEr, TxError } from "./helpers/env";
import { setupPlayer, sleep, TestPlayer, until } from "./helpers/player";
import {
  chunkData,
  chunkPda,
  CHUNK_BLOCKS_OFFSET,
  closeChunkIx,
  createAndGrow,
  ixCus,
  populate,
  presencePda,
  referenceChunk,
  setSpawnIx,
} from "./helpers/chunk";
import { fetchWorld, params, setupWorld } from "./helpers/world";
import {
  center,
  chunkOf,
  fetchPlayerState,
  fetchPresence,
  isSolid,
  joinWorldIx,
  moveIx,
  nextClientMs,
  pstatePda,
  surface,
} from "./helpers/play";
import { Col, Terrain, V3, walkTree } from "./helpers/scout";
import {
  breakIx,
  chunkMobs,
  fluidQueue,
  localIndex,
  respawnIx,
  uniq,
} from "./helpers/actions";
import {
  armChunkIx,
  crankOf,
  cuStats,
  debugCancelTickIx,
  tickRate,
  tickTaskId,
  tickTxs,
} from "./helpers/crank";

const R = 2; // reference area: chunks −R..=R
const ZOMBIE = 4;
const isWater = (b: number) => b >= 23 && b <= 30;
const isFlowing = (b: number) => b >= 24 && b <= 30;
/** fluid "support": neither Air nor flowing water (unknown = support). */
const isSupport = (b: number) => b !== 0 && !isFlowing(b);
const REACH = 4.7; // planning reach, blocks (program: 5 + 0.5 slack)
const EYE = 1.62;
const key = (cx: number, cz: number) => `${cx},${cz}`;
const N4: Col[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** A breakable block within reach of a column walkable from the spawn that
 *  water will flow into once broken (water above it, or a horizontal water
 *  neighbour of level ≤ 6 standing on support). */
function findWater(t: Terrain, spawn: V3) {
  const tree = walkTree(t, [spawn[0], spawn[2]]);
  for (const c of tree.order) {
    const fy = t.h(...c)!;
    const eye = [c[0] + 0.5, fy + EYE, c[1] + 0.5];
    for (let y = fy - 4; y <= fy + 5; y++)
      for (let z = c[1] - 5; z <= c[1] + 5; z++)
        for (let x = c[0] - 5; x <= c[0] + 5; x++) {
          if (y < 1 || y > 62 || (x === c[0] && z === c[1])) continue;
          const d = Math.hypot(
            x + 0.5 - eye[0],
            y + 0.5 - eye[1],
            z + 0.5 - eye[2]
          );
          if (d > REACH) continue;
          const b = t.block(x, y, z);
          if (b === 255 || !isSolid(b) || b === 8 || b === 9) continue;
          const fed =
            isWater(t.block(x, y + 1, z)) ||
            N4.some(([dx, dz]) => {
              const n = t.block(x + dx, y, z + dz);
              return (
                isWater(n) &&
                n <= 29 &&
                isSupport(t.block(x + dx, y - 1, z + dz))
              );
            });
          if (fed) return { W: c, Q: [x, y, z] as V3, path: tree.path(c)! };
        }
  }
  return null;
}

describe("chunk tick crank", () => {
  let a: TestPlayer;
  let world: web3.PublicKey;
  let spawn: V3;
  let terrain: Terrain;
  let water: { W: Col; Q: V3; path: V3[] };
  let animalChunk: [number, number];
  const existing = new Set<string>();
  const cus = new Map<string, number[]>();

  const logCus = (name: string, v: number[]) =>
    cus.set(name, [...(cus.get(name) ?? []), ...v]);
  const c00 = () => chunkPda(world, 0, 0);
  const stranger = () => web3.Keypair.generate();

  async function state(p: TestPlayer = a, w = world) {
    return (await fetchPlayerState(pstatePda(w, p.player)))!;
  }

  /** One move of `a` to `pos` (default: stay in place). */
  async function move(pos?: number[], w = world, minDt = 160) {
    const st = await state(a, w);
    const clientMs = await nextClientMs(w, st.move.lastMs, minDt);
    return sendEr(
      [
        await moveIx(a, w, {
          prev: st.move.pos,
          pos: pos ?? st.move.pos,
          onGround: true,
          clientMs,
          existing,
        }),
      ],
      [a.authority]
    );
  }

  async function logsOf(sig: string): Promise<string[]> {
    const tx = await erConn.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return tx?.meta?.logMessages ?? [];
  }
  const armed = (logs: string[]) =>
    logs.some((l) => l.includes("tick crank armed"));

  /** In-place moves every `everyMs` for `ms`; returns the move signatures. */
  async function stayFor(ms: number, everyMs: number, w = world) {
    const sigs: string[] = [];
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const t0 = Date.now();
      try {
        sigs.push(await move(undefined, w));
      } catch (e) {
        // Killed by a zombie: respawn and carry on (the spawn is in (0,0)).
        if ((e as TxError).code !== "Dead") throw e;
        await sendEr([uniq(), await respawnIx(a, w)], [a.authority]);
      }
      await sleep(Math.max(0, everyMs - (Date.now() - t0)));
    }
    return sigs;
  }

  /** Creates (grow + populate) the chunks in `keys` in an order where each one
   *  has an existing edge neighbour (or is (0,0)). */
  async function createChunks(w: web3.PublicKey, keys: Set<string>) {
    const parent = new Map<string, string | null>([["0,0", null]]);
    const order = ["0,0"];
    for (let i = 0; i < order.length; i++) {
      const [cx, cz] = order[i].split(",").map(Number);
      for (const [dx, dz] of N4) {
        const k = key(cx + dx, cz + dz);
        if (Math.abs(cx + dx) > R || Math.abs(cz + dz) > R || parent.has(k))
          continue;
        parent.set(k, order[i]);
        order.push(k);
      }
    }
    const need = new Set(keys);
    for (const k of [...need]) {
      let p = parent.get(k);
      while (p) {
        need.add(p);
        p = parent.get(p);
      }
    }
    for (const k of order.filter((k) => need.has(k) && !existing.has(k))) {
      const [cx, cz] = k.split(",").map(Number);
      const par = parent.get(k);
      await createAndGrow(a, w, cx, cz);
      await populate(w, cx, cz);
      if (k === "0,0")
        await sendEr([await setSpawnIx(w)], [web3.Keypair.generate()]);
      existing.add(k);
    }
  }

  before(async function () {
    a = await setupPlayer({ depositSol: 0.5 });
    // World 1: long day and no zombies (zombies are tested in their own world).
    for (let attempt = 0; attempt < 40; attempt++) {
      const w = await setupWorld({
        player: a,
        params: params({ daySecs: 1200, zombieCapPerChunk: 0, mobTickMs: 333 }),
      });
      const chunks = new Map<string, Buffer>();
      const animals = new Map<string, number>();
      let sp: V3 = [0, 0, 0];
      for (let cx = -R; cx <= R; cx++)
        for (let cz = -R; cz <= R; cz++) {
          const r = referenceChunk(w.seed, cx, cz);
          chunks.set(key(cx, cz), r.blocks);
          animals.set(key(cx, cz), r.spawns.length);
          if (cx === 0 && cz === 0) sp = r.spawn;
        }
      // (0,0) without animals: it must be able to go idle.
      if (animals.get("0,0")) {
        console.log(`    world ${attempt}: animals in (0,0)`);
        continue;
      }
      const t = new Terrain(chunks);
      const wat = findWater(t, sp);
      if (!wat || wat.path.length > 40) {
        console.log(`    world ${attempt}: no water near the spawn`);
        continue;
      }
      const route = new Set<string>([key(0, 0)]);
      for (const p of [...wat.path, wat.Q])
        route.add(key(Math.floor(p[0] / 16), Math.floor(p[2] / 16)));
      // A chunk with animals next to (0,0), off the route (wander + close).
      const x = N4.map(([dx, dz]) => [dx, dz] as [number, number]).find(
        ([cx, cz]) => animals.get(key(cx, cz)) && !route.has(key(cx, cz))
      );
      if (!x) {
        console.log(`    world ${attempt}: no animal chunk next to (0,0)`);
        continue;
      }
      world = w.world;
      spawn = sp;
      terrain = t;
      water = wat;
      animalChunk = x;
      await createChunks(world, route);
      console.log(
        `    world ${attempt}: ${existing.size} route chunks; spawn ${spawn}; water break ${water.Q} after ${water.path.length} steps; animals in (${x})`
      );
      break;
    }
    expect(world, "a world that fits").to.not.equal(undefined);
    await sendEr([await joinWorldIx(a, world)], [a.authority]);
  });

  after(() => {
    for (const [k, v] of cus) console.log(`    CU ${k}: ${cuStats(v)}`);
  });

  it("populate arms a chunk with animals: they wander; arm_chunk on a live crank is a no-op", async () => {
    const [ax, az] = animalChunk;
    await createChunks(world, new Set([key(ax, az)]));
    const ck = chunkPda(world, ax, az);
    const d0 = (await chunkData(ck))!;
    const s0 = (await crankOf(ck))!;
    expect(s0.armed, "armed by populate").to.equal(1);
    const pos0 = chunkMobs(d0).map((m) => m.pos.join());
    const moved = await until(
      async () => {
        const m = chunkMobs((await chunkData(ck))!);
        return m.some((x, i) => x.kind && x.pos.join() !== pos0[i]) || null;
      },
      8_000,
      200
    );
    expect(moved, "an animal moved").to.equal(true);

    // Re-arming a live crank (twice, two callers) neither replaces it nor
    // changes its rate.
    const r1 = await tickRate(ck, 2_500);
    for (let i = 0; i < 2; i++) {
      const sig = await sendEr([await armChunkIx(world, ck)], [stranger()]);
      const logs = await logsOf(sig);
      expect(armed(logs), "no re-arm while alive").to.equal(false);
      logCus("arm_chunk (alive, no-op)", [(await ixCus(sig)).ixs[0]]);
    }
    const r2 = await tickRate(ck, 2_500);
    console.log(`    animal chunk: ${r1} ticks/s, after 2 re-arms ${r2}`);
    expect(r1).to.be.within(2.4, 5.2);
    expect(r2).to.be.within(2.4, 5.2);
    const txs = await tickTxs(ck);
    expect(txs.length).to.be.above(0);
    expect(txs.every((t) => t.ok)).to.equal(true);
    logCus(
      "tick_chunk (animals, nobody near)",
      txs.map((t) => t.cu)
    );

    // A task that dies while believed armed (dropped, or its id squatted): once
    // stale, the writable watchdog cancels it and re-arms under the next epoch.
    expect((await crankOf(ck))!.taskId).to.equal(tickTaskId(ck, 0));
    await sendEr([await debugCancelTickIx(world, ck)], [stranger()]);
    await sleep(3_500);
    const sig = await sendEr([await armChunkIx(world, ck)], [stranger()]);
    expect(armed(await logsOf(sig)), "stale → re-armed").to.equal(true);
    logCus("arm_chunk (stale: cancel + rotate + schedule)", [
      (await ixCus(sig)).ixs[0],
    ]);
    const st = (await crankOf(ck))!;
    expect(st.taskId, "rotated id").to.equal(tickTaskId(ck, 1));
    await sleep(1_000);
    expect((await crankOf(ck))!.tickCount, "ticking again").to.be.above(
      st.tickCount
    );
  });

  it("closing a chunk cancels its crank", async () => {
    const [ax, az] = animalChunk;
    const ck = chunkPda(world, ax, az);
    const n0 = (await tickTxs(ck)).length;
    await sleep(600);
    expect((await tickTxs(ck)).length, "ticking before").to.be.above(n0);
    const close = await sendEr(
      [await closeChunkIx(a, world, ax, az)],
      [a.authority]
    );
    existing.delete(key(ax, az));
    logCus("close_chunk (cancel + relink 1 neighbor)", [
      (await ixCus(close)).ixs[0],
    ]);
    await sleep(500);
    const sigs = async () =>
      (await erConn.getSignaturesForAddress(ck, { limit: 100 }, "confirmed"))
        .length;
    const s1 = await sigs();
    await sleep(2_000);
    expect(await sigs(), "no tick tx after the close").to.equal(s1);
  });

  it("a move arms the mover's chunk; it ticks at the interval; extra moves don't re-arm", async () => {
    const first = await move(center(...spawn));
    expect(armed(await logsOf(first)), "first move arms").to.equal(true);
    logCus("move_player (arming)", [(await ixCus(first)).ixs[0]]);
    await sleep(500);
    const t0 = (await crankOf(c00()))!;
    expect(t0.armed).to.equal(1);
    // Slow movers vs fast movers: same tick rate (re-arms are stale-gated).
    const c1 = (await crankOf(c00()))!.tickCount;
    const t1 = Date.now();
    const slow = await stayFor(3_000, 1_000);
    const r1 =
      (((await crankOf(c00()))!.tickCount - c1) * 1000) / (Date.now() - t1);
    const c2 = (await crankOf(c00()))!.tickCount;
    const t2 = Date.now();
    const fast = await stayFor(3_000, 0);
    const r2 =
      (((await crankOf(c00()))!.tickCount - c2) * 1000) / (Date.now() - t2);
    console.log(
      `    (0,0): ${r1.toFixed(2)} ticks/s with ${
        slow.length
      } moves, ${r2.toFixed(2)} with ${fast.length} moves`
    );
    for (const s of [...slow, ...fast])
      expect(armed(await logsOf(s)), "no re-arm").to.equal(false);
    expect(r1).to.be.within(2.4, 5.2);
    expect(r2).to.be.within(2.4, 5.2);
    const txs = await tickTxs(c00());
    expect(txs.every((t) => t.ok)).to.equal(true);
    logCus(
      "tick_chunk (player present, no mobs)",
      txs.map((t) => t.cu)
    );
  });

  it("idle (no fluid, no mobs, no fresh presence): the tick cancels its own task", async () => {
    // Stop moving: the presence entry goes stale after 5 s.
    const idle = await until(
      async () => ((await crankOf(c00()))!.armed === 0 ? true : null),
      12_000,
      250
    );
    expect(idle, "crank_armed cleared").to.equal(true);
    const last = (await tickTxs(c00()))[0];
    expect(last.ok).to.equal(true);
    expect(
      last.logs.some((l) => l.includes("tick: idle, crank cancelled")),
      last.logs.join("\n")
    ).to.equal(true);
    logCus("tick_chunk (idle → cancel CPI)", [last.cu]);
    const n = (await crankOf(c00()))!.tickCount;
    const sigs = (await tickTxs(c00())).length;
    await sleep(2_000);
    expect((await crankOf(c00()))!.tickCount, "tick_count frozen").to.equal(n);
    expect((await tickTxs(c00())).length, "no further executions").to.equal(
      sigs
    );
  });

  it("watchdog: a move re-arms an idle chunk, and re-arms a dropped task once it is stale", async () => {
    const sig = await move();
    expect(armed(await logsOf(sig)), "re-armed after idle").to.equal(true);
    const n0 = (await crankOf(c00()))!.tickCount;
    await sleep(1_000);
    expect((await crankOf(c00()))!.tickCount).to.be.above(n0);

    // Simulate a task dropped by the scheduler: header still says armed.
    await sendEr([await debugCancelTickIx(world, c00())], [stranger()]);
    await sleep(400);
    const n1 = (await crankOf(c00()))!.tickCount;
    // Moves keep coming: no re-arm until the last tick is > 3 s old.
    let rearmedAfter = -1;
    const cancelAt = Date.now();
    for (let i = 0; i < 30 && rearmedAfter < 0; i++) {
      const s = await move(undefined, world, 400);
      if (armed(await logsOf(s))) rearmedAfter = Date.now() - cancelAt;
      else
        expect(
          (await crankOf(c00()))!.tickCount,
          "no ticks while dropped"
        ).to.equal(n1);
    }
    console.log(`    dropped task re-armed by a move after ${rearmedAfter} ms`);
    expect(rearmedAfter, "re-armed").to.be.at.least(2_500);
    await sleep(1_000);
    expect((await crankOf(c00()))!.tickCount, "ticking again").to.be.above(n1);
  });

  it("creating / closing a neighbor re-arms an armed chunk with the new account list", async () => {
    const [ax, az] = animalChunk;
    const ck = chunkPda(world, ax, az);
    await move(); // (0,0) stays busy (fresh presence)
    const hasCk = (t: { accounts: web3.PublicKey[] }) =>
      t.accounts.some((k) => k.equals(ck));
    const relinked = (logs: string[]) =>
      logs.some((l) => /neighbor \d crank re-armed/.test(l));

    const created = await createAndGrow(a, world, ax, az);
    expect(relinked(await logsOf(created)), "re-armed on create").to.equal(
      true
    );
    logCus("create_chunk (+ relink 1 armed neighbor)", [
      (await ixCus(created)).ixs[0],
    ]);
    await populate(world, ax, az);
    existing.add(key(ax, az));
    await stayFor(1_500, 500);
    let txs = await tickTxs(c00(), 20);
    expect(txs[0].ok && hasCk(txs[0]), "new list includes it").to.equal(true);

    const closed = await sendEr(
      [await closeChunkIx(a, world, ax, az)],
      [a.authority]
    );
    existing.delete(key(ax, az));
    expect(relinked(await logsOf(closed)), "re-armed on close").to.equal(true);
    await stayFor(1_500, 500);
    txs = await tickTxs(c00(), 20);
    expect(txs[0].ok && !hasCk(txs[0]), "new list drops it").to.equal(true);
    const all = txs.slice(0, 5);
    expect(all.every((t) => t.ok)).to.equal(true);
    expect(
      all.some((t) => t.logs.some((l) => l.includes("account list outdated"))),
      "no repair needed"
    ).to.equal(false);
  });

  it("water flows into a block broken next to it (fluid ticks)", async () => {
    for (const [x, y, z] of water.path) await move(center(x, y, z));
    const q = water.Q;
    const ck = chunkPda(world, Math.floor(q[0] / 16), Math.floor(q[2] / 16));
    const d0 = (await chunkData(ck))!;
    expect(d0[CHUNK_BLOCKS_OFFSET + localIndex(q)]).to.not.equal(0);
    const n0 = (await crankOf(ck))!.tickCount;
    const sig = await sendEr(
      [uniq(), await breakIx(a, world, q)],
      [a.authority]
    );
    logCus("break_block (next to water)", [(await ixCus(sig)).ixs[0]]);
    const t0 = Date.now();
    const b = await until(
      async () => {
        const v = (await chunkData(ck))![CHUNK_BLOCKS_OFFSET + localIndex(q)];
        return isWater(v) ? v : null;
      },
      5_000,
      100
    );
    expect(b, "water at the broken block").to.not.equal(null);
    console.log(
      `    water (block ${b}) at ${q} after ${Date.now() - t0} ms; queue ${
        fluidQueue((await chunkData(ck))!).len
      }`
    );
    expect((await crankOf(ck))!.tickCount).to.be.above(n0);
    await stayFor(2_000, 700); // keep the chunk busy, let the flow settle a bit
    const txs = await tickTxs(ck);
    expect(txs.every((t) => t.ok)).to.equal(true);
    logCus(
      "tick_chunk (fluid)",
      txs.map((t) => t.cu)
    );
  });

  describe("zombies (60 s day)", () => {
    let w2: web3.PublicKey;
    let t2: Terrain;

    before(async () => {
      existing.clear();
      // A world whose spawn chunk is mostly dry land (zombies need a floor).
      let chunks = new Map<string, Buffer>();
      for (let attempt = 0; ; attempt++) {
        const w = await setupWorld({
          player: a,
          params: params({
            daySecs: 60,
            zombieCapPerChunk: 4,
            mobTickMs: 333,
          }),
        });
        chunks = new Map<string, Buffer>();
        for (let cx = -R; cx <= R; cx++)
          for (let cz = -R; cz <= R; cz++)
            chunks.set(key(cx, cz), referenceChunk(w.seed, cx, cz).blocks);
        const c = chunks.get("0,0")!;
        let land = 0;
        for (let lx = 0; lx < 16; lx++)
          for (let lz = 0; lz < 16; lz++)
            if (surface(c, lx, lz) !== null) land++;
        if (land >= 200 || attempt >= 20) {
          console.log(`    zombie world ${attempt}: ${land}/256 land columns`);
          w2 = w.world;
          break;
        }
      }
      t2 = new Terrain(chunks);
      const ring = new Set<string>(["0,0", ...N4.map(([x, z]) => key(x, z))]);
      await createChunks(w2, ring);
      await sendEr([await joinWorldIx(a, w2)], [a.authority]);
      const sp = (await fetchWorld(w2))!.acc.spawn as V3;
      await move(center(...sp), w2);
    });

    it("at night a zombie spawns near the present player and its hits reach the player's health", async () => {
      // Stay (fresh presence) until night: time_of_day ≥ 30 s of the 60 s day.
      const nightIn = async () => {
        const t = Number((await fetchWorld(w2))!.acc.timeOfDayMs);
        return t >= 30_000 ? 0 : 30_000 - t;
      };
      while ((await nightIn()) > 0) await stayFor(1_000, 1_000, w2);
      console.log("    night");
      const zombieAt = async () => {
        let best: { pos: V3; d: number } | null = null;
        const me = (await state(a, w2)).move.pos;
        for (const k of existing) {
          const [cx, cz] = k.split(",").map(Number);
          for (const m of chunkMobs((await chunkData(chunkPda(w2, cx, cz)))!)) {
            if (m.kind !== ZOMBIE) continue;
            const d = Math.hypot(m.pos[0] - me[0], m.pos[2] - me[2]);
            if (!best || d < best.d) best = { pos: m.pos, d };
          }
        }
        return best;
      };
      let z: Awaited<ReturnType<typeof zombieAt>> = null;
      const t0 = Date.now();
      while (!z && Date.now() - t0 < 30_000) {
        await stayFor(1_000, 1_000, w2);
        z = await zombieAt();
      }
      if (!z) {
        for (const k of existing) {
          const [cx, cz] = k.split(",").map(Number);
          console.log(`    (${k})`, await crankOf(chunkPda(w2, cx, cz)));
        }
        const t = (await tickTxs(chunkPda(w2, 0, 0), 5))[0];
        console.log(t?.logs.join("\n"));
      }
      expect(z, "a zombie spawned").to.not.equal(null);
      console.log(
        `    zombie at ${z!.pos} (${(z!.d / 256).toFixed(1)} blocks) after ${
          Date.now() - t0
        } ms of night`
      );

      // Walk toward the nearest zombie until it hits (pending damage → health).
      const t1 = Date.now();
      let hurt = false;
      while (!hurt && Date.now() - t1 < 40_000) {
        const me = (await state(a, w2)).move.pos;
        const zz = await zombieAt();
        let next: number[] | undefined;
        if (zz && zz.d > 1.5 * 256) {
          const from: Col = [Math.floor(me[0] / 256), Math.floor(me[2] / 256)];
          const to: Col = [
            Math.floor(zz.pos[0] / 256),
            Math.floor(zz.pos[2] / 256),
          ];
          const path = walkTree(t2, from).path(to);
          if (path?.length) next = center(...path[0]);
        }
        if (next && !existing.has(key(chunkOf(next[0]), chunkOf(next[2]))))
          next = undefined;
        await move(next, w2);
        hurt = (await state(a, w2)).acc.health < 20;
      }
      const s = await state(a, w2);
      const pres = await fetchPresence(
        presencePda(
          chunkPda(w2, chunkOf(s.move.pos[0]), chunkOf(s.move.pos[2]))
        )
      );
      console.log(
        `    health ${s.acc.health} after ${
          Date.now() - t1
        } ms of chasing; pending ${pres.entries
          .map((e) => e.pendingDamage)
          .join()}`
      );
      expect(hurt, "zombie damage applied").to.equal(true);
      const [mcx, mcz] = [chunkOf(s.move.pos[0]), chunkOf(s.move.pos[2])];
      const txs = await tickTxs(chunkPda(w2, mcx, mcz));
      expect(txs.every((t) => t.ok)).to.equal(true);
      logCus(
        "tick_chunk (zombie + player)",
        txs.map((t) => t.cu)
      );
    });

    it("a busy chunk renews its own task from inside the crank (ScheduleTask CPI)", async () => {
      // (0,0) has had a fresh player since join: > RENEW_AFTER (160) ticks.
      const c = chunkPda(w2, 0, 0);
      const renewed = async () => {
        const st = (await crankOf(c))!;
        if (st.tickCount < 170) return null;
        const txs = await tickTxs(c, 400);
        return (
          txs.find((t) =>
            t.logs.some((l) => l.includes("tick: crank renewed"))
          ) ?? null
        );
      };
      let r = await renewed();
      for (let i = 0; i < 30 && !r; i++) {
        await stayFor(1_500, 750, w2);
        r = await renewed();
      }
      expect(r, "a renewing tick").to.not.equal(null);
      expect(r!.ok).to.equal(true);
      logCus("tick_chunk (renew CPI)", [r!.cu]);
      console.log(`    (0,0) tick_count ${(await crankOf(c))!.tickCount}`);
    });
  });
});
