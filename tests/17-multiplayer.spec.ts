// Multiplayer: two players in one world see each other through the presence
// list, hit each other (attack_player → pending_damage → the victim's next
// move), and leave_world takes a player out of reach: no presence entry, so
// neither zombies nor players can target it until it enters again. The World
// counts the players inside (join / enter_world / leave_world, and
// expire_players for clients silent for a minute).
import { expect } from "chai";
import { web3 } from "@anchor-lang/core";
import { erConn, sendEr } from "./helpers/env";
import { setupPlayer, sleep, TestPlayer } from "./helpers/player";
import {
  chunkPda,
  createAndGrow,
  populate,
  presencePda,
  setSpawnIx,
} from "./helpers/chunk";
import { fails, fetchWorld, setupWorld } from "./helpers/world";
import {
  center,
  chainMs,
  chunkOf,
  ENTRY_RENT,
  erLamports,
  fetchPlayerState,
  fetchPresence,
  hasEntry,
  enterWorldIx,
  expirePlayersIx,
  joinWorldIx,
  moveIx,
  nextClientMs,
  pstatePda,
  STALE_MS,
} from "./helpers/play";
import {
  attackPlayerIx,
  leaveWorldIx,
  selectIx,
  uniq,
} from "./helpers/actions";

/** play::EXPIRE_MS */
const EXPIRE_MS = 60_000;

describe("multiplayer: presence, PvP, leaving the world", () => {
  let a: TestPlayer;
  let b: TestPlayer;
  let world: web3.PublicKey;
  let spawn: number[]; // FP feet position at the spawn block center
  let cx: number;
  let cz: number;
  const existing = new Set<string>(["0,0"]);

  const state = async (p: TestPlayer) =>
    (await fetchPlayerState(pstatePda(world, p.player)))!;
  const presence = () => fetchPresence(presencePda(chunkPda(world, cx, cz)));

  async function move(p: TestPlayer, pos = spawn) {
    const st = await state(p);
    // `uniq`: a retry after a rejected move may otherwise repeat its exact bytes.
    return sendEr(
      [
        uniq(),
        await moveIx(p, world, {
          prev: st.move.pos,
          pos,
          onGround: true,
          clientMs: await nextClientMs(world, st.move.lastMs),
          existing,
        }),
      ],
      [p.authority]
    );
  }

  const hit = async (by: TestPlayer, target: TestPlayer) =>
    sendEr(
      [uniq(), await attackPlayerIx(by, world, target.player, cx, cz)],
      [by.authority]
    );

  async function waitAttack(p: TestPlayer) {
    const until = (await state(p)).acc.attackUntilMs.toNumber();
    while ((await chainMs(world)) < until + 150) await sleep(50);
  }

  /** The pending damage a tx applied, from its program log (regeneration may
   *  add a health point in the same move, so health alone is ambiguous). */
  async function appliedDamage(sig: string): Promise<number> {
    const tx = await erConn.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const m = (tx?.meta?.logMessages ?? [])
      .map((l) => /pending (?:damage )?(\d+) → health/.exec(l))
      .find((x) => x);
    return m ? Number(m[1]) : 0;
  }

  before(async () => {
    const tw = await setupWorld({ depositSol: 0.1 });
    ({ world } = tw);
    a = tw.p;
    b = await setupPlayer({ depositSol: 0.1 });
    await createAndGrow(a, world, 0, 0);
    await populate(world, 0, 0);
    await sendEr([await setSpawnIx(world)], [web3.Keypair.generate()]);
    const s = (await fetchWorld(world))!.acc.spawn as number[];
    spawn = center(s[0], s[1], s[2]);
    [cx, cz] = [chunkOf(spawn[0]), chunkOf(spawn[2])];
    for (const p of [a, b])
      await sendEr([await joinWorldIx(p, world)], [p.authority]);
  });

  const online = async () =>
    (await fetchWorld(world))!.acc.playersOnline as number;
  const enter = async (p: TestPlayer, expire: web3.PublicKey[] = []) =>
    sendEr([uniq(), await enterWorldIx(p, world, expire)], [p.authority]);

  it("joining counts both players in", async () => {
    expect(await online()).to.equal(2);
    expect((await fetchWorld(world))!.acc.entries).to.equal(2);
    expect((await state(a)).acc.inWorld).to.equal(1);
  });

  it("both players are listed fresh in the spawn chunk's presence", async () => {
    await move(a);
    await move(b);
    const pr = await presence();
    expect(hasEntry(pr, a.player) && hasEntry(pr, b.player)).to.equal(true);
  });

  it("a hits b: pending damage on b's entry, applied by b's next move", async () => {
    await sendEr([uniq(), await selectIx(a, world, 0)], [a.authority]);
    await hit(a, b);
    const e = (await presence()).entries.find((e) =>
      e.player.equals(b.player)
    )!;
    expect(e.pendingDamage).to.equal(1); // fist
    expect(await appliedDamage(await move(b))).to.equal(1);
    expect((await state(b)).acc.health).to.be.within(19, 20);
    const e2 = (await presence()).entries.find((e) =>
      e.player.equals(b.player)
    )!;
    expect(e2.pendingDamage).to.equal(0);
    // Attack cooldown (shared with attack_mob).
    const err = await fails(hit(a, b));
    expect(err?.code, String(err)).to.equal("Cooldown");
  });

  it("hitting yourself → InvalidTarget", async () => {
    await waitAttack(a);
    const err = await fails(hit(a, a));
    expect(err?.code, String(err)).to.equal("InvalidTarget");
  });

  it("knockback: b is pushed away from a (state + entry), and keeps moving from there", async () => {
    await waitAttack(a);
    // a stands 100 FP west of b (same block column: still on the spawn block).
    await move(a, [spawn[0] - 100, spawn[1], spawn[2]]);
    await move(b);
    const before = (await state(b)).move;
    await hit(a, b);
    const after = (await state(b)).move;
    expect(after.pos[0]).to.be.greaterThan(before.pos[0]); // pushed east (+x)
    expect(after.pos[0] - before.pos[0]).to.be.at.most(230); // PLAYER_KNOCKBACK
    expect([after.pos[1], after.pos[2]]).to.deep.equal([
      before.pos[1],
      before.pos[2],
    ]);
    expect(after.vel).to.deep.equal([0, 0, 0]);
    expect(after.lastMs).to.equal(before.lastMs + 1);
    const e = (await presence()).entries.find((e) =>
      e.player.equals(b.player)
    )!;
    expect(e.pos).to.deep.equal(after.pos);
    // b's next move is checked from the pushed state.
    await move(b, after.pos);
    expect((await state(b)).move.lastMs).to.be.greaterThan(after.lastMs);
    // Back on the spawn (same spot: no knockback) for the next tests.
    await waitAttack(a);
    await move(a);
  });

  it("leave_world: pending damage applied, entry removed (refund), b can't be hit", async () => {
    await waitAttack(a);
    await move(b); // fresh again
    await hit(a, b);
    const before = await erLamports(b.player);
    const health = (await state(b)).acc.health;
    const sig = await sendEr(
      [uniq(), await leaveWorldIx(b, world, cx, cz)],
      [b.authority]
    );
    expect(await appliedDamage(sig)).to.equal(1);
    expect((await state(b)).acc.health).to.equal(health - 1);
    expect(hasEntry(await presence(), b.player)).to.equal(false);
    expect((await erLamports(b.player)) - before).to.equal(ENTRY_RENT);
    await waitAttack(a);
    const err = await fails(hit(a, b));
    expect(err?.code, String(err)).to.equal("NoPlayer");
    expect(await online()).to.equal(1);
    expect((await state(b)).acc.inWorld).to.equal(0);
    // Leaving again is a no-op (no double count-out).
    await sendEr([uniq(), await leaveWorldIx(b, world, cx, cz)], [b.authority]);
    expect(await online()).to.equal(1);
  });

  it("a player who left can't move until it enters again (counted back in once)", async () => {
    const err = await fails(move(b));
    expect(err?.code, String(err)).to.equal("NotInWorld");
    await enter(b);
    await enter(b); // already in: no-op
    expect(await online()).to.equal(2);
    expect((await fetchWorld(world))!.acc.entries).to.equal(3);
    await move(b);
  });

  it("an idle player's entry goes stale: it can't be hit either", async () => {
    await move(a);
    await move(b);
    await sleep(STALE_MS + 1_000);
    const err = await fails(hit(a, b));
    expect(err?.code, String(err)).to.equal("NoPlayer");
  });

  it("coming back (a move) re-lists b: visible and attackable again", async () => {
    await move(b);
    await move(a);
    expect(hasEntry(await presence(), b.player)).to.equal(true);
    await waitAttack(a);
    await hit(a, b);
    expect(await appliedDamage(await move(b))).to.equal(1);
  });

  it("a silent player is kicked out after a minute (expire_players, or someone entering)", async () => {
    const sb = pstatePda(world, b.player);
    const sa = pstatePda(world, a.player);
    // Not silent yet: skipped, no error.
    await sendEr(
      [uniq(), await expirePlayersIx(world, [sb])],
      [web3.Keypair.generate()]
    );
    expect(await online()).to.equal(2);
    // Both silent for > 1 min (b "crashed"; a idles too).
    await sleep(EXPIRE_MS + 1_500);
    const sig = await sendEr(
      [uniq(), await expirePlayersIx(world, [sb])],
      [web3.Keypair.generate()]
    );
    expect(sig).to.be.a("string");
    expect(await online()).to.equal(1);
    expect((await state(b)).acc.inWorld).to.equal(0);
    // a comes back (still counted in: no +1) and counts out nobody else; b's
    // next move fails until it enters again.
    await enter(a, [sb, sa]);
    expect(await online()).to.equal(1);
    const err = await fails(move(b));
    expect(err?.code, String(err)).to.equal("NotInWorld");
    // Kicked out: no world action either until it enters again.
    const err2 = await fails(hit(b, a));
    expect(err2?.code, String(err2)).to.equal("NotInWorld");
    await enter(b);
    expect(await online()).to.equal(2);
  });
});
