// Joining a world and moving: join_world (PlayerState at spawn), move_player
// (core::physics::check_move against the 2×2 chunk window, presence entries
// with rent moving with the player, stale-entry pruning, session keys).
// The walk follows a path planned over magicraft-core's reference blocks
// (identical to the onchain chunks, see 12-chunk.spec.ts), since the terrain
// depends on the per-run VRF seed.
import { expect } from "chai";
import { web3 } from "@anchor-lang/core";
import { baseConn, sendEr } from "./helpers/env";
import { setupPlayer, sleep, TestPlayer } from "./helpers/player";
import {
  chunkData,
  chunkPda,
  CHUNK_BLOCKS_OFFSET,
  createAndGrow,
  ixCus,
  populate,
  presencePda,
  referenceChunk,
  setSpawnIx,
} from "./helpers/chunk";
import {
  ephemeralRent,
  fails,
  fetchWorld,
  programId,
  setupWorld,
  TestWorld,
} from "./helpers/world";
import {
  center,
  chainMs,
  chunkOf,
  ENTRY_RENT,
  erLamports,
  fetchPlayerState,
  fetchPresence,
  FP,
  hasEntry,
  joinWorldIx,
  moveIx,
  nextClientMs,
  planWalk,
  PRESENCE_ENTRY,
  PSTATE_LEN,
  pstatePda,
  STALE_MS,
} from "./helpers/play";
import {
  createSessionIx,
  revokeSessionIx,
  sessionTokenPda,
} from "./helpers/session";

type Vec3 = [number, number, number];

describe("join + move", () => {
  let tw: TestWorld;
  let w2: TestWorld; // a second (seeded) world of `a`
  let a: TestPlayer;
  let world: web3.PublicKey;
  let spawn: Vec3; // block coordinates
  let path: Vec3[]; // block waypoints, the last one in `target`
  let target: [number, number];
  const existing = new Set<string>(["0,0"]);
  const cus: number[] = [];

  /** A seeded world with (0,0) populated, its spawn set, and a walkable path
   *  from the spawn into an edge neighbor (retries a new world if the terrain
   *  offers none, e.g. a spawn on a tiny island). */
  before(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      tw = await setupWorld({ depositSol: 0.1 });
      ({ world } = tw);
      a = tw.p;
      await createAndGrow(a, world, 0, 0);
      await populate(world, 0, 0);
      await sendEr([await setSpawnIx(world)], [web3.Keypair.generate()]);
      spawn = (await fetchWorld(world))!.acc.spawn as Vec3;
      const ref00 = referenceChunk(tw.seed, 0, 0);
      const onchain = (await chunkData(chunkPda(world, 0, 0)))!.subarray(
        CHUNK_BLOCKS_OFFSET,
        CHUNK_BLOCKS_OFFSET + 16_384
      );
      expect(onchain.equals(ref00.blocks), "onchain = reference").to.equal(
        true
      );
      let best: { path: Vec3[]; target: [number, number] } | null = null;
      for (const t of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as [number, number][]) {
        const blocks = new Map([
          ["0,0", ref00.blocks],
          [`${t[0]},${t[1]}`, referenceChunk(tw.seed, t[0], t[1]).blocks],
        ]);
        const p = planWalk(blocks, [spawn[0], spawn[2]], t);
        if (p && (!best || p.length < best.path.length))
          best = { path: p, target: t };
      }
      if (best) {
        ({ path, target } = best);
        break;
      }
      console.log(`    world ${attempt}: no walkable path, retrying`);
    }
    expect(path, "walkable path found").to.not.equal(undefined);
    await createAndGrow(a, world, target[0], target[1]);
    await populate(world, target[0], target[1]);
    existing.add(`${target[0]},${target[1]}`);
    console.log(
      `    spawn ${spawn}, walking ${path.length} blocks into chunk ${target}`
    );
  });

  /** Sends one move for `p` from its stored state; returns the tx signature. */
  async function move(
    p: TestPlayer,
    pos: number[],
    o: {
      onGround?: boolean;
      clientMs?: number;
      signer?: web3.Keypair;
      sessionToken?: web3.PublicKey | null;
      minDt?: number;
    } = {}
  ) {
    const st = (await fetchPlayerState(pstatePda(world, p.player)))!;
    const clientMs =
      o.clientMs ?? (await nextClientMs(world, st.move.lastMs, o.minDt));
    return sendEr(
      [
        await moveIx(p, world, {
          prev: st.move.pos,
          pos,
          onGround: o.onGround ?? true,
          clientMs,
          existing,
          signer: o.signer?.publicKey,
          sessionToken: o.sessionToken,
        }),
      ],
      [o.signer ?? p.authority]
    );
  }

  const spawnPos = () => center(spawn[0], spawn[1], spawn[2]);

  it("join_world before the spawn is set → SpawnNotSet", async () => {
    w2 = await setupWorld({ player: a });
    const err = await fails(
      sendEr([await joinWorldIx(a, w2.world)], [a.authority])
    );
    expect(err?.code, String(err)).to.equal("SpawnNotSet");
  });

  it("join_world: PlayerState at the spawn, health/food 20, exact rent", async () => {
    const before = await erLamports(a.player);
    const t0 = await chainMs(world);
    const sig = await sendEr([await joinWorldIx(a, world)], [a.authority]);
    console.log(`    CU join_world ${(await ixCus(sig)).ixs[0]}`);
    expect(before - (await erLamports(a.player))).to.equal(
      ephemeralRent(PSTATE_LEN)
    );
    const st = (await fetchPlayerState(pstatePda(world, a.player)))!;
    expect(st.info.data.length).to.equal(PSTATE_LEN);
    expect(st.acc.health).to.equal(20);
    expect(st.acc.food).to.equal(20);
    expect(st.acc.player.toBase58()).to.equal(a.player.toBase58());
    expect(st.move.pos).to.deep.equal(spawnPos());
    expect(st.move.onGround).to.equal(false);
    expect([st.acc.cx, st.acc.cz]).to.deep.equal([
      chunkOf(spawnPos()[0]),
      chunkOf(spawnPos()[2]),
    ]);
    // last_ms = the chain-time reading at join.
    expect(st.move.lastMs).to.be.within(t0 - 1_000, t0 + 2_000);
    expect(st.acc.foodTickMs.toNumber()).to.equal(st.move.lastMs);
  });

  it("joining twice fails", async () => {
    const err = await fails(
      sendEr(
        [
          web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_001 }),
          await joinWorldIx(a, world),
        ],
        [a.authority]
      )
    );
    expect(err, "second join").to.not.equal(null);
  });

  it("first move adds the presence entry (mover pays one entry)", async () => {
    const presence = presencePda(chunkPda(world, 0, 0));
    const before = await erLamports(a.player);
    const p0 = await fetchPresence(presence);
    const sig = await move(a, spawnPos());
    console.log(
      `    CU move_player (first, presence grow) ${(await ixCus(sig)).ixs[0]}`
    );
    expect(before - (await erLamports(a.player))).to.equal(ENTRY_RENT);
    const p1 = await fetchPresence(presence);
    expect(p1.len).to.equal(p0.len + PRESENCE_ENTRY);
    const e = p1.entries.find((e) => e.player.equals(a.player))!;
    expect(e.pos).to.deep.equal(spawnPos());
    const st = (await fetchPlayerState(pstatePda(world, a.player)))!;
    expect(st.move.onGround).to.equal(true);
  });

  it("a valid walk is accepted (one block per update, client timestamps)", async () => {
    const before = await erLamports(a.player);
    for (const [x, y, z] of path.slice(0, -1)) {
      const sig = await move(a, center(x, y, z));
      cus.push((await ixCus(sig)).ixs[0]);
    }
    const st = (await fetchPlayerState(pstatePda(world, a.player)))!;
    const last = path.length > 1 ? path[path.length - 2] : spawn;
    expect(st.move.pos).to.deep.equal(center(...last));
    expect(st.acc.health).to.equal(20);
    // Moving within a chunk costs no rent.
    expect(await erLamports(a.player)).to.equal(before);
    if (cus.length)
      console.log(
        `    CU move_player (in-chunk walk, ${
          cus.length
        } moves): min ${Math.min(...cus)}, max ${Math.max(...cus)}`
      );
  });

  it("crossing a chunk border moves the presence entry; rent nets to exactly 0", async () => {
    const oldP = presencePda(chunkPda(world, 0, 0));
    const newP = presencePda(chunkPda(world, target[0], target[1]));
    const [o0, n0] = [await fetchPresence(oldP), await fetchPresence(newP)];
    expect(hasEntry(o0, a.player)).to.equal(true);
    const before = await erLamports(a.player);
    const sig = await move(a, center(...path[path.length - 1]));
    const c = (await ixCus(sig)).ixs[0];
    console.log(`    CU move_player (border crossing) ${c}`);
    expect(await erLamports(a.player)).to.equal(before);
    const [o1, n1] = [await fetchPresence(oldP), await fetchPresence(newP)];
    expect(hasEntry(o1, a.player)).to.equal(false);
    expect(o1.len).to.equal(o0.len - PRESENCE_ENTRY);
    expect(hasEntry(n1, a.player)).to.equal(true);
    expect(n1.len).to.equal(n0.len + PRESENCE_ENTRY);
    const st = (await fetchPlayerState(pstatePda(world, a.player)))!;
    expect([st.acc.cx, st.acc.cz]).to.deep.equal(target);
  });

  describe("rejections (state unchanged)", () => {
    let pos: number[];
    let lastMs: number;
    beforeEach(async () => {
      const st = (await fetchPlayerState(pstatePda(world, a.player)))!;
      pos = st.move.pos;
      lastMs = st.move.lastMs;
    });
    afterEach(async () => {
      const st = (await fetchPlayerState(pstatePda(world, a.player)))!;
      expect(st.move.pos).to.deep.equal(pos);
      expect(st.move.lastMs).to.equal(lastMs);
    });

    it("teleport → MoveTooFast", async () => {
      const err = await fails(move(a, [pos[0] + 40 * FP, pos[1], pos[2]]));
      expect(err?.code, String(err)).to.equal("MoveTooFast");
    });

    it("walking into stone → Collision", async () => {
      const err = await fails(
        move(a, [pos[0], pos[1] - FP, pos[2]], { onGround: false })
      );
      expect(err?.code, String(err)).to.equal("Collision");
    });

    it("client_ms too far ahead of chain time → TimeSkew", async () => {
      const ahead = (await chainMs(world)) + 5_000;
      const err = await fails(move(a, pos, { clientMs: ahead }));
      expect(err?.code, String(err)).to.equal("TimeSkew");
    });

    it("client_ms not after the last accepted one → TimeSkew", async () => {
      const err = await fails(move(a, pos, { clientMs: lastMs }));
      expect(err?.code, String(err)).to.equal("TimeSkew");
    });

    /** A rejected move from the current state with `existing`/presence overrides. */
    async function badMove(
      to: number[],
      o: {
        existing?: Set<string>;
        presence?: web3.PublicKey;
        oldPresence?: web3.PublicKey | null;
      } = {}
    ) {
      const ix = await moveIx(a, world, {
        prev: pos,
        pos: to,
        onGround: true,
        clientMs: await nextClientMs(world, lastMs),
        existing: o.existing ?? existing,
        presence: o.presence,
        oldPresence: o.oldPresence,
      });
      return fails(sendEr([ix], [a.authority]));
    }
    const back = () =>
      center(...(path.length > 1 ? path[path.length - 2] : spawn));

    it("crossing back with the previous (own) chunk omitted → ChunkNotReady", async () => {
      const err = await badMove(back(), { existing: new Set(["0,0"]) });
      expect(err?.code, String(err)).to.equal("ChunkNotReady");
    });

    it("in place with the own chunk omitted → ChunkNotReady", async () => {
      const err = await badMove(pos, { existing: new Set(["0,0"]) });
      expect(err?.code, String(err)).to.equal("ChunkNotReady");
    });

    it("crossing back without old_presence → InvalidPresence", async () => {
      const err = await badMove(back(), { oldPresence: null });
      expect(err?.code, String(err)).to.equal("InvalidPresence");
    });

    it("the presence of another chunk → InvalidPresence", async () => {
      const err = await badMove(pos, {
        presence: presencePda(chunkPda(world, 0, 0)),
      });
      expect(err?.code, String(err)).to.equal("InvalidPresence");
    });

    it("a chunk of another world → InvalidChunk", async () => {
      await createAndGrow(a, w2.world, 0, 0);
      const ix = await moveIx(a, world, {
        prev: pos,
        pos,
        onGround: true,
        clientMs: await nextClientMs(world, lastMs),
        existing,
      });
      const own = chunkPda(world, target[0], target[1]);
      const idx = ix.keys.findIndex((k) => k.pubkey.equals(own));
      ix.keys[idx] = { ...ix.keys[idx], pubkey: chunkPda(w2.world, 0, 0) };
      const err = await fails(sendEr([ix], [a.authority]));
      expect(err?.code, String(err)).to.equal("InvalidChunk");
    });

    it("a chunk passed in the wrong window slot → InvalidChunk", async () => {
      const ix = await moveIx(a, world, {
        prev: pos,
        pos,
        onGround: true,
        clientMs: await nextClientMs(world, lastMs),
        existing,
      });
      // In place at a column center, the window origin is the current chunk
      // (slot chunk00); pass chunk (0,0) there instead.
      const own = chunkPda(world, target[0], target[1]);
      const idx = ix.keys.findIndex((k) => k.pubkey.equals(own));
      ix.keys[idx] = { ...ix.keys[idx], pubkey: chunkPda(world, 0, 0) };
      const err = await fails(sendEr([ix], [a.authority]));
      expect(err?.code, String(err)).to.equal("InvalidChunk");
    });
  });

  it("a stale presence entry is pruned by another player's move (pruner refunded)", async () => {
    const [b, c] = await Promise.all([
      setupPlayer({ depositSol: 0.02 }),
      setupPlayer({ depositSol: 0.02 }),
    ]);
    for (const p of [b, c]) {
      await sendEr([await joinWorldIx(p, world)], [p.authority]);
      await move(p, spawnPos());
    }
    const presence = presencePda(chunkPda(world, 0, 0));
    expect(hasEntry(await fetchPresence(presence), b.player)).to.equal(true);
    await sleep(STALE_MS + 800);
    const p0 = await fetchPresence(presence);
    const before = await erLamports(c.player);
    await move(c, spawnPos());
    const p1 = await fetchPresence(presence);
    expect(hasEntry(p1, b.player), "b pruned").to.equal(false);
    expect(hasEntry(p1, c.player), "c kept").to.equal(true);
    const pruned = (p0.len - p1.len) / PRESENCE_ENTRY;
    expect(pruned).to.be.within(1, 4);
    expect((await erLamports(c.player)) - before).to.equal(pruned * ENTRY_RENT);
  });

  describe("session keys", () => {
    let d: TestPlayer;
    const sessionKp = web3.Keypair.generate();
    let token: web3.PublicKey;

    async function createSession(signer: web3.Keypair, validUntil: number) {
      const tx = new web3.Transaction().add(
        createSessionIx({
          programId,
          signer: signer.publicKey,
          authority: d.authority.publicKey,
          validUntil,
        })
      );
      await web3.sendAndConfirmTransaction(baseConn, tx, [d.authority, signer]);
      return sessionTokenPda(
        programId,
        signer.publicKey,
        d.authority.publicKey
      );
    }

    before(async () => {
      d = await setupPlayer({ depositSol: 0.02 });
      token = await createSession(
        sessionKp,
        Math.floor(Date.now() / 1000) + 3600
      );
      await sendEr(
        [
          await joinWorldIx(d, world, {
            signer: sessionKp.publicKey,
            sessionToken: token,
          }),
        ],
        [sessionKp]
      );
    });

    it("a session key with 0 lamports moves the player", async () => {
      expect(await erLamports(sessionKp.publicKey)).to.equal(0);
      const sig = await move(d, spawnPos(), {
        signer: sessionKp,
        sessionToken: token,
      });
      console.log(
        `    CU move_player (session key, presence grow) ${
          (await ixCus(sig)).ixs[0]
        }`
      );
      const sig2 = await move(d, spawnPos(), {
        signer: sessionKp,
        sessionToken: token,
      });
      console.log(
        `    CU move_player (session key, in place) ${
          (await ixCus(sig2)).ixs[0]
        }`
      );
    });

    it("a random signer without a token → Unauthorized (6100)", async () => {
      const err = await fails(
        move(d, spawnPos(), { signer: web3.Keypair.generate() })
      );
      expect(err?.code, String(err)).to.equal("Unauthorized");
      expect(err?.number).to.equal(6100);
    });

    it("a random signer with someone else's token → InvalidToken (6001)", async () => {
      const err = await fails(
        move(d, spawnPos(), {
          signer: web3.Keypair.generate(),
          sessionToken: token,
        })
      );
      expect(err?.number, String(err)).to.equal(6001);
    });

    it("an expired token → InvalidToken (6001)", async () => {
      const kp = web3.Keypair.generate();
      const t = await createSession(kp, Math.floor(Date.now() / 1000) - 60);
      const err = await fails(
        move(d, spawnPos(), { signer: kp, sessionToken: t })
      );
      expect(err?.number, String(err)).to.equal(6001);
    });

    it("a revoked token is rejected", async () => {
      const kp = web3.Keypair.generate();
      const t = await createSession(kp, Math.floor(Date.now() / 1000) + 3600);
      await move(d, spawnPos(), { signer: kp, sessionToken: t });
      await web3.sendAndConfirmTransaction(
        baseConn,
        new web3.Transaction().add(revokeSessionIx(t, d.authority.publicKey)),
        [d.authority]
      );
      const err = await fails(
        move(d, spawnPos(), { signer: kp, sessionToken: t })
      );
      console.log(`    revoked token: ${err?.code ?? err?.number}`);
      expect(err, "revoked token rejected").to.not.equal(null);
    });
  });
});
