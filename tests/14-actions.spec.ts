// Player actions: attack_mob, eat, break_block (drops, cooldown, reach, fluid
// enqueue), craft (stations), place_block (overlap / face rules), fall death
// and respawn. The route (an animal to hunt, a block next to water, logs, and
// a work spot with stone, soft blocks and room for two pillars) is planned over
// magicraft-core reference blocks (identical to the onchain chunks, see
// 12-chunk.spec.ts) by `helpers/scout.ts`; worlds are retried until one fits.
import { expect } from "chai";
import { web3 } from "@anchor-lang/core";
import { sendEr } from "./helpers/env";
import { setupPlayer, sleep, TestPlayer } from "./helpers/player";
import {
  chunkData,
  chunkHeader,
  chunkPda,
  CHUNK_BLOCKS_OFFSET,
  createAndGrow,
  ixCus,
  populate,
  referenceChunk,
  setSpawnIx,
} from "./helpers/chunk";
import { fails, fetchWorld, setupWorld, TestWorld } from "./helpers/world";
import {
  center,
  chainMs,
  fetchPlayerState,
  FP,
  isSolid,
  joinWorldIx,
  moveIx,
  nextClientMs,
  pstatePda,
  STALE_MS,
} from "./helpers/play";
import {
  Animal,
  Col,
  Hunt,
  Plan,
  scoutHunt,
  scoutWork,
  Terrain,
  SMALL_PILLAR,
} from "./helpers/scout";
import {
  attackIx,
  breakIx,
  chunkMobs,
  countItem,
  craftIx,
  decodeInventory,
  eatIx,
  fluidQueue,
  ITEM,
  localIndex,
  MEAT,
  placeableSlot,
  placeIx,
  RECIPE,
  respawnIx,
  selectIx,
  slotOf,
  uniq,
  V3,
} from "./helpers/actions";

const R = 2; // scouted area: chunks −R..=R on both axes
const FOOD_VALUE: Record<number, number> = { 768: 3, 770: 3, 772: 2 };

describe("actions: break, place, craft, attack, eat, respawn", () => {
  let a: TestPlayer;
  let b: TestPlayer;
  let tw: TestWorld;
  let world: web3.PublicKey;
  let spawn: V3;
  let hunt: Hunt;
  let plan: Plan;
  /** Reference terrain of the scouted area (unedited), for re-planning walks. */
  let terrain: Terrain;
  const existing = new Set<string>();
  const cus = new Map<string, number[]>();

  const chunkOfBlock = (p: V3): [number, number] => [
    Math.floor(p[0] / 16),
    Math.floor(p[2] / 16),
  ];
  const chunkAt = (p: V3) => chunkPda(world, ...chunkOfBlock(p));

  async function logCu(name: string, sig: string, i = 0) {
    const c = (await ixCus(sig)).ixs[i];
    cus.set(name, [...(cus.get(name) ?? []), c]);
    return c;
  }

  async function state(p: TestPlayer = a) {
    const s = (await fetchPlayerState(pstatePda(world, p.player)))!;
    return { ...s, inv: decodeInventory(s.acc.inventory as number[]) };
  }

  /** One distinct ER tx of `ixs` signed by `p`. */
  let lastSig: string | undefined;
  const act = async (
    ixs: Promise<web3.TransactionInstruction>[],
    p: TestPlayer = a
  ) =>
    (lastSig = await sendEr(
      [uniq(), ...(await Promise.all(ixs))],
      [p.authority]
    ));

  async function blockAt(p: V3): Promise<number> {
    const d = (await chunkData(chunkAt(p)))!;
    return d[CHUNK_BLOCKS_OFFSET + localIndex(p)];
  }

  async function move(
    p: TestPlayer,
    pos: number[],
    o: { onGround?: boolean; minDt?: number } = {}
  ) {
    const st = await state(p);
    const clientMs = await nextClientMs(world, st.move.lastMs, o.minDt);
    return sendEr(
      [
        await moveIx(p, world, {
          prev: st.move.pos,
          pos,
          onGround: o.onGround ?? true,
          clientMs,
          existing,
        }),
      ],
      [p.authority]
    );
  }

  async function walk(p: TestPlayer, path: V3[]) {
    for (const [x, y, z] of path) await move(p, center(x, y, z));
  }

  /** Waits until chain time passes `ms` (a cooldown's end). */
  async function waitChain(ms: number) {
    while ((await chainMs(world)) < ms + 150) await sleep(50);
  }
  const waitBreak = async () =>
    waitChain((await state()).acc.breakUntilMs.toNumber());
  const waitAttack = async () =>
    waitChain((await state()).acc.attackUntilMs.toNumber());

  /** Pillars up on column `col` from feet `from` to feet `to`: each step is
   *  one tx [move 1.2 blocks up (airborne), place a block at the old feet]. */
  async function pillar(col: Col, from: number, to: number) {
    for (let y = from; y < to; y++) {
      const s = await state();
      const slot = placeableSlot(s.inv);
      expect(slot, "a block to place").to.be.at.least(0);
      const clientMs = await nextClientMs(world, s.move.lastMs);
      const up = [col[0] * FP + 128, y * FP + 307, col[1] * FP + 128];
      const sig = await act([
        moveIx(a, world, {
          prev: s.move.pos,
          pos: up,
          onGround: false,
          clientMs,
          existing,
        }),
        placeIx(a, world, [col[0], y, col[1]], slot, existing),
      ]);
      await logCu("place_block (pillar)", sig, 1);
    }
    await move(a, center(col[0], to, col[1]));
  }

  before(async function () {
    a = await setupPlayer({ depositSol: 0.3 });
    let best: {
      tw: TestWorld;
      hunt: Hunt;
      plan: Plan;
      spawn: V3;
      walk: number;
      terrain: Terrain;
    } | null = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const w = await setupWorld({ player: a });
      const chunks = new Map<string, Buffer>();
      const animals: Animal[] = [];
      let sp: V3 = [0, 0, 0];
      for (let cx = -R; cx <= R; cx++)
        for (let cz = -R; cz <= R; cz++) {
          const r = referenceChunk(w.seed, cx, cz);
          chunks.set(`${cx},${cz}`, r.blocks);
          for (const s of r.spawns)
            animals.push({
              kind: s.kind,
              pos: [cx * 16 + s.x, s.y, cz * 16 + s.z],
            });
          if (cx === 0 && cz === 0) sp = r.spawn;
        }
      const copy = () =>
        new Terrain(new Map([...chunks].map(([k, v]) => [k, Buffer.from(v)])));
      const h = scoutHunt(copy(), sp, animals);
      const p = typeof h === "string" ? h : scoutWork(copy(), h.P, sp);
      if (typeof h === "string" || typeof p === "string") {
        console.log(`    world ${attempt}: ${p}`);
        continue;
      }
      const walk =
        h.pathP.length +
        p.pathW.length +
        p.pathL.length +
        p.pathS.length +
        p.pathB.length;
      console.log(`    world ${attempt}: fits, ${walk} steps of walking`);
      if (!best || walk < best.walk)
        best = { tw: w, hunt: h, plan: p, spawn: sp, walk, terrain: copy() };
      if (walk <= 90) break;
    }
    expect(best, "a world that fits the route").to.not.equal(null);
    ({ tw, hunt, plan, spawn, terrain } = best!);
    world = tw.world;

    // Chunks touched by the route, plus BFS parents (creation adjacency).
    const need = new Set<string>();
    const add = (x: number, z: number) =>
      need.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
    add(spawn[0], spawn[2]);
    for (const p of [
      ...hunt.pathP,
      ...plan.pathW,
      ...plan.pathL,
      ...plan.pathS,
      ...plan.pathB,
      ...plan.logs,
      ...plan.stones,
      ...plan.soft,
      hunt.animal.pos,
      plan.Q,
      plan.T,
      plan.nfa,
    ])
      add(p[0], p[2]);
    for (const c of [plan.C1, plan.C2]) add(c[0], c[1]);
    const parent = new Map<string, string | null>([["0,0", null]]);
    const order = ["0,0"];
    for (let i = 0; i < order.length; i++) {
      const [cx, cz] = order[i].split(",").map(Number);
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const k = `${cx + dx},${cz + dz}`;
        if (Math.abs(cx + dx) > R || Math.abs(cz + dz) > R || parent.has(k))
          continue;
        parent.set(k, order[i]);
        order.push(k);
      }
    }
    for (const k of [...need]) {
      let p = parent.get(k);
      while (p) {
        need.add(p);
        p = parent.get(p);
      }
    }
    for (const k of order.filter((k) => need.has(k))) {
      const [cx, cz] = k.split(",").map(Number);
      const par = parent.get(k);
      await createAndGrow(a, world, cx, cz);
      await populate(world, cx, cz);
      if (k === "0,0")
        await sendEr([await setSpawnIx(world)], [web3.Keypair.generate()]);
      existing.add(k);
    }
    expect((await fetchWorld(world))!.acc.spawn).to.deep.equal(spawn);
    console.log(
      `    ${existing.size} chunks; spawn ${spawn}; animal kind ${hunt.animal.kind} at ${hunt.animal.pos}; work spot ${plan.S} (feet ${plan.g0})`
    );

    await sendEr([await joinWorldIx(a, world)], [a.authority]);
    await move(a, center(...spawn));
    b = await setupPlayer({ depositSol: 0.02 });
    await sendEr([await joinWorldIx(b, world)], [b.authority]);
  });

  after(() => {
    for (const [k, v] of cus)
      console.log(
        `    CU ${k}: ${
          v.length > 1
            ? `min ${Math.min(...v)}, max ${Math.max(...v)} (${v.length})`
            : v[0]
        }`
      );
  });

  it("respawn while alive → NotDead", async () => {
    const err = await fails(act([respawnIx(a, world)]));
    expect(err?.code, String(err)).to.equal("NotDead");
  });

  it("attack an animal until it dies → meat in the inventory (cooldown enforced)", async () => {
    await walk(a, hunt.pathP);
    const chunk = chunkAt(hunt.animal.pos);
    // Animals wander: the chunk tick crank steps them (about once a minute with
    // these params), so take the nearest animal of the kind to the scouted spot.
    const feet = center(...hunt.animal.pos);
    const mobs = chunkMobs((await chunkData(chunk))!);
    let idx = -1;
    let best = 4 * FP;
    mobs.forEach((m, i) => {
      const d = Math.hypot(m.pos[0] - feet[0], m.pos[2] - feet[2]);
      if (m.kind === hunt.animal.kind && d <= best) [idx, best] = [i, d];
    });
    expect(idx, "mob slot").to.be.at.least(0);
    const hp0 = mobs[idx].hp;
    /** Attacks slot `idx`; if it wandered out of reach, walks back into reach
     *  (re-planned over the reference terrain) and retries. */
    const hit = async () => {
      for (let k = 0; ; k++) {
        const r = await fails(act([attackIx(a, world, chunk, idx)]));
        if (!r) return;
        if (r.code !== "OutOfReach" || k >= 2) throw r;
        const m = chunkMobs((await chunkData(chunk))!)[idx];
        const pos = (await state()).move.pos;
        const h = scoutHunt(terrain, pos.map((v) => Math.floor(v / FP)) as V3, [
          { kind: m.kind, pos: m.pos.map((v) => Math.floor(v / FP)) as V3 },
        ]);
        if (typeof h === "string") throw new Error(`re-approach: ${h}`);
        await walk(a, h.pathP);
      }
    };
    await hit();
    await logCu("attack_mob", lastSig!);
    expect(chunkMobs((await chunkData(chunk))!)[idx].hp).to.equal(hp0 - 1);
    const err = await fails(act([attackIx(a, world, chunk, idx)]));
    expect(err?.code, String(err)).to.equal("Cooldown");
    let hits = 1;
    while (chunkMobs((await chunkData(chunk))!)[idx].kind !== 0) {
      expect(hits, "hits").to.be.below(hp0 + 1);
      await waitAttack();
      await hit();
      await logCu("attack_mob", lastSig!);
      hits++;
    }
    expect(hits, "fist = 1 damage per hit").to.equal(hp0);
    const s = await state();
    const meat = MEAT[hunt.animal.kind];
    expect(countItem(s.inv, meat), "meat").to.be.within(1, 3);
    console.log(
      `    killed kind ${hunt.animal.kind} in ${hits} hits, ${countItem(
        s.inv,
        meat
      )} meat`
    );
    const err2 = await fails(act([attackIx(a, world, chunk, idx)]));
    expect(err2?.code, String(err2)).to.equal("NoMob");
  });

  it("eating at full food → FoodFull", async () => {
    const s = await state();
    expect(s.acc.food).to.equal(20);
    const err = await fails(
      act([eatIx(a, world, slotOf(s.inv, MEAT[hunt.animal.kind]))])
    );
    expect(err?.code, String(err)).to.equal("FoodFull");
  });

  it("breaking a block next to water queues fluid work in its chunk", async () => {
    await walk(a, plan.pathW);
    const chunk = chunkAt(plan.Q);
    const before = fluidQueue((await chunkData(chunk))!);
    expect(await blockAt(plan.Q)).to.not.equal(0);
    await logCu(
      "break_block (next to water)",
      await act([breakIx(a, world, plan.Q)])
    );
    const d = (await chunkData(chunk))!;
    expect(chunkHeader(d).edited).to.equal(1);
    const after = fluidQueue(d);
    // The edit armed the chunk's tick crank, which may already have run (then
    // the water has started to flow into the hole).
    const q = d[CHUNK_BLOCKS_OFFSET + localIndex(plan.Q)];
    if (q === 0) {
      expect(after.len, "queue grew").to.be.above(before.len);
      expect(after.entries).to.include(localIndex(plan.Q));
    } else {
      expect(q, "water flowed in").to.be.within(23, 30);
    }
    console.log(`    fluid queue ${before.len} → ${after.len}; block ${q}`);
  });

  it("punching a log → log in the inventory; cooldown and reach enforced", async () => {
    await walk(a, plan.pathL);
    await waitBreak();
    const [l0, l1, l2] = plan.logs;
    await logCu("break_block (log, hand)", await act([breakIx(a, world, l0)]));
    expect(await blockAt(l0)).to.equal(0);
    expect(countItem((await state()).inv, ITEM.LOG)).to.equal(1);
    // 3 s bare-hand log cooldown.
    const err = await fails(act([breakIx(a, world, l1)]));
    expect(err?.code, String(err)).to.equal("Cooldown");
    const far: V3 = [plan.L[0], 2, plan.L[1]];
    const err2 = await fails(act([breakIx(a, world, far)]));
    expect(err2?.code, String(err2)).to.equal("OutOfReach");
    for (const l of [l1, l2]) {
      await waitBreak();
      await logCu("break_block (log, hand)", await act([breakIx(a, world, l)]));
    }
    expect(countItem((await state()).inv, ITEM.LOG)).to.equal(3);
  });

  it("stone without a pickaxe: the block is removed, nothing drops", async () => {
    await walk(a, plan.pathS);
    await waitBreak();
    const s = plan.stones[1];
    expect(await blockAt(s)).to.equal(3);
    await logCu("break_block (stone, hand)", await act([breakIx(a, world, s)]));
    expect(await blockAt(s)).to.equal(0);
    expect(countItem((await state()).inv, ITEM.COBBLESTONE)).to.equal(0);
  });

  it("craft planks, a table and sticks; a pickaxe needs a table", async () => {
    await logCu(
      "craft (hand)",
      await act([craftIx(a, world, RECIPE.PLANKS, 3)])
    );
    await act([craftIx(a, world, RECIPE.TABLE, 1)]);
    await act([craftIx(a, world, RECIPE.STICKS, 1)]);
    const inv = (await state()).inv;
    expect(countItem(inv, ITEM.LOG)).to.equal(0);
    expect(countItem(inv, ITEM.PLANKS)).to.equal(12 - 4 - 2);
    expect(countItem(inv, ITEM.CRAFTING_TABLE)).to.equal(1);
    expect(countItem(inv, ITEM.STICK)).to.equal(4);
    const err = await fails(act([craftIx(a, world, RECIPE.WOOD_PICKAXE, 1)]));
    expect(err?.code, String(err)).to.equal("WrongStation");
    // Claiming a table where there is none doesn't help.
    const err2 = await fails(
      act([craftIx(a, world, RECIPE.WOOD_PICKAXE, 1, plan.T)])
    );
    expect(err2?.code, String(err2)).to.equal("WrongStation");
  });

  it("place the table; craft a pickaxe and a shovel at it", async () => {
    const slot = slotOf((await state()).inv, ITEM.CRAFTING_TABLE);
    await logCu(
      "place_block",
      await act([placeIx(a, world, plan.T, slot, existing)])
    );
    expect(await blockAt(plan.T)).to.equal(15);
    await logCu(
      "craft (table)",
      await act([craftIx(a, world, RECIPE.WOOD_PICKAXE, 1, plan.T)])
    );
    await act([craftIx(a, world, RECIPE.WOOD_SHOVEL, 1, plan.T)]);
    const inv = (await state()).inv;
    expect(countItem(inv, ITEM.CRAFTING_TABLE)).to.equal(0);
    expect(countItem(inv, ITEM.PLANKS)).to.equal(2);
    expect(countItem(inv, ITEM.STICK)).to.equal(0);
    expect(inv[slotOf(inv, ITEM.WOOD_PICKAXE)].durability).to.equal(59);
    expect(slotOf(inv, ITEM.WOOD_SHOVEL)).to.be.at.least(0);
  });

  it("place rejections: own body, no face, out of reach, occupied, not a block", async () => {
    const inv = (await state()).inv;
    const planks = slotOf(inv, ITEM.PLANKS);
    const [x, z, g] = [plan.S[0], plan.S[1], plan.g0];
    const cases: [V3, number, string][] = [
      [[x, g, z], planks, "SelfOverlap"],
      [plan.nfa, planks, "NotFaceAdjacent"],
      [[x, g + 8, z], planks, "OutOfReach"],
      [[x, g - 1, z], planks, "InvalidTarget"],
      [plan.nfa, slotOf(inv, ITEM.WOOD_PICKAXE), "NotPlaceable"],
    ];
    for (const [p, slot, code] of cases) {
      const err = await fails(act([placeIx(a, world, p, slot, existing)]));
      expect(err?.code, `${p}: ${err}`).to.equal(code);
    }
    expect(countItem((await state()).inv, ITEM.PLANKS)).to.equal(2);
  });

  it("placing into another player's body → SelfOverlap; allowed once their entry is stale", async () => {
    await move(b, center(...spawn));
    await walk(b, plan.pathB);
    const target = plan.pathB[plan.pathB.length - 1];
    const planks = slotOf((await state()).inv, ITEM.PLANKS);
    const err = await fails(act([placeIx(a, world, target, planks, existing)]));
    expect(err?.code, String(err)).to.equal("SelfOverlap");
    await sleep(STALE_MS + 1_000);
    await act([placeIx(a, world, target, planks, existing)]);
    expect(await blockAt(target)).to.equal(ITEM.PLANKS);
  });

  it("mining stone with a wooden pickaxe → cobblestone, durability used", async () => {
    const pick = slotOf((await state()).inv, ITEM.WOOD_PICKAXE);
    await logCu("select_slot", await act([selectIx(a, world, pick)]));
    await waitBreak(); // bare-hand stone: 7.5 s
    await logCu(
      "break_block (stone, pickaxe)",
      await act([breakIx(a, world, plan.stones[0])])
    );
    const inv = (await state()).inv;
    expect(await blockAt(plan.stones[0])).to.equal(0);
    expect(countItem(inv, ITEM.COBBLESTONE)).to.equal(1);
    expect(inv[pick].durability).to.equal(58);
  });

  it("gathering soft blocks with a shovel", async () => {
    const shovel = slotOf((await state()).inv, ITEM.WOOD_SHOVEL);
    await act([selectIx(a, world, shovel)]);
    for (const p of plan.soft) {
      await waitBreak();
      await logCu(
        "break_block (soft, shovel)",
        await act([breakIx(a, world, p)])
      );
    }
    const inv = (await state()).inv;
    const blocks = inv
      .filter((s) => s.item >= 1 && s.item <= 22)
      .reduce((n, s) => n + s.count, 0);
    expect(blocks).to.be.at.least(plan.soft.length + 2);
    expect(inv[shovel].durability).to.equal(59 - plan.soft.length);
  });

  it("fall damage: pillar up 8 blocks and step off", async () => {
    await pillar(plan.S, plan.g0, plan.g0 + SMALL_PILLAR);
    expect((await state()).acc.health).to.equal(20);
    await move(a, center(plan.C1[0], plan.g1, plan.C1[1]), { minDt: 600 });
    const dmg = plan.g0 + SMALL_PILLAR - plan.g1 - 3;
    const h = (await state()).acc.health;
    expect(h, `fall damage ${dmg}`).to.be.within(20 - dmg, 21 - dmg);
  });

  it("eating raw meat restores food", async () => {
    // Regeneration (≈ every 4 s) costs exhaustion until a food point goes.
    const here = center(plan.C1[0], plan.g1, plan.C1[1]);
    const deadline = Date.now() + 60_000;
    while ((await state()).acc.food >= 20) {
      expect(Date.now(), "food never dropped").to.be.below(deadline);
      await move(a, here, { minDt: 1_000 });
    }
    const s = await state();
    const meat = MEAT[hunt.animal.kind];
    const sig = await act([eatIx(a, world, slotOf(s.inv, meat))]);
    await logCu("eat", sig);
    const s2 = await state();
    expect(s2.acc.food).to.equal(Math.min(20, s.acc.food + FOOD_VALUE[meat]));
    expect(countItem(s2.inv, meat)).to.equal(countItem(s.inv, meat) - 1);
  });

  it("a lethal fall kills; the dead can't move, break, select or eat (Dead)", async () => {
    await pillar(plan.C1, plan.g1, plan.top);
    await move(a, center(plan.C2[0], plan.g2, plan.C2[1]), { minDt: 800 });
    const s = await state();
    expect(s.acc.health).to.equal(0);
    const errs = [
      await fails(move(a, center(plan.C2[0], plan.g2, plan.C2[1]))),
      await fails(
        act([breakIx(a, world, [plan.C2[0], plan.g2 - 1, plan.C2[1]])])
      ),
      await fails(act([selectIx(a, world, 0)])),
      await fails(act([eatIx(a, world, 0)])),
    ];
    for (const e of errs) expect(e?.code, String(e)).to.equal("Dead");
  });

  it("respawn: empty inventory, full vitals, back at the spawn; moving works again", async () => {
    const t0 = await chainMs(world);
    await logCu("respawn", await act([respawnIx(a, world)]));
    const s = await state();
    expect(s.acc.health).to.equal(20);
    expect(s.acc.food).to.equal(20);
    expect(s.acc.exhaustion).to.equal(0);
    expect(s.inv.every((x) => x.item === 0 && x.count === 0)).to.equal(true);
    expect(s.move.pos).to.deep.equal(center(...spawn));
    expect(s.move.lastMs).to.be.within(t0 - 1_000, t0 + 2_000);
    // Pending damage on entries last seen before this is dropped (presence::upsert).
    expect(s.acc.respawnMs.toNumber()).to.equal(s.move.lastMs);
    expect([s.acc.cx, s.acc.cz]).to.deep.equal(chunkOfBlock(spawn));
    // The route's edits may have removed the block under the spawn.
    const below = await blockAt([spawn[0], spawn[1] - 1, spawn[2]]);
    await move(a, center(...spawn), { onGround: isSolid(below) });
    expect((await state()).acc.health).to.equal(20);
  });
});
