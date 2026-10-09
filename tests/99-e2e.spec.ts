// End-to-end: one player's journey, the way a client plays it. The wallet only
// signs base-layer txs (Player creation, session token, top-up) and the final
// withdraw; every gameplay tx is signed (and paid) by a 0-lamport session key.
//
// wallet → Player (init + deposit + delegate, one tx) → session token → world
// (short day, zombies) + VRF seed → (0,0) + spawn → join → walk ≥ 8 chunks,
// creating chunks ahead of the path → top-up (e-SPL) → break next to water,
// water flows in → logs, crafting, place a table, shovel → gather blocks →
// night: a zombie (placed by the localnet `debug_spawn_mob` hook) hits →
// death (zombies, or a lethal fall from a pillar) → respawn → create a fresh
// chunk, close every reclaimable chunk → withdraw → base settles by the ER
// delta. The seed is VRF output, so worlds can't be pre-screened before paying
// for them (create_world + request_seed ≈ 10 k lamports each). The route is planned over magicraft-core reference blocks
// (`helpers/scout.ts`; worlds are retried until one fits).
import { expect } from "chai";
import { web3 } from "@anchor-lang/core";
import { baseConn, erConn, sendEr, TxError } from "./helpers/env";
import { setupPlayer, sleep, TestPlayer, topUp, until } from "./helpers/player";
import { createSession, SessionAuth, sessionAccounts } from "./helpers/session";
import {
  chunkData,
  chunkHeader,
  chunkPda,
  CHUNK_BLOCKS_OFFSET,
  CHUNK_TOTAL_RENT,
  closeChunkIx,
  createAndGrow,
  creationChain,
  liveBlocks,
  populate,
  presencePda,
  referenceChunk,
  setSpawnIx,
} from "./helpers/chunk";
import { fails, fetchWorld, params, setupWorld } from "./helpers/world";
import {
  center,
  chainMs,
  chunkOf,
  erLamports,
  fetchPlayerState,
  fetchPresence,
  FP,
  isSolid,
  joinWorldIx,
  moveIx,
  nextClientMs,
  pstatePda,
} from "./helpers/play";
import { Col, Plan, scoutTour, scoutWork, Terrain, V3 } from "./helpers/scout";
import {
  breakIx,
  countItem,
  craftIx,
  decodeInventory,
  ITEM,
  localIndex,
  mobsIn,
  placeableSlot,
  placeIx,
  RECIPE,
  respawnIx,
  selectIx,
  slotOf,
  uniq,
  ZOMBIE,
} from "./helpers/actions";
import { debugSpawnMobIx, tickTxs } from "./helpers/crank";
import { chaseUntilHurt, columnNear } from "./helpers/zombie";
import { TxStats } from "./helpers/stats";

const R = 2; // scouted area: chunks −R..=R
const TOUR_CHUNKS = 8;
/** Day length (night = second half). The route usually ends during the day;
 *  the night wait is bounded either way. */
const DAY_SECS = 120;
const DEPOSIT = 0.05 * web3.LAMPORTS_PER_SOL;
const TOP_UP = 0.01 * web3.LAMPORTS_PER_SOL;
/** Pillar material to gather (soft blocks; + 5 planks): enough for a lethal
 *  fall at full health (health + 5 blocks above the landing column). */
const SOFT_BLOCKS = 22;
const key = (cx: number, cz: number) => `${cx},${cz}`;
const isWater = (b: number) => b >= 23 && b <= 30;
const N4: Col[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const ER_SESSION = "ER, session key";
const ER_WALLET = "ER, wallet";
const BASE = "base layer, wallet";

describe("e2e: one player's journey", () => {
  let p: TestPlayer;
  let s: SessionAuth;
  let world: web3.PublicKey;
  let spawn: V3;
  let tour: V3[];
  let plan: Plan;
  let baseAtSync: number;
  let erAtSync: number;
  const existing = new Set<string>();
  const stats = new TxStats();
  const chunkSpend: number[] = [];
  const chunkRefund: number[] = [];
  const t0 = Date.now();
  const phases: [string, number, number][] = []; // name, wall s, time of day s
  let dead = false;

  const auth = () => sessionAccounts(s);
  const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1);
  async function phase(name: string) {
    const tod = world
      ? Number((await fetchWorld(world))!.acc.timeOfDayMs) / 1000
      : NaN;
    phases.push([name, (Date.now() - t0) / 1000, tod]);
    console.log(`    [${elapsed()} s, day ${tod.toFixed(1)} s] ${name}`);
  }

  /** One ER tx signed and paid by the session key; `names` label the
   *  magicraft ixs (CU table). Throws TxError ("Dead" when dead). */
  async function er(
    names: string[],
    ixs: Promise<web3.TransactionInstruction>[]
  ): Promise<string> {
    try {
      const sig = await sendEr([uniq(), ...(await Promise.all(ixs))], [s.kp]);
      stats.add(ER_SESSION, sig, names);
      return sig;
    } catch (e) {
      stats.add(`${ER_SESSION} (failed)`, null);
      throw e;
    }
  }

  async function state() {
    const st = (await fetchPlayerState(pstatePda(world, p.player)))!;
    return { ...st, inv: decodeInventory(st.acc.inventory as number[]) };
  }

  /** Creates chunk `k` (and any chunk needed to reach it) as a client does:
   *  tx 1 create + grow, tx 2 populate (both by the session key). */
  async function ensure(k: string) {
    for (const c of creationChain(existing, k, R)) {
      const [cx, cz] = c.split(",").map(Number);
      const before = await erLamports(p.player);
      const sig = await createAndGrow(p, world, cx, cz, 1_400_000, s);
      stats.add(ER_SESSION, sig, ["create_chunk", "grow_chunk"]);
      stats.add(ER_SESSION, await populate(world, cx, cz, s.kp), [
        "populate_chunk",
      ]);
      if (c === "0,0")
        stats.add(ER_SESSION, await sendEr([await setSpawnIx(world)], [s.kp]), [
          "set_spawn",
        ]);
      const spent = before - (await erLamports(p.player));
      expect(spent, `rent of chunk ${c}`).to.equal(CHUNK_TOTAL_RENT);
      chunkSpend.push(spent);
      existing.add(c);
    }
  }
  const ensureBlock = (b: V3) =>
    ensure(key(Math.floor(b[0] / 16), Math.floor(b[2] / 16)));

  async function move(
    pos?: number[],
    o: { onGround?: boolean; minDt?: number } = {}
  ) {
    const st = await state();
    const clientMs = await nextClientMs(world, st.move.lastMs, o.minDt);
    return er(
      ["move_player"],
      [
        moveIx(p, world, {
          prev: st.move.pos,
          pos: pos ?? st.move.pos,
          onGround: o.onGround ?? true,
          clientMs,
          existing,
          ...auth(),
        }),
      ]
    );
  }

  /** Walks waypoint by waypoint, creating each chunk before stepping in. */
  async function walk(path: V3[]) {
    for (const [x, y, z] of path) {
      await ensure(key(chunkOf(x * FP), chunkOf(z * FP)));
      await move(center(x, y, z));
    }
  }

  async function blockAt(b: V3): Promise<number> {
    const d = (await chunkData(
      chunkPda(world, Math.floor(b[0] / 16), Math.floor(b[2] / 16))
    ))!;
    return d[CHUNK_BLOCKS_OFFSET + localIndex(b)];
  }

  async function waitBreak() {
    const until = (await state()).acc.breakUntilMs.toNumber();
    while ((await chainMs(world)) < until + 150) await sleep(50);
  }

  async function breakBlock(b: V3, name: string) {
    await ensureBlock(b);
    await waitBreak();
    return er(
      [name],
      [breakIx(p, world, b, { neighbors: existing, ...auth() })]
    );
  }

  /** Current terrain of the existing chunks (walk planning after edits). */
  const live = async () => new Terrain(await liveBlocks(world, existing));
  const myCol = async (): Promise<Col> => {
    const pos = (await state()).move.pos;
    return [Math.floor(pos[0] / FP), Math.floor(pos[2] / FP)];
  };

  /** Runs `f`; a `Dead` rejection marks the player dead instead of failing. */
  async function unlessDead(f: () => Promise<unknown>) {
    if (dead) return;
    try {
      await f();
    } catch (e) {
      if ((e as TxError).code !== "Dead") throw e;
      dead = true;
    }
    if (!dead && (await state()).acc.health === 0) dead = true;
  }

  after(async () => {
    await stats.resolve();
    console.log(`\n    e2e summary (${elapsed()} s)`);
    console.log("    phases (wall s, time of day s):");
    for (const [n, w, d] of phases)
      console.log(
        `      ${w.toFixed(1).padStart(6)} ${d.toFixed(1).padStart(6)}  ${n}`
      );
    console.log(
      stats
        .table()
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n")
    );
    const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
    console.log(
      `    chunks: ${chunkSpend.length} created, ${sum(
        chunkSpend
      )} lamports of rent (${CHUNK_TOTAL_RENT} each); ${
        chunkRefund.length
      } closed, ${sum(chunkRefund)} refunded; net ${
        sum(chunkSpend) - sum(chunkRefund)
      }`
    );
    console.log(
      `    txs: ${[...stats.txs].map(([k, v]) => `${k} ${v}`).join(", ")}`
    );
  });

  it("wallet: Player (init + deposit + delegate, one tx) and a session token", async () => {
    p = await setupPlayer({ depositSol: DEPOSIT / web3.LAMPORTS_PER_SOL });
    stats.add(BASE, null); // airdrop not counted; init + deposit + delegate
    baseAtSync = (await baseConn.getAccountInfo(p.player, "confirmed"))!
      .lamports;
    erAtSync = await erLamports(p.player);
    expect(erAtSync).to.equal(baseAtSync);
    s = await createSession(baseConn, p.base.programId, p.authority);
    stats.add(BASE, null);
    expect(await erLamports(s.kp.publicKey), "session key").to.equal(0);
    await phase("Player delegated, session token created");
  });

  it("creates a world (short day, zombies) with a VRF seed and scouts a route", async () => {
    for (let attempt = 0; attempt < 25 && !world; attempt++) {
      const w = await setupWorld({
        player: p,
        session: s,
        params: params({
          daySecs: DAY_SECS,
          zombieCapPerChunk: 4,
          mobTickMs: 333,
        }),
      });
      stats.add(ER_SESSION, w.sigs[0], ["create_world"]);
      stats.add(ER_SESSION, w.sigs[1], ["request_seed"]);
      const chunks = new Map<string, Buffer>();
      let sp: V3 = [0, 0, 0];
      for (let cx = -R; cx <= R; cx++)
        for (let cz = -R; cz <= R; cz++) {
          const r = referenceChunk(w.seed, cx, cz);
          chunks.set(key(cx, cz), r.blocks);
          if (cx === 0 && cz === 0) sp = r.spawn;
        }
      const copy = () =>
        new Terrain(new Map([...chunks].map(([k, v]) => [k, Buffer.from(v)])));
      const tr = scoutTour(copy(), [sp[0], sp[2]], TOUR_CHUNKS);
      if (typeof tr === "string") {
        console.log(`    world ${attempt}: ${tr}`);
        continue;
      }
      const end = tr.path.length ? tr.path[tr.path.length - 1] : sp;
      const tw = copy();
      const pl = scoutWork(tw, [end[0], end[2]], sp, { fed: true });
      if (typeof pl === "string" || pl.soft.length < SOFT_BLOCKS) {
        console.log(
          `    world ${attempt}: ${
            typeof pl === "string" ? pl : `${pl.soft.length} soft blocks`
          }`
        );
        continue;
      }
      world = w.world;
      spawn = sp;
      tour = tr.path;
      plan = pl;
      console.log(
        `    world ${attempt}: tour ${tour.length} steps over ${
          tr.chunks.length
        } chunks, then ${
          pl.pathW.length + pl.pathL.length + pl.pathS.length
        } steps of work route`
      );
    }
    expect(world, "a world that fits the route").to.not.equal(undefined);
    await phase("world seeded and scouted");
  });

  it("generates (0,0), sets the spawn and joins", async () => {
    await ensure("0,0");
    expect((await fetchWorld(world))!.acc.spawn).to.deep.equal(spawn);
    await er(["join_world"], [joinWorldIx(p, world, auth())]);
    await move(center(...spawn));
    const st = await state();
    expect(st.move.pos).to.deep.equal(center(...spawn));
    expect(st.acc.health).to.equal(20);
    await phase("joined at the spawn");
  });

  it(`walks around, creating chunks ahead of the path (≥ ${TOUR_CHUNKS} chunks)`, async () => {
    await walk(tour);
    expect(existing.size).to.be.at.least(TOUR_CHUNKS);
    expect((await p.er.account.player.fetch(p.player)).openChunks).to.equal(
      existing.size
    );
    await phase(`walked ${tour.length} steps, ${existing.size} chunks`);
  });

  it("tops up the delegated Player from the wallet (lamportsDelegatedTransferIx)", async () => {
    const before = await erLamports(p.player);
    const n = await topUp(p, TOP_UP);
    for (let i = 0; i < n; i++) stats.add(BASE, null);
    const ok = await until(
      async () => (await erLamports(p.player)) === before + TOP_UP,
      5_000,
      50
    );
    expect(ok, "ER Player +TOP_UP").to.equal(true);
    await phase("topped up");
  });

  it("breaks a block next to water and the water flows in", async () => {
    await walk(plan.pathW);
    const q = plan.Q;
    expect(await blockAt(q)).to.not.equal(0);
    // The water feeding Q may sit across a chunk border: it must exist.
    for (const [dx, dz] of N4) {
      const [cx, cz] = [
        Math.floor((q[0] + dx) / 16),
        Math.floor((q[2] + dz) / 16),
      ];
      if (Math.abs(cx) <= R && Math.abs(cz) <= R) await ensure(key(cx, cz));
    }
    await breakBlock(q, "break_block (next to water)");
    const t = Date.now();
    const b = await until(
      async () => {
        const v = await blockAt(q);
        return isWater(v) ? v : null;
      },
      5_000,
      100
    );
    expect(b, "water at the broken block").to.not.equal(null);
    console.log(`    water (block ${b}) at ${q} after ${Date.now() - t} ms`);
    const [cx, cz] = [Math.floor(q[0] / 16), Math.floor(q[2] / 16)];
    const ck = chunkPda(world, cx, cz);
    expect(chunkHeader((await chunkData(ck))!).edited).to.equal(1);
    const ticks = await tickTxs(ck, 30);
    expect(ticks.every((x) => x.ok)).to.equal(true);
    stats.addCus(
      "tick_chunk (cranked: fluid / mobs)",
      ticks.map((x) => x.cu)
    );
    await phase("water flowed");
  });

  it("punches logs, crafts planks, a table and sticks, places the table, crafts a shovel", async () => {
    await walk(plan.pathL);
    for (const l of plan.logs) await breakBlock(l, "break_block (log, hand)");
    expect(countItem((await state()).inv, ITEM.LOG)).to.equal(3);
    await walk(plan.pathS);
    await er(
      ["craft (hand)"],
      [craftIx(p, world, RECIPE.PLANKS, 3, null, auth())]
    );
    await er(
      ["craft (hand)"],
      [craftIx(p, world, RECIPE.TABLE, 1, null, auth())]
    );
    await er(
      ["craft (hand)"],
      [craftIx(p, world, RECIPE.STICKS, 1, null, auth())]
    );
    let inv = (await state()).inv;
    expect(countItem(inv, ITEM.PLANKS)).to.equal(12 - 4 - 2);
    await ensureBlock(plan.T);
    await er(
      ["place_block"],
      [
        placeIx(
          p,
          world,
          plan.T,
          slotOf(inv, ITEM.CRAFTING_TABLE),
          existing,
          auth()
        ),
      ]
    );
    expect(await blockAt(plan.T)).to.equal(ITEM.CRAFTING_TABLE);
    await er(
      ["craft (table)"],
      [craftIx(p, world, RECIPE.WOOD_SHOVEL, 1, plan.T, auth())]
    );
    inv = (await state()).inv;
    expect(countItem(inv, ITEM.PLANKS)).to.equal(5);
    expect(countItem(inv, ITEM.STICK)).to.equal(2);
    expect(slotOf(inv, ITEM.WOOD_SHOVEL)).to.be.at.least(0);
    await phase("crafted and placed");
  });

  it("gathers blocks with the shovel (pillar material)", async () => {
    const inv = (await state()).inv;
    await er(
      ["select_slot"],
      [selectIx(p, world, slotOf(inv, ITEM.WOOD_SHOVEL), auth())]
    );
    for (const b of plan.soft.slice(0, SOFT_BLOCKS))
      await breakBlock(b, "break_block (soft, shovel)");
    const blocks = (await state()).inv
      .filter((x) => x.item >= 1 && x.item <= 22)
      .reduce((n, x) => n + x.count, 0);
    expect(blocks).to.be.at.least(SOFT_BLOCKS + 5);
    await phase(`gathered ${blocks} blocks`);
  });

  it("at night a zombie next to the player hits it (pending_damage → health)", async () => {
    // Bounded wait for a night with ≥ 20 s left (≤ one day). Idle meanwhile:
    // the presence entry goes stale and the chunk crank idles.
    const tod = async () => Number((await fetchWorld(world))!.acc.timeOfDayMs);
    const half = DAY_SECS * 500;
    const end = Date.now() + DAY_SECS * 1000 + 5_000;
    for (;;) {
      const t = (await tod()) % (2 * half);
      if (t >= half && 2 * half - t >= 20_000) break;
      expect(Date.now(), "night never came").to.be.below(end);
      await sleep(1_000);
    }
    await phase("night");
    // Natural spawns need luck (floors 8-24 blocks away, room under the cap):
    // the localnet test hook puts a zombie 3 blocks away instead.
    const zpos = columnNear(await live(), await myCol(), 3);
    expect(zpos, "a column 3 blocks away").to.not.equal(null);
    await ensure(key(chunkOf(zpos![0]), chunkOf(zpos![2])));
    await er(
      ["debug_spawn_mob"],
      [
        debugSpawnMobIx(
          world,
          chunkPda(world, chunkOf(zpos![0]), chunkOf(zpos![2])),
          ZOMBIE,
          zpos!
        ),
      ]
    );
    const r = await chaseUntilHurt({
      world,
      player: p.player,
      keys: () => existing,
      me: async () => {
        const st = await state();
        return { pos: st.move.pos, health: st.acc.health };
      },
      move: (next) => move(next),
      timeoutMs: 20_000,
    });
    dead = r.dead;
    console.log(
      `    hit: pending ${r.pendingBeforeHit} → health ${r.health}${
        dead ? " (killed)" : ""
      }`
    );
    expect(r.hurt, "zombie damage reached the player's health").to.equal(true);
    expect(r.pendingBeforeHit, "through pending_damage").to.be.above(0);
    const st = await state();
    const [cx, cz] = [chunkOf(st.move.pos[0]), chunkOf(st.move.pos[2])];
    const ticks = await tickTxs(chunkPda(world, cx, cz), 30);
    expect(ticks.every((x) => x.ok)).to.equal(true);
    stats.addCus(
      "tick_chunk (cranked: zombie + player)",
      ticks.map((x) => x.cu)
    );
    await phase("zombie damage");
  });

  it("dies (zombies, or a lethal fall from a pillar)", async () => {
    if (!dead) {
      // Pillar up on the current column high enough that stepping off onto
      // its lowest neighbour column is lethal at the current health.
      const t = await live();
      const here = await myCol();
      const g = Math.round((await state()).move.pos[1] / FP);
      expect(t.h(...here), "standing on top of the column").to.equal(g);
      const [n, gn] = N4.map(([dx, dz]) => [here[0] + dx, here[1] + dz] as Col)
        .map((c) => [c, t.h(...c)] as [Col, number | null])
        .filter((x): x is [Col, number] => x[1] !== null)
        .sort((a, b) => a[1] - b[1])[0];
      const health = (await state()).acc.health;
      const top = gn + health + 5; // fall damage = drop − 3 = health + 2
      expect(top, "pillar fits in the world").to.be.at.most(62);
      console.log(
        `    pillar ${
          top - g
        } blocks on ${here} (feet ${g}), step off onto ${n} (feet ${gn}) at health ${health}`
      );
      for (let y = g; y < top && !dead; y++) {
        await unlessDead(async () => {
          const st = await state();
          const slot = placeableSlot(st.inv);
          expect(slot, "a block to place").to.be.at.least(0);
          const clientMs = await nextClientMs(world, st.move.lastMs);
          const up = [here[0] * FP + 128, y * FP + 307, here[1] * FP + 128];
          await er(
            ["move_player", "place_block"],
            [
              moveIx(p, world, {
                prev: st.move.pos,
                pos: up,
                onGround: false,
                clientMs,
                existing,
                ...auth(),
              }),
              placeIx(p, world, [here[0], y, here[1]], slot, existing, auth()),
            ]
          );
        });
      }
      await unlessDead(() => move(center(here[0], top, here[1])));
      await unlessDead(() => move(center(n[0], gn, n[1]), { minDt: 800 }));
      expect(dead, "the fall killed the player").to.equal(true);
    }
    const st = await state();
    expect(st.acc.health).to.equal(0);
    const err = await fails(move());
    expect(err?.code, String(err)).to.equal("Dead");
    await phase("dead");
  });

  it("respawns at the spawn with full vitals and an empty inventory", async () => {
    await er(["respawn"], [respawnIx(p, world, auth())]);
    const st = await state();
    expect(st.acc.health).to.equal(20);
    expect(st.acc.food).to.equal(20);
    expect(st.inv.every((x) => x.count === 0)).to.equal(true);
    expect(st.move.pos).to.deep.equal(center(...spawn));
    const below = await blockAt([spawn[0], spawn[1] - 1, spawn[2]]);
    await move(center(...spawn), { onGround: isSolid(below) });
    dead = false;
    await phase("respawned");
  });

  it("closes its reclaimable chunks (incl. a fresh one); edited / occupied ones fail with the right codes", async () => {
    // A chunk created ahead of the path that nobody entered: the client
    // reclaims it (any mobs in it do not block).
    const spawnChunk = key(chunkOf(spawn[0] * FP), chunkOf(spawn[2] * FP));
    const far = [...existing]
      .flatMap((k) => {
        const [cx, cz] = k.split(",").map(Number);
        return N4.map(([dx, dz]) => key(cx + dx, cz + dz));
      })
      .filter((k) => {
        const [cx, cz] = k.split(",").map(Number);
        return !existing.has(k) && Math.abs(cx) <= R && Math.abs(cz) <= R;
      })
      .sort((a, b) => {
        const d = (k: string) => {
          const [cx, cz] = k.split(",").map(Number);
          const [sx, sz] = spawnChunk.split(",").map(Number);
          return Math.abs(cx - sx) + Math.abs(cz - sz);
        };
        return d(b) - d(a);
      })[0];
    expect(far, "a chunk to create away from the player").to.not.equal(
      undefined
    );
    await ensure(far);
    const outcome = new Map<string, number>();
    const zs = await mobsIn(world, existing, ZOMBIE);
    console.log(
      `    ${zs.length} zombies in ${new Set(zs.map((m) => m.chunk)).size} of ${
        existing.size
      } chunks (they do not block closing)`
    );
    for (const k of [...existing]) {
      const [cx, cz] = k.split(",").map(Number);
      const ck = chunkPda(world, cx, cz);
      const predict = async () => {
        if (k === "0,0") return "SpawnChunk";
        const d = (await chunkData(ck))!;
        if (chunkHeader(d).edited) return "ChunkEdited";
        if ((await fetchPresence(presencePda(ck))).count)
          return "ChunkOccupied";
        return "closed";
      };
      const expected = await predict();
      const before = await erLamports(p.player);
      const err = await fails(
        er(["close_chunk"], [closeChunkIx(p, world, cx, cz, auth())])
      );
      const got = err ? err.code ?? String(err.number) : "closed";
      expect(got, `${k}: ${err}`).to.equal(expected);
      outcome.set(got, (outcome.get(got) ?? 0) + 1);
      if (got === "closed") {
        const refund = (await erLamports(p.player)) - before;
        expect(refund, `refund of ${k}`).to.equal(CHUNK_TOTAL_RENT);
        chunkRefund.push(refund);
        existing.delete(k);
        expect(await erConn.getAccountInfo(ck, "confirmed")).to.equal(null);
      }
    }
    console.log(
      `    close: ${[...outcome].map(([k, v]) => `${k} ${v}`).join(", ")}`
    );
    expect(existing.has(far), `fresh chunk ${far} reclaimed`).to.equal(false);
    expect(outcome.get("closed") ?? 0).to.be.at.least(1);
    expect(
      outcome.get("ChunkEdited") ?? 0,
      "edited chunks kept"
    ).to.be.at.least(1);
    expect((await p.er.account.player.fetch(p.player)).openChunks).to.equal(
      existing.size
    );
    await phase(`closed ${chunkRefund.length} chunks`);
  });

  it("withdraws: base settles by the ER delta; open_chunks matches the remaining chunks", async () => {
    const erBefore = await erLamports(p.player);
    const sig = await sendEr(
      [
        await p.er.methods
          .withdraw()
          .accounts({ authority: p.authority.publicKey })
          .instruction(),
      ],
      [p.authority]
    );
    stats.add(ER_WALLET, sig, ["withdraw"]);
    const info = await until(
      async () => {
        const i = await baseConn.getAccountInfo(p.player, "confirmed");
        return i?.owner.equals(p.base.programId) ? i : null;
      },
      30_000,
      200
    );
    expect(info, "Player owned by magicraft on base again").to.not.equal(null);
    expect(info!.lamports).to.equal(baseAtSync + (erBefore - erAtSync));
    const acc = p.base.coder.accounts.decode("player", info!.data);
    expect(acc.openChunks).to.equal(existing.size);
    console.log(
      `    base ${baseAtSync} → ${info!.lamports} (ER delta ${
        erBefore - erAtSync
      }: top-up ${TOP_UP}, chunks −${
        chunkSpend.reduce((a, b) => a + b, 0) -
        chunkRefund.reduce((a, b) => a + b, 0)
      }, worlds / VRF / presence the rest); ${existing.size} chunks stay open`
    );
    await phase("withdrawn");
  });
});
