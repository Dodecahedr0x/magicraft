import { Connection, Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  armChunkIx,
  attackMobIx,
  breakBlockIx,
  closeChunkIx,
  craftIx,
  createAndGrowIxs,
  createChunkIx,
  createWorldIx,
  creationChain,
  eatIx,
  viewOf,
  joinWorldIx,
  moveIx,
  moveWindow,
  nameBytes,
  placeBlockIx,
  populateChunkIx,
  requestSeedIx,
  respawnIx,
  scheduleDayCrankIx,
  selectSlotIx,
  sessionAuth,
  setSpawnIx,
  walletAuth,
  ChunkNotReadyError,
  requiredSlots,
  measureUsPerSlot,
} from "./actions";
import { DEFAULT_EPHEMERAL_QUEUE, DEFAULT_EPHEMERAL_TEST_QUEUE, loadConfig } from "./config";
import { DEFAULT_WORLD_PARAMS, nextClientMs, type V3 } from "./layout";
import { onboardingIxs, topUpIx, withdrawBaseIx, withdrawIx } from "./player";
import { errorCode, IDL, idlFor, makeProgram, PROGRAM_ERRORS } from "./program";
import { chunkPda, playerPda, presencePda, pstatePda, worldPda } from "./pdas";
import { newSession } from "./session";

const conn = new Connection("http://127.0.0.1:1");
const cfg = loadConfig();
const program = makeProgram(cfg, conn);
const pid = program.programId;
const walletKp = Keypair.generate();
const wallet = walletKp.publicKey;
const player = playerPda(pid, wallet);
const { session } = newSession(pid, wallet);
const auth = sessionAuth(session, player);
const world = worldPda(pid, wallet, 7n);

/** The meta of `name` in an ix built from the IDL (by account order). */
function meta(ix: TransactionInstruction, ixName: string, acc: string) {
  const def = IDL.instructions.find((i) => i.name === ixName)!;
  const at = def.accounts.findIndex((a) => a.name === acc);
  expect(at, `${ixName}.${acc}`).toBeGreaterThanOrEqual(0);
  return ix.keys[at];
}
const isProgramPlaceholder = (m: { pubkey: PublicKey }) => m.pubkey.equals(pid);

describe("program / IDL patching", () => {
  it("rewrites the program id and VRF queue from the config", async () => {
    const other = Keypair.generate().publicKey;
    const queue = DEFAULT_EPHEMERAL_QUEUE;
    const c2 = { ...cfg, programId: other, vrfQueue: queue };
    const idl = idlFor(c2);
    expect(idl.address).toBe(other.toBase58());
    const p2 = makeProgram(c2, conn);
    expect(p2.programId.equals(other)).toBe(true);
    const ix = await requestSeedIx(p2, auth, world);
    expect(ix.programId.equals(other)).toBe(true);
    expect(meta(ix, "request_seed", "oracle_queue").pubkey.equals(queue)).toBe(true);
    const del = (await onboardingIxs(p2, c2, wallet, 1))[2];
    expect(meta(del, "delegate_player", "owner_program").pubkey.equals(other)).toBe(true);
    // the default (local) config keeps the test queue
    const ix1 = await requestSeedIx(program, auth, world);
    expect(meta(ix1, "request_seed", "oracle_queue").pubkey.equals(DEFAULT_EPHEMERAL_TEST_QUEUE)).toBe(true);
    // the shared IDL object is untouched
    expect(IDL.address).not.toBe(other.toBase58());
  });

  it("error table: IDL, session and Anchor errors", () => {
    expect(errorCode("Unauthorized")).toBe(6100);
    expect(errorCode("MoveTooFast")).toBe(6115);
    expect(PROGRAM_ERRORS.get(6001)?.name).toBe("InvalidToken");
    expect(PROGRAM_ERRORS.get(2006)?.name).toBe("ConstraintSeeds");
    for (const e of IDL.errors) expect(PROGRAM_ERRORS.get(e.code)?.name).toBe(e.name);
  });
});

describe("player builders", () => {
  it("onboarding pins the configured ER validator", async () => {
    const ixs = await onboardingIxs(program, cfg, wallet, 50_000_000);
    expect(ixs).toHaveLength(3);
    for (const ix of ixs) expect(ix.keys[0].pubkey.equals(wallet) && ix.keys[0].isSigner).toBe(true);
    // delegate_player(validator: Option<Pubkey>): disc(8) + Some(1) + pubkey
    expect(ixs[2].data[8]).toBe(1);
    expect(new PublicKey(ixs[2].data.subarray(9, 41)).equals(cfg.erValidator)).toBe(true);
    expect(ixs[1].data.readBigUInt64LE(8)).toBe(50_000_000n);
  });

  it("top-up uses a fresh salt per call", async () => {
    const a = await topUpIx(wallet, player, 1_000_000);
    const b = await topUpIx(wallet, player, 1_000_000);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(false);
    await expect(topUpIx(wallet, player, 1, new Uint8Array(31))).rejects.toThrow();
  });

  it("withdraw / withdraw_base", async () => {
    const w = await withdrawIx(program, wallet);
    expect(meta(w, "withdraw", "player").pubkey.equals(player)).toBe(true);
    const wb = await withdrawBaseIx(program, wallet, 123n);
    expect(wb.data.readBigUInt64LE(8)).toBe(123n);
  });
});

describe("gameplay builders", () => {
  it("session auth accounts", async () => {
    const ix = await joinWorldIx(program, auth, world);
    expect(meta(ix, "join_world", "signer").pubkey.equals(session.kp.publicKey)).toBe(true);
    expect(meta(ix, "join_world", "signer").isSigner).toBe(true);
    expect(meta(ix, "join_world", "session_token").pubkey.equals(session.token)).toBe(true);
    expect(meta(ix, "join_world", "player_state").pubkey.equals(pstatePda(pid, world, player))).toBe(true);
    // wallet-signed: no token (optional account = program id placeholder)
    const ix2 = await joinWorldIx(program, walletAuth(wallet, player), world);
    expect(isProgramPlaceholder(meta(ix2, "join_world", "session_token"))).toBe(true);
  });

  it("create_world derives the World from the wallet + nonce", async () => {
    const ix = await createWorldIx(program, auth, 7n, "my world", { ...DEFAULT_WORLD_PARAMS });
    expect(meta(ix, "create_world", "world").pubkey.equals(world)).toBe(true);
    expect(nameBytes("x".repeat(40))).toHaveLength(32);
    expect(nameBytes("é".repeat(20)).filter((b) => b !== 0)).toHaveLength(32);
  });

  it("create_chunk / close_chunk neighbor slots are writable iff they exist", async () => {
    const exists = viewOf(new Set(["0,0", "2,1"])); // only W = (0,0) of (1,0) exists
    const ix = await createChunkIx(program, auth, world, 1, 0, exists);
    const n = meta(ix, "create_chunk", "chunk_n");
    const s = meta(ix, "create_chunk", "chunk_s");
    const e = meta(ix, "create_chunk", "chunk_e");
    const w = meta(ix, "create_chunk", "chunk_w");
    expect(n.pubkey.equals(chunkPda(pid, world, 1, -1)) && !n.isWritable).toBe(true);
    expect(s.pubkey.equals(chunkPda(pid, world, 1, 1)) && !s.isWritable).toBe(true);
    expect(e.pubkey.equals(chunkPda(pid, world, 2, 0)) && !e.isWritable).toBe(true);
    expect(w.pubkey.equals(chunkPda(pid, world, 0, 0)) && w.isWritable).toBe(true);
    expect(isProgramPlaceholder(meta(ix, "create_chunk", "player_state"))).toBe(true);
    const chunk = chunkPda(pid, world, 1, 0);
    expect(meta(ix, "create_chunk", "presence").pubkey.equals(presencePda(pid, chunk))).toBe(true);

    const [c, g] = await createAndGrowIxs(program, auth, world, 1, 0, exists, pstatePda(pid, world, player));
    expect(meta(c, "create_chunk", "player_state").pubkey.equals(pstatePda(pid, world, player))).toBe(true);
    expect(meta(g, "grow_chunk", "player").pubkey.equals(player)).toBe(true);

    const close = await closeChunkIx(program, auth, world, 1, 0, viewOf(new Set(["1,-1"])));
    expect(meta(close, "close_chunk", "chunk_n").isWritable).toBe(true);
    expect(meta(close, "close_chunk", "chunk_w").isWritable).toBe(false);
  });

  it("permissionless builders", async () => {
    const pop = await populateChunkIx(program, world, -2, 3);
    expect(meta(pop, "populate_chunk", "chunk").pubkey.equals(chunkPda(pid, world, -2, 3))).toBe(true);
    const sp = await setSpawnIx(program, world);
    expect(meta(sp, "set_spawn", "chunk").pubkey.equals(chunkPda(pid, world, 0, 0))).toBe(true);
    const arm = await armChunkIx(program, world, 4, 4);
    expect(meta(arm, "arm_chunk", "chunk").pubkey.equals(chunkPda(pid, world, 4, 4))).toBe(true);
    const day = await scheduleDayCrankIx(program, world);
    expect(meta(day, "schedule_day_crank", "world").pubkey.equals(world)).toBe(true);
  });

  it("requiredSlots (cases of play.rs required_slots_cover_both_footprints)", () => {
    const c = (b: number) => b * 256 + 128;
    expect(requiredSlots([c(8), 0, c(8)], [c(9), 0, c(8)], 0, 0)).toEqual([true, false, false, false]);
    expect(requiredSlots([c(15), 0, c(8)], [c(16), 0, c(8)], 0, 0)).toEqual([true, true, false, false]);
    expect(requiredSlots([4096 - 10, 0, c(8)], [c(24), 0, c(8)], 0, 0)).toEqual([true, true, false, false]);
    expect(requiredSlots([c(15), 0, c(15)], [c(16), 0, c(16)], 0, 0)).toEqual([true, false, false, true]);
    expect(requiredSlots([c(-1), 0, c(-1)], [c(-1), 0, c(-1)], -1, -1)).toEqual([true, false, false, false]);
    expect(requiredSlots([-10, 0, c(3)], [-10, 0, c(3)], -1, 0)).toEqual([true, true, false, false]);
  });

  it("move_player: required slots must be ready, optional ones only if ready", async () => {
    const c = (b: number) => b * 256 + 128;
    const diag = { prev: [c(15), 7000, c(15)] as V3, pos: [c(16), 7000, c(16)] as V3, onGround: true, clientMs: 1 };
    // corner crossing (0,0) → (1,1): (1,0) and (0,1) optional
    const ready = await moveIx(program, auth, world, { ...diag, view: viewOf(new Set(["0,0", "1,1", "1,0"])) });
    expect(meta(ready, "move_player", "chunk10").pubkey.equals(chunkPda(pid, world, 1, 0))).toBe(true);
    expect(isProgramPlaceholder(meta(ready, "move_player", "chunk01"))).toBe(true);
    // (1,1) exists but is not ready: required → ChunkNotReadyError
    await expect(
      moveIx(program, auth, world, { ...diag, view: viewOf(new Set(["0,0", "1,1"]), new Set(["0,0"])) }),
    ).rejects.toMatchObject({ cx: 1, cz: 1 });
  });

  it("nextClientMs", () => {
    expect(nextClientMs(10_000, 5_000)).toBe(9_970); // just behind the estimate
    expect(nextClientMs(10_000, 9_990)).toBe(9_991); // strictly after the last one
    expect(nextClientMs(10_000, 9_990, 150)).toBe(10_140); // ahead, within the lead
    expect(nextClientMs(10_000, 10_100, 150)).toBeNull(); // too far ahead: wait
  });

  it("move_player: 2×2 window, presences on crossing", async () => {
    // move window (port of physics::move_window)
    expect(moveWindow([50, 0, 50], [60, 0, 60])).toEqual([-1, -1]); // body margin crosses 0
    expect(moveWindow([2000, 0, 2000], [2100, 0, 2100])).toEqual([0, 0]);
    expect(moveWindow([0, 0, 0], [9000, 0, 0])).toBeNull();
    const all = viewOf(new Set(["0,0", "1,0", "1,1"])); // (0,1) missing
    // walk east across x = 4096 (chunk 0 → 1) at z mid-chunk
    const ix = await moveIx(program, auth, world, {
      prev: [4000, 7000, 2048],
      pos: [4200, 7000, 2048],
      onGround: true,
      clientMs: 1_760_000_000_000,
      view: all,
    });
    expect(meta(ix, "move_player", "chunk00").pubkey.equals(chunkPda(pid, world, 0, 0))).toBe(true);
    expect(meta(ix, "move_player", "chunk10").pubkey.equals(chunkPda(pid, world, 1, 0))).toBe(true);
    expect(isProgramPlaceholder(meta(ix, "move_player", "chunk01"))).toBe(true);
    expect(meta(ix, "move_player", "chunk11").pubkey.equals(chunkPda(pid, world, 1, 1))).toBe(true);
    expect(meta(ix, "move_player", "presence").pubkey.equals(presencePda(pid, chunkPda(pid, world, 1, 0)))).toBe(true);
    expect(meta(ix, "move_player", "old_presence").pubkey.equals(presencePda(pid, chunkPda(pid, world, 0, 0)))).toBe(true);
    // no crossing: old_presence omitted
    const ix2 = await moveIx(program, auth, world, {
      prev: [2000, 7000, 2000],
      pos: [2050, 7000, 2000],
      onGround: true,
      clientMs: 1,
      view: all,
    });
    expect(isProgramPlaceholder(meta(ix2, "move_player", "old_presence"))).toBe(true);
  });

  it("break_block passes only the ready neighbors across touched borders", async () => {
    const all = viewOf(new Set(["-1,0", "0,0", "-1,-1", "-1,1", "-2,0"]));
    // lx 15 of chunk -1, lz 5: only E
    const ix = await breakBlockIx(program, auth, world, [-1, 30, 5], all);
    expect(meta(ix, "break_block", "chunk").pubkey.equals(chunkPda(pid, world, -1, 0))).toBe(true);
    expect(meta(ix, "break_block", "chunk_e").pubkey.equals(chunkPda(pid, world, 0, 0))).toBe(true);
    for (const k of ["chunk_n", "chunk_s", "chunk_w"]) expect(isProgramPlaceholder(meta(ix, "break_block", k))).toBe(true);
    // corner lx 0, lz 0 of chunk -1: W and N
    const c = await breakBlockIx(program, auth, world, [-16, 30, 0], all);
    expect(meta(c, "break_block", "chunk_w").pubkey.equals(chunkPda(pid, world, -2, 0))).toBe(true);
    expect(meta(c, "break_block", "chunk_n").pubkey.equals(chunkPda(pid, world, -1, -1))).toBe(true);
    expect(isProgramPlaceholder(meta(c, "break_block", "chunk_e"))).toBe(true);
    expect(isProgramPlaceholder(meta(c, "break_block", "chunk_s"))).toBe(true);
    // interior: none; a border neighbor that exists but isn't ready: omitted
    const i = await breakBlockIx(program, auth, world, [-8, 30, 8], all);
    for (const k of ["chunk_n", "chunk_s", "chunk_e", "chunk_w"]) expect(isProgramPlaceholder(meta(i, "break_block", k))).toBe(true);
    const nr = await breakBlockIx(program, auth, world, [-1, 30, 5], viewOf(new Set(["-1,0", "0,0"]), new Set(["-1,0"])));
    expect(isProgramPlaceholder(meta(nr, "break_block", "chunk_e"))).toBe(true);
    // target not ready
    await expect(breakBlockIx(program, auth, world, [5, 30, 5], viewOf(new Set(["0,0"]), new Set()))).rejects.toBeInstanceOf(
      ChunkNotReadyError,
    );
  });

  it("place_block remaining accounts (x-edge, z-edge, diagonal)", async () => {
    const def = IDL.instructions.find((i) => i.name === "place_block")!;
    const fixed = def.accounts.length;
    // interior block: none
    const a = await placeBlockIx(program, auth, world, [5, 30, 5], 3, viewOf(new Set(["0,0", "1,0"])));
    expect(a.keys).toHaveLength(fixed);
    for (const k of ["chunk_n", "chunk_s", "chunk_e", "chunk_w"]) expect(isProgramPlaceholder(meta(a, "place_block", k))).toBe(true);
    // corner block (lx 15, lz 0) of chunk (0,0): E (1,0) exists, N (0,-1) missing, NE (1,-1) exists
    const ex = viewOf(new Set(["0,0", "1,0", "1,-1"]));
    const b = await placeBlockIx(program, auth, world, [15, 30, 0], 3, ex);
    const rest = b.keys.slice(fixed);
    const e = chunkPda(pid, world, 1, 0);
    const n = chunkPda(pid, world, 0, -1);
    const ne = chunkPda(pid, world, 1, -1);
    expect(rest.map((m) => m.pubkey.toBase58())).toEqual(
      [e, presencePda(pid, e), n, ne, presencePda(pid, ne)].map((k) => k.toBase58()),
    );
    expect(rest.every((m) => !m.isWritable && !m.isSigner)).toBe(true);
    // touched-side neighbors as chunk_n/s/e/w: E is ready, N doesn't exist
    expect(meta(b, "place_block", "chunk_e").pubkey.equals(e)).toBe(true);
    expect(meta(b, "place_block", "chunk_e").isWritable).toBe(true);
    for (const k of ["chunk_n", "chunk_s", "chunk_w"]) expect(isProgramPlaceholder(meta(b, "place_block", k))).toBe(true);
    expect(b.data.readInt32LE(8)).toBe(15);
    expect(b.data[20]).toBe(3);
    // negative coords: x = -16 is lx 0 of chunk -1 → W neighbor (-2, z)
    await expect(placeBlockIx(program, auth, world, [-16, 30, 7], 0, viewOf(new Set()))).rejects.toBeInstanceOf(ChunkNotReadyError);
    const c = await placeBlockIx(program, auth, world, [-16, 30, 7], 0, viewOf(new Set(["-1,0"])));
    expect(c.keys.slice(fixed).map((m) => m.pubkey.toBase58())).toEqual([chunkPda(pid, world, -2, 0).toBase58()]);
  });

  it("craft / attack / eat / select / respawn", async () => {
    const cr = await craftIx(program, auth, world, 5, 1, { table: [17, 30, -1] });
    expect(meta(cr, "craft", "table_chunk").pubkey.equals(chunkPda(pid, world, 1, -1))).toBe(true);
    expect(isProgramPlaceholder(meta(cr, "craft", "furnace_chunk"))).toBe(true);
    const at = await attackMobIx(program, auth, world, 2, -3, 6);
    expect(meta(at, "attack_mob", "chunk").pubkey.equals(chunkPda(pid, world, 2, -3))).toBe(true);
    expect(at.data[8]).toBe(6);
    for (const ix of [
      await eatIx(program, auth, world, 1),
      await selectSlotIx(program, auth, world, 2),
      await respawnIx(program, auth, world),
    ])
      expect(ix.keys.some((m) => m.pubkey.equals(pstatePda(pid, world, player)) && m.isWritable)).toBe(true);
  });

  it("creationChain", () => {
    expect(creationChain(new Set(), "0,0")).toEqual(["0,0"]);
    expect(creationChain(new Set(["0,0"]), "0,0")).toEqual([]);
    expect(creationChain(new Set(["0,0"]), "2,0")).toEqual(["1,0", "2,0"]);
    expect(creationChain(new Set(["0,0", "1,0"]), "1,2")).toEqual(["1,1", "1,2"]);
    expect(() => creationChain(new Set(["0,0"]), "5,0", 2)).toThrow();
  });
});

describe("measureUsPerSlot", () => {
  it("divides the midpoint-to-midpoint time by the slots elapsed", async () => {
    const times = [0, 40, 2_040, 2_080]; // request start / end of both readings
    const slots = [1_000, 1_204];
    const er = { getSlot: async () => slots.shift()! };
    // Midpoints 20 and 2 060: 2 040 ms over 204 slots = 10 000 µs per slot.
    expect(await measureUsPerSlot(er as never, 1, () => times.shift()!)).toBe(10_000);
    const stuck = { getSlot: async () => 7 };
    expect(await measureUsPerSlot(stuck as never, 1)).toBe(0);
    const broken = { getSlot: async () => Promise.reject(new Error("down")) };
    expect(await measureUsPerSlot(broken as never, 1)).toBe(0);
  });
});
