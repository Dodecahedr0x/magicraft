// Worlds: create_world (ephemeral, Player-sponsored, arms the day crank),
// request_seed / callback_seed (VRF inside the ER), schedule_day_crank / tick_day.
import { randomBytes } from "crypto";
import { expect } from "chai";
import { BN, web3 } from "@anchor-lang/core";
import {
  baseConn,
  ER_TEST_QUEUE,
  erConn,
  erProgram,
  sendEr,
} from "./helpers/env";
import { setupPlayer, sleep, TestPlayer, until } from "./helpers/player";
import { createSessionIx, sessionTokenPda } from "./helpers/session";
import {
  createWorldIx as createWorldIxFor,
  cu,
  dayTaskId,
  ephemeralRent,
  fails,
  fetchWorld,
  freshNonce,
  params,
  programId,
  requestSeedIx as requestSeedIxFor,
  waitSeed,
  WORLD_LEN,
  worldPda,
} from "./helpers/world";

describe("world", () => {
  let p: TestPlayer;

  const createWorldIx = (o: Parameters<typeof createWorldIxFor>[1]) =>
    createWorldIxFor(p, o);
  const requestSeedIx = (
    world: web3.PublicKey,
    o: Parameters<typeof requestSeedIxFor>[2] = {}
  ) => requestSeedIxFor(p, world, o);

  async function newWorld(): Promise<web3.PublicKey> {
    const nonce = freshNonce();
    await sendEr([await createWorldIx({ nonce })], [p.authority]);
    return worldPda(p.authority.publicKey, nonce);
  }

  before(async () => {
    p = await setupPlayer({ depositSol: 0.05 });
  });

  it("rejects out-of-range params (InvalidParams)", async () => {
    for (const bad of [
      params({ daySecs: 10 }),
      params({ zombieCapPerChunk: 9 }),
      params({ pad: 1 }),
    ]) {
      const err = await fails(
        sendEr(
          [await createWorldIx({ nonce: freshNonce(), params: bad })],
          [p.authority]
        )
      );
      expect(err?.code, String(err)).to.equal("InvalidParams");
      expect(err?.number).to.equal(6107);
    }
  });

  let world: web3.PublicKey;
  let worldNonce: BN;

  it("creates the World on the ER; the Player pays exactly the ephemeral rent", async () => {
    worldNonce = freshNonce();
    world = worldPda(p.authority.publicKey, worldNonce);
    const before = (await erConn.getAccountInfo(p.player, "confirmed"))!
      .lamports;
    const sig = await sendEr(
      [await createWorldIx({ nonce: worldNonce })],
      [p.authority]
    );
    console.log(`    create_world CU: ${await cu(sig)}`);
    const after = (await erConn.getAccountInfo(p.player, "confirmed"))!
      .lamports;
    expect(before - after).to.equal(ephemeralRent(WORLD_LEN));

    const w = (await fetchWorld(world))!;
    expect(w.info.owner.toBase58()).to.equal(programId.toBase58());
    expect(w.info.data.length).to.equal(WORLD_LEN);
    expect(await baseConn.getAccountInfo(world)).to.equal(null);
    const acc = w.acc;
    expect(acc.creator.toBase58()).to.equal(p.authority.publicKey.toBase58());
    expect(acc.nonce.eq(worldNonce)).to.equal(true);
    const [, bump] = web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("world"),
        p.authority.publicKey.toBuffer(),
        worldNonce.toArrayLike(Buffer, "le", 8),
      ],
      programId
    );
    expect(acc.bump).to.equal(bump);
    expect(Buffer.from(acc.name).toString("utf8").replace(/\0+$/, "")).to.equal(
      "test world"
    );
    expect(acc.params.dayLengthSecs).to.equal(60);
    expect(acc.seedSet).to.equal(false);
    expect(acc.seed.every((b: number) => b === 0)).to.equal(true);
    expect(BigInt(acc.dayTaskId.toString())).to.equal(dayTaskId(world));
    expect(acc.clock.msPerSlot).to.equal(50);
    expect(acc.clock.anchorMs.toNumber()).to.be.greaterThan(0);
  });

  it("a second create_world with the same nonce fails", async () => {
    const err = await fails(
      sendEr([await createWorldIx({ nonce: worldNonce })], [p.authority])
    );
    expect(err, "duplicate create should fail").to.not.equal(null);
  });

  it("request_seed: the VRF callback sets a non-zero seed within 10 s", async () => {
    const t0 = Date.now();
    const sig = await sendEr([await requestSeedIx(world)], [p.authority]);
    const w = await waitSeed(world);
    const ms = Date.now() - t0;
    console.log(`    request_seed CU: ${await cu(sig)}; seed after ${ms} ms`);
    expect(w, "seed set").to.not.equal(null);
    expect(w!.acc.seed.some((b: number) => b !== 0)).to.equal(true);
  });

  it("request_seed once the seed is set → SeedAlreadySet", async () => {
    const err = await fails(
      sendEr([await requestSeedIx(world)], [p.authority])
    );
    expect(err?.code, String(err)).to.equal("SeedAlreadySet");
  });

  it("any delegated Player (not only the creator) can pay request_seed", async () => {
    const w = await newWorld();
    const other = await setupPlayer({ depositSol: 0.01 });
    const ix = await other.er.methods
      .requestSeed([...randomBytes(32)])
      .accountsPartial({
        signer: other.authority.publicKey,
        player: other.player,
        sessionToken: null,
        world: w,
        oracleQueue: ER_TEST_QUEUE,
      })
      .instruction();
    await sendEr([ix], [other.authority]);
    expect(await waitSeed(w), "seed set").to.not.equal(null);
  });

  it("request_seed with another wallet's Player → Unauthorized", async () => {
    const w = await newWorld();
    const rando = web3.Keypair.generate();
    const err = await fails(
      sendEr([await requestSeedIx(w, { signer: rando.publicKey })], [rando])
    );
    expect(err?.code, String(err)).to.equal("Unauthorized");
  });

  it("a forged callback signer is rejected (ConstraintAddress)", async () => {
    const forger = web3.Keypair.generate();
    const ix = await erProgram.methods
      .callbackSeed([...randomBytes(32)])
      .accountsPartial({ vrfProgramIdentity: forger.publicKey, world })
      .instruction();
    const err = await fails(sendEr([ix], [forger]));
    expect(err?.code, String(err)).to.equal("ConstraintAddress");
  });

  it("a second VRF callback cannot overwrite the seed (SeedAlreadySet)", async () => {
    // Two concurrent requests (separate txs) both pass our checks while the seed is
    // unset. The local test queue arrives full of stale devnet requests and has room
    // for ~1 pending request, so the VRF program may reject the second with
    // AccountDataTooSmall; if both are queued, the losing callback must fail with
    // SeedAlreadySet. Either way the seed never changes once set. (The guard itself
    // is also unit-tested: `state::tests::set_seed_only_once`.)
    const w2 = await newWorld();
    const [r1, r2] = [await requestSeedIx(w2), await requestSeedIx(w2)];
    const sent = await Promise.allSettled([
      sendEr([r1], [p.authority]),
      sendEr([r2], [p.authority]),
    ]);
    const accepted = sent.filter((r) => r.status === "fulfilled").length;
    for (const r of sent) {
      if (r.status === "rejected") {
        // Queue full, or the first callback already landed before this request.
        expect(String(r.reason)).to.match(/AccountDataTooSmall|SeedAlreadySet/);
      }
    }
    const first = await waitSeed(w2);
    expect(first, "seed set").to.not.equal(null);
    const seed = Buffer.from(first!.acc.seed).toString("hex");

    if (accepted === 2) {
      // The losing callback is a failed oracle tx on the World.
      const failed = await until(
        async () => {
          const sigs = await erConn.getSignaturesForAddress(w2, { limit: 50 });
          for (const s of sigs.filter((s) => s.err)) {
            const tx = await erConn.getTransaction(s.signature, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            });
            const logs = tx?.meta?.logMessages ?? [];
            if (logs.some((l) => l.includes("SeedAlreadySet"))) return logs;
          }
          return null;
        },
        10_000,
        200
      );
      expect(failed, "a rejected second callback").to.not.equal(null);
    } else {
      console.log(
        "    queue took 1 of 2 concurrent requests (local queue full); waiting anyway"
      );
      await sleep(1_000);
    }
    const now = (await fetchWorld(w2))!.acc;
    expect(Buffer.from(now.seed).toString("hex")).to.equal(seed);
  });

  it("the day crank (armed by create_world) advances time_of_day", async () => {
    const a = (await fetchWorld(world))!.acc;
    await sleep(3_200);
    const b = (await fetchWorld(world))!.acc;
    const ticks = b.dayTicks - a.dayTicks;
    const advanced = b.timeOfDayMs.toNumber() - a.timeOfDayMs.toNumber();
    const lastTick = b.lastTickMs.toNumber() - a.lastTickMs.toNumber();
    console.log(
      `    3.2 s: ${ticks} ticks, time_of_day +${advanced} ms, last_tick +${lastTick} ms`
    );
    expect(ticks).to.be.within(2, 5);
    expect(advanced).to.be.within(1_000, 5_000);
    expect(lastTick).to.be.within(1_000, 5_000);
    expect(b.timeOfDayMs.toNumber()).to.be.lessThan(60_000);
  });

  it("tick_day CU", async () => {
    // A direct (non-cranked) call: permissionless, any fee payer.
    const kp = web3.Keypair.generate();
    const sig = await sendEr(
      [
        await erProgram.methods
          .tickDay()
          .accountsPartial({ world })
          .instruction(),
      ],
      [kp]
    );
    console.log(`    tick_day CU: ${await cu(sig)}`);
  });

  it("schedule_day_crank while the crank is alive is a no-op: tick rate unchanged", async () => {
    const rate = async (ms: number) => {
      const a = (await fetchWorld(world))!.acc.dayTicks;
      await sleep(ms);
      return (await fetchWorld(world))!.acc.dayTicks - a;
    };
    const before = await rate(4_000);
    // Strangers with 0 lamports re-arm it three times (fresh signer per tx so the
    // txs are not identical).
    for (let i = 0; i < 3; i++) {
      const stranger = web3.Keypair.generate();
      const sig = await sendEr(
        [
          await erProgram.methods
            .scheduleDayCrank()
            .accountsPartial({ world })
            .instruction(),
        ],
        [stranger]
      );
      const tx = await erConn.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      expect(tx?.meta?.logMessages?.join("\n")).to.include("not re-armed");
      if (i === 0)
        console.log(
          `    schedule_day_crank (no-op) CU: ${tx?.meta?.computeUnitsConsumed}`
        );
    }
    await sleep(500);
    const after = await rate(4_000);
    console.log(
      `    ticks per 4 s: before ${before}, after re-arming ×3 ${after}`
    );
    expect(before).to.be.within(3, 5);
    expect(after).to.be.within(3, 5);
    const acc = (await fetchWorld(world))!.acc;
    expect(BigInt(acc.dayTaskId.toString())).to.equal(dayTaskId(world));
  });

  it("re-arm spam (every ~500 ms for 5 s) does not starve the day crank", async () => {
    const a = (await fetchWorld(world))!.acc.dayTicks;
    const t0 = Date.now();
    while (Date.now() - t0 < 5_000) {
      await sendEr(
        [
          await erProgram.methods
            .scheduleDayCrank()
            .accountsPartial({ world })
            .instruction(),
        ],
        [web3.Keypair.generate()]
      );
      await sleep(500);
    }
    const ticks = (await fetchWorld(world))!.acc.dayTicks - a;
    console.log(`    ticks during 5 s of re-arm spam: ${ticks}`);
    expect(ticks).to.be.within(4, 7);
  });

  describe("session keys", () => {
    const sessionKp = web3.Keypair.generate();
    let token: web3.PublicKey;

    before(async () => {
      token = sessionTokenPda(
        programId,
        sessionKp.publicKey,
        p.authority.publicKey
      );
      const tx = new web3.Transaction().add(
        createSessionIx({
          programId,
          signer: sessionKp.publicKey,
          authority: p.authority.publicKey,
          validUntil: Math.floor(Date.now() / 1000) + 3600,
        })
      );
      await web3.sendAndConfirmTransaction(baseConn, tx, [
        p.authority,
        sessionKp,
      ]);
    });

    it("a session key (0 lamports) creates a world and requests its seed", async () => {
      const nonce = freshNonce();
      const w = worldPda(p.authority.publicKey, nonce);
      await sendEr(
        [
          await createWorldIx({
            nonce,
            signer: sessionKp.publicKey,
            sessionToken: token,
          }),
        ],
        [sessionKp]
      );
      const acc = (await fetchWorld(w))!.acc;
      expect(acc.creator.toBase58()).to.equal(p.authority.publicKey.toBase58());
      await sendEr(
        [
          await requestSeedIx(w, {
            signer: sessionKp.publicKey,
            sessionToken: token,
          }),
        ],
        [sessionKp]
      );
      expect(await waitSeed(w), "seed set").to.not.equal(null);
    });

    it("a random signer without a token → Unauthorized (6100)", async () => {
      const rando = web3.Keypair.generate();
      const err = await fails(
        sendEr(
          [
            await createWorldIx({
              nonce: freshNonce(),
              signer: rando.publicKey,
            }),
          ],
          [rando]
        )
      );
      expect(err?.code, String(err)).to.equal("Unauthorized");
      expect(err?.number).to.equal(6100);
    });
  });
});
