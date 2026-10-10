// close_world: an untouched World (nobody joined, at most the spawn chunk) closes with
// its spawn chunk, refunding all rent to the creator's Player.
import { expect } from "chai";
import { web3 } from "@anchor-lang/core";
import { erConn, sendEr } from "./helpers/env";
import { setupPlayer, TestPlayer } from "./helpers/player";
import {
  CHUNK_TOTAL_RENT,
  chunkPda,
  createAndGrow,
  closeChunkIx,
  computeBudgetIx,
  populate,
  presencePda,
  setSpawnIx,
} from "./helpers/chunk";
import { erLamports, joinWorldIx } from "./helpers/play";
import {
  createWorldIx,
  ephemeralRent,
  fails,
  freshNonce,
  setupWorld,
  WORLD_LEN,
  worldPda,
} from "./helpers/world";

const gone = async (pk: web3.PublicKey) =>
  (await erConn.getAccountInfo(pk, "confirmed")) === null;

async function closeWorldIx(
  p: TestPlayer,
  world: web3.PublicKey,
  o: { signer?: web3.PublicKey } = {}
) {
  const chunk = chunkPda(world, 0, 0);
  const presence = presencePda(chunk);
  const ix = await p.er.methods
    .closeWorld()
    .accountsPartial({
      signer: o.signer ?? p.authority.publicKey,
      player: p.player,
      sessionToken: null,
      world,
      chunk,
      presence,
    })
    .instruction();
  // Writable iff the spawn chunk exists (the ER rejects writable missing accounts).
  const exists = !(await gone(chunk));
  for (const m of ix.keys)
    if (m.pubkey.equals(chunk) || m.pubkey.equals(presence))
      m.isWritable = exists;
  return ix;
}

async function openChunks(p: TestPlayer): Promise<number> {
  return (await p.er.account.player.fetch(p.player, "confirmed")).openChunks;
}

/** A seeded world with its spawn chunk generated (create + populate + set_spawn). */
async function worldWithSpawn(p: TestPlayer) {
  const { world } = await setupWorld({ player: p });
  await createAndGrow(p, world, 0, 0);
  await populate(world, 0, 0);
  await sendEr([await setSpawnIx(world)], [p.authority]);
  return world;
}

describe("close_world", () => {
  let p: TestPlayer;

  before(async () => {
    p = await setupPlayer({ depositSol: 0.1 });
  });

  it("a fresh world (no chunk, seed pending) closes: exact World rent back", async () => {
    const nonce = freshNonce();
    const world = worldPda(p.authority.publicKey, nonce);
    await sendEr([await createWorldIx(p, { nonce })], [p.authority]);
    const before = await erLamports(p.player);
    await sendEr([await closeWorldIx(p, world)], [p.authority]);
    expect((await erLamports(p.player)) - before).to.equal(
      ephemeralRent(WORLD_LEN)
    );
    expect(await gone(world)).to.equal(true);
  });

  it("a world with only its spawn chunk closes with it: World + chunk rent back", async () => {
    const world = await worldWithSpawn(p);
    const chunk = chunkPda(world, 0, 0);
    const open = await openChunks(p);
    const before = await erLamports(p.player);
    await sendEr([await closeWorldIx(p, world)], [p.authority]);
    expect((await erLamports(p.player)) - before).to.equal(
      ephemeralRent(WORLD_LEN) + CHUNK_TOTAL_RENT
    );
    expect(await gone(world)).to.equal(true);
    expect(await gone(chunk)).to.equal(true);
    expect(await gone(presencePda(chunk))).to.equal(true);
    expect(await openChunks(p)).to.equal(open - 1);
  });

  it("another Player → Unauthorized", async () => {
    const { world } = await setupWorld({ player: p });
    const q = await setupPlayer({ depositSol: 0.02 });
    const err = await fails(
      sendEr([await closeWorldIx(q, world)], [q.authority])
    );
    expect(err?.code, String(err)).to.equal("Unauthorized");
  });

  it("chunks beyond the spawn → WorldInUse; closable once they are closed", async () => {
    const world = await worldWithSpawn(p);
    await createAndGrow(p, world, 1, 0);
    const err = await fails(
      sendEr([await closeWorldIx(p, world)], [p.authority])
    );
    expect(err?.code, String(err)).to.equal("WorldInUse");
    await sendEr([await closeChunkIx(p, world, 1, 0)], [p.authority]);
    // A compute-budget ix keeps the retry distinct from the failed tx above.
    await sendEr(
      [computeBudgetIx(200_000), await closeWorldIx(p, world)],
      [p.authority]
    );
    expect(await gone(world)).to.equal(true);
  });

  it("someone joined → WorldInUse", async () => {
    const world = await worldWithSpawn(p);
    const q = await setupPlayer({ depositSol: 0.02 });
    await sendEr([await joinWorldIx(q, world)], [q.authority]);
    const err = await fails(
      sendEr([await closeWorldIx(p, world)], [p.authority])
    );
    expect(err?.code, String(err)).to.equal("WorldInUse");
  });
});
