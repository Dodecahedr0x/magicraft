import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  accountKind,
  blockIndex,
  blockOfIndex,
  CHUNK_BLOCKS_END,
  CHUNK_BLOCKS_OFFSET,
  CHUNK_DISCRIMINATOR,
  CHUNK_GROUND_OFFSET,
  CHUNK_FULL_LEN,
  CHUNK_INITIAL_LEN,
  CHUNK_TOTAL_RENT,
  CHUNK_VOL,
  chunkBlocks,
  chunkReady,
  decodeChunkHeader,
  decodeFluidQueue,
  decodeGroundItems,
  decodePlayer,
  decodePlayerState,
  decodePresence,
  decodeWorld,
  DEFAULT_WORLD_PARAMS,
  freshEntries,
  GEN_DONE,
  inPickupReach,
  liveMobs,
  PRESENCE_DISCRIMINATOR,
  PSTATE_LEN,
  validateWorldParams,
  WORLD_LEN,
  worldChainMs,
} from "./layout";
import { Connection } from "@solana/web3.js";
import { loadConfig } from "./config";
import { makeProgram } from "./program";

const coder = makeProgram(loadConfig(), new Connection("http://127.0.0.1:1")).coder;

/** Little-endian writer for hand-built fixtures. */
class W {
  dv: DataView;
  constructor(readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u8 = (o: number, v: number) => this.dv.setUint8(o, v);
  u16 = (o: number, v: number) => this.dv.setUint16(o, v, true);
  u32 = (o: number, v: number) => this.dv.setUint32(o, v, true);
  i32 = (o: number, v: number) => this.dv.setInt32(o, v, true);
  i64 = (o: number, v: bigint) => this.dv.setBigInt64(o, v, true);
  u64 = (o: number, v: bigint) => this.dv.setBigUint64(o, v, true);
  key = (o: number, k: PublicKey) => this.b.set(k.toBytes(), o);
  bytes = (o: number, v: ArrayLike<number>) => this.b.set(v, o);
}

const anchorDisc = (name: string) =>
  [...createHash("sha256").update(`account:${name}`).digest().subarray(0, 8)];

/** Reference generator output (`crates/core/examples/gen.rs`, `pnpm fixtures`). */
function loadGen() {
  const out = readFileSync(new URL("./__fixtures__/gen_0_0.bin", import.meta.url));
  let o = 0;
  const take = (n: number) => out.subarray(o, (o += n));
  const stage1 = take(CHUNK_VOL);
  const biomes = take(256);
  const blocks = take(CHUNK_VOL);
  const n = take(1)[0];
  const spawns: { kind: number; x: number; y: number; z: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const [kind, x, y, z] = take(4);
    if (i < n) spawns.push({ kind, x, y, z });
  }
  const spawn = [...take(3)];
  expect(o).toBe(out.length);
  return { stage1, biomes, blocks, spawns, spawn };
}

const payer = Keypair.generate().publicKey;
const world = Keypair.generate().publicKey;

/** A full-size chunk account with every header field set to a distinct value at its
 *  `state.rs` offset. */
function handBuiltChunk() {
  const d = new Uint8Array(CHUNK_FULL_LEN);
  const w = new W(d);
  w.bytes(0, CHUNK_DISCRIMINATOR);
  w.key(8, payer); // payer
  w.key(40, world); // world
  w.i32(72, -3); // cx
  w.i32(76, 7); // cz
  w.u8(80, 251); // bump
  w.u8(81, 1); // edited
  w.u8(82, GEN_DONE); // gen_stage
  w.u8(83, 1); // crank_armed
  w.i64(84, 0x1234_5678_9abc_def0n); // task_id
  w.i64(92, 1_760_000_000_123n); // last_tick_ms
  w.u64(100, 4242n); // tick_count
  for (let i = 0; i < 256; i++) d[108 + i] = i % 5; // biomes
  // mobs @364: slot 2 = zombie, slot 5 = pig
  const mob = (i: number, kind: number, hp: number, pos: [number, number, number], id: number) => {
    const o = 364 + 32 * i;
    w.u8(o, kind);
    w.u8(o + 1, hp);
    w.u8(o + 2, 3); // flags
    w.u8(o + 3, 6); // dir
    w.i32(o + 4, pos[0]);
    w.i32(o + 8, pos[1]);
    w.i32(o + 12, pos[2]);
    w.u32(o + 16, id);
    w.u16(o + 20, 900); // cooldown_ms
    w.u16(o + 22, 77); // burn_ms
    w.u8(o + 24, 13); // last_tick
    w.u16(o + 26, 15_000); // alone_ms
  };
  mob(2, 4, 20, [-3 * 4096 + 100, 30 * 256, 7 * 4096 + 5], 0xdeadbeef);
  mob(5, 1, 10, [-3 * 4096 + 2000, 40 * 256, 7 * 4096 + 900], 7);
  // fluid @620: ring wraps (head 62, len 4), rescan_cursor, overflow, high_water
  w.u16(620 + 2 * 62, 100);
  w.u16(620 + 2 * 63, 101);
  w.u16(620 + 2 * 0, 102);
  w.u16(620 + 2 * 1, 103);
  w.u16(620 + 128, 999); // rescan_cursor
  w.u8(620 + 130, 62); // head
  w.u8(620 + 131, 4); // len
  w.u8(620 + 132, 1); // overflow
  w.u8(620 + 133, 9); // high_water
  w.u8(754, 254); // presence_bump
  w.bytes(755, [1, 2, 3, 4, 5, 6, 7, 8]); // nbr_bumps
  w.u8(763, 99); // arm_tick
  w.u8(764, 0b1011); // nbr_mask
  w.u8(765, 3); // task_epoch
  w.u16(766, 65_000); // repair_s
  return d;
}

describe("discriminators", () => {
  it("match state.rs constants and the Anchor rule", () => {
    expect([...CHUNK_DISCRIMINATOR]).toEqual(anchorDisc("Chunk"));
    expect([...PRESENCE_DISCRIMINATOR]).toEqual(anchorDisc("ChunkPresence"));
  });
  it("classifies accounts", () => {
    expect(accountKind(handBuiltChunk())).toBe("chunk");
    expect(accountKind(Uint8Array.from(anchorDisc("World")))).toBe("world");
    expect(accountKind(Uint8Array.from(anchorDisc("PlayerState")))).toBe("playerState");
    expect(accountKind(Uint8Array.from(anchorDisc("Player")))).toBe("player");
    expect(accountKind(new Uint8Array(8))).toBeNull();
  });
});

describe("ChunkHeader", () => {
  it("decodes every field at the state.rs offsets", () => {
    const h = decodeChunkHeader(handBuiltChunk());
    expect(h.payer.equals(payer)).toBe(true);
    expect(h.world.equals(world)).toBe(true);
    expect([h.cx, h.cz, h.bump, h.edited, h.genStage, h.crankArmed]).toEqual([-3, 7, 251, true, GEN_DONE, true]);
    expect(h.taskId).toBe(0x1234_5678_9abc_def0n);
    expect(h.lastTickMs).toBe(1_760_000_000_123);
    expect(h.tickCount).toBe(4242);
    expect(h.biomes.length).toBe(256);
    expect(h.biomes[7]).toBe(2);
    expect(h.mobs).toHaveLength(8);
    expect(h.mobs[2]).toEqual({
      kind: 4,
      hp: 20,
      flags: 3,
      dir: 6,
      pos: [-3 * 4096 + 100, 30 * 256, 7 * 4096 + 5],
      id: 0xdeadbeef,
      cooldownMs: 900,
      burnMs: 77,
      lastTick: 13,
      aloneMs: 15_000,
    });
    expect(liveMobs(h).map((m) => [m.idx, m.kind])).toEqual([
      [2, 4],
      [5, 1],
    ]);
    expect(h.fluid).toMatchObject({ rescanCursor: 999, head: 62, len: 4, overflow: 1, highWater: 9 });
    expect(h.fluid.entries).toEqual([100, 101, 102, 103]);
    expect([h.presenceBump, h.armTick, h.nbrMask, h.taskEpoch, h.repairS]).toEqual([254, 99, 0b1011, 3, 65_000]);
    expect([...h.nbrBumps]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("decodes a 10 240-byte (stage 0) chunk header and reports it not ready", () => {
    const full = handBuiltChunk();
    const d = new Uint8Array(CHUNK_INITIAL_LEN);
    d.set(full.subarray(0, CHUNK_BLOCKS_OFFSET));
    d[82] = 0;
    expect(decodeChunkHeader(d).genStage).toBe(0);
    expect(chunkReady(d)).toBe(false);
    expect(chunkBlocks(d)).toBeNull();
    expect(chunkReady(full)).toBe(true);
  });

  it("rejects wrong discriminators / short data", () => {
    const d = handBuiltChunk();
    d[0] ^= 1;
    expect(() => decodeChunkHeader(d)).toThrow(/discriminator/);
    expect(() => decodeChunkHeader(new Uint8Array(100))).toThrow();
  });

  it("fluid len > 64 reads as 64", () => {
    const b = new Uint8Array(134);
    b[131] = 200;
    expect(decodeFluidQueue(b).len).toBe(64);
  });

  it("rent of a chunk + empty presence", () => {
    expect(CHUNK_TOTAL_RENT).toBe((17_536 + 60) * 32 + (48 + 60) * 32);
  });
});

describe("ground items (core::ground, after the blocks)", () => {
  /** Writes slot `i`: item u16 @0, count @2, pos [i32; 3] @4, expires_ms i64 @16. */
  const put = (d: Uint8Array, i: number, item: number, count: number, pos: [number, number, number], exp: bigint) => {
    const w = new W(d);
    const o = CHUNK_GROUND_OFFSET + 24 * i;
    w.u16(o, item);
    w.u8(o + 2, count);
    pos.forEach((v, k) => w.i32(o + 4 + 4 * k, v));
    w.i64(o + 16, exp);
  };

  it("decodes live slots; skips empty and expired ones; none on a legacy chunk", () => {
    expect(CHUNK_GROUND_OFFSET).toBe(17_152);
    expect(CHUNK_FULL_LEN).toBe(17_536);
    const d = handBuiltChunk();
    put(d, 0, 4, 1, [-640, 10_304, 128], 5_000n);
    put(d, 3, 263, 2, [1, 2, 3], 9_000n);
    put(d, 4, 2, 0, [1, 2, 3], 9_000n); // count 0: empty
    expect(decodeGroundItems(d, 4_999)).toEqual([
      { idx: 0, item: 4, count: 1, pos: [-640, 10_304, 128], expiresMs: 5_000 },
      { idx: 3, item: 263, count: 2, pos: [1, 2, 3], expiresMs: 9_000 },
    ]);
    expect(decodeGroundItems(d, 5_000).map((g) => g.idx)).toEqual([3]);
    // A chunk grown before ground items existed: playable, no ground region.
    const legacy = d.slice(0, CHUNK_BLOCKS_END);
    expect(chunkReady(legacy)).toBe(true);
    expect(chunkBlocks(legacy)!.length).toBe(CHUNK_VOL);
    expect(decodeGroundItems(legacy, 0)).toEqual([]);
  });

  it("pickup reach: 2 blocks from the body center (0.9 above the feet)", () => {
    const feet: [number, number, number] = [0, 0, 0];
    expect(inPickupReach(feet, [0, 230, 512])).toBe(true);
    expect(inPickupReach(feet, [0, 230, 513])).toBe(false);
    expect(inPickupReach(feet, [290, 230 - 290, 290])).toBe(true);
    expect(inPickupReach(feet, [0, 230 + 513, 0])).toBe(false);
  });
});

describe("blocks from the magicraft-core reference generator", () => {
  const gen = loadGen();
  const d = handBuiltChunk();
  d.set(gen.biomes, 108);
  d.set(gen.blocks, CHUNK_BLOCKS_OFFSET);

  it("blocks are a zero-copy view equal to gen.rs output", () => {
    const blocks = chunkBlocks(d)!;
    expect(blocks.buffer).toBe(d.buffer);
    expect(blocks.byteOffset).toBe(CHUNK_BLOCKS_OFFSET);
    expect(blocks.length).toBe(CHUNK_VOL);
    expect(Buffer.from(blocks).equals(Buffer.from(gen.blocks))).toBe(true);
    d[CHUNK_BLOCKS_OFFSET + 5] = 123; // views see writes
    expect(blocks[5]).toBe(123);
    d[CHUNK_BLOCKS_OFFSET + 5] = gen.blocks[5];
    expect(Buffer.from(decodeChunkHeader(d).biomes).equals(Buffer.from(gen.biomes))).toBe(true);
  });

  it("bedrock floor, spawn point above solid ground, index helpers", () => {
    const blocks = chunkBlocks(d)!;
    for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) expect(blocks[blockIndex(lx, 0, lz)]).toBe(8);
    const [sx, sy, sz] = gen.spawn;
    expect(blocks[blockIndex(sx, sy, sz)]).toBe(0); // feet block is air
    expect(blocks[blockIndex(sx, sy - 1, sz)]).not.toBe(0); // standing on something
    expect(blockOfIndex(blockIndex(3, 45, 11))).toEqual([3, 45, 11]);
    // stage 2 only adds detail on top of stage 1 (some bytes differ)
    expect(Buffer.from(gen.stage1).equals(Buffer.from(gen.blocks))).toBe(false);
  });
});

describe("ChunkPresence", () => {
  it("decodes header and entries (count bounded by data length)", () => {
    const n = 2;
    const d = new Uint8Array(48 + 56 * n);
    const w = new W(d);
    const chunk = Keypair.generate().publicKey;
    const p0 = Keypair.generate().publicKey;
    const p1 = Keypair.generate().publicKey;
    w.bytes(0, PRESENCE_DISCRIMINATOR);
    w.key(8, chunk);
    w.u8(40, 200);
    w.u16(42, 3); // claims 3, only 2 fit
    w.key(48, p0);
    w.i32(48 + 32, -100);
    w.i32(48 + 36, 7000);
    w.i32(48 + 40, 123);
    w.i64(48 + 44, 10_000n);
    w.u8(48 + 52, 5);
    w.key(104, p1);
    w.i64(104 + 44, 3_000n);
    const p = decodePresence(d);
    expect(p.chunk.equals(chunk)).toBe(true);
    expect(p.bump).toBe(200);
    expect(p.count).toBe(3);
    expect(p.entries).toHaveLength(2);
    expect(p.entries[0]).toMatchObject({ pos: [-100, 7000, 123], lastSeenMs: 10_000, pendingDamage: 5 });
    expect(p.entries[0].player.equals(p0)).toBe(true);
    expect(p.entries[1].player.equals(p1)).toBe(true);
    expect(freshEntries(p, 12_000).map((e) => e.player.toBase58())).toEqual([p0.toBase58()]);
  });
});

describe("Borsh accounts (cross-checked with the Anchor coder)", () => {
  it("World", async () => {
    const creator = Keypair.generate().publicKey;
    const name = new Uint8Array(32);
    name.set(new TextEncoder().encode("hello"));
    const params = { ...DEFAULT_WORLD_PARAMS, dayLengthSecs: 90, zombieCapPerChunk: 2 };
    const seed = Array.from({ length: 32 }, (_, i) => i + 1);
    const data = await coder.accounts.encode("world", {
      creator,
      nonce: new BN("123456789012"),
      bump: 253,
      name: [...name],
      params,
      seed,
      seedSet: true,
      spawn: [8, 41, -8],
      spawnSet: true,
      timeOfDayMs: new BN(54_321),
      dayTaskId: new BN("987654321987"),
      lastTickMs: new BN("1760000000999"),
      chunkCount: 17,
      clock: {
        anchorSlot: new BN(1000),
        anchorMs: new BN("1760000000000"),
        usPerSlot: 9_750,
        baseUsPerSlot: 9_800,
        syncSlot: new BN(900),
        syncMs: new BN("1759999995000"),
      },
      dayTicks: 77,
      dayEpoch: 2,
      firstJoinMs: new BN("1760000001234"),
      playersOnline: 7,
      entries: 4000000000,
      reserved: [0],
    });
    expect(data.length).toBe(WORLD_LEN);
    const w = decodeWorld(data);
    expect(w.creator.equals(creator)).toBe(true);
    expect(w.nonce).toBe(123456789012n);
    expect(w.bump).toBe(253);
    expect(w.name).toBe("hello");
    expect(w.params).toEqual(params);
    expect([...w.seed]).toEqual(seed);
    expect([w.seedSet, w.spawnSet]).toEqual([true, true]);
    expect(w.spawn).toEqual([8, 41, -8]);
    expect(w.timeOfDayMs).toBe(54_321);
    expect(w.dayTaskId).toBe(987654321987n);
    expect(w.lastTickMs).toBe(1760000000999);
    expect(w.chunkCount).toBe(17);
    expect(w.clock).toEqual({
      anchorSlot: 1000,
      anchorMs: 1760000000000,
      usPerSlot: 9_750,
      baseUsPerSlot: 9_800,
      syncSlot: 900,
      syncMs: 1759999995000,
    });
    expect([w.dayTicks, w.dayEpoch, w.firstJoinMs]).toEqual([77, 2, 1760000001234]);
    expect([w.playersOnline, w.entries]).toEqual([7, 4000000000]);
    expect(worldChainMs(w, 1010)).toBe(1760000000097); // ⌊10 · 9 750 / 1 000⌋
    expect(worldChainMs({ clock: { ...w.clock, usPerSlot: 0 } }, 1010)).toBeNull();
  });

  it("PlayerState (+ MoveState, Inventory)", async () => {
    const player = Keypair.generate().publicKey;
    const wld = Keypair.generate().publicKey;
    const ms = new Uint8Array(72);
    const mw = new W(ms);
    mw.i64(0, 1_760_000_000_500n);
    mw.i64(8, 1_760_000_000_400n);
    [100, 7000, -300].forEach((v, i) => mw.i32(16 + 4 * i, v));
    [-5, 6, 7].forEach((v, i) => mw.i32(28 + 4 * i, v));
    mw.i32(40, 8000);
    mw.i32(44, 6912);
    mw.u8(48, 1);
    mw.u8(49, 0);
    const inv = new Uint8Array(216);
    const iw = new W(inv);
    iw.u16(0, 256); // wooden pickaxe
    iw.u8(2, 1);
    iw.u16(4, 59);
    iw.u16(6 * 35, 9); // last slot: logs
    iw.u8(6 * 35 + 2, 64);
    const data = await coder.accounts.encode("playerState", {
      player,
      world: wld,
      bump: 250,
      moveState: [...ms],
      health: 17,
      food: 12,
      exhaustion: 3000,
      inventory: [...inv],
      heldSlot: 4,
      cx: -2,
      cz: 5,
      breakUntilMs: new BN("1760000000600"),
      attackUntilMs: new BN("1760000000700"),
      foodTickMs: new BN("1760000000800"),
      respawnMs: new BN("1760000000900"),
      inWorld: 1,
      reserved: new Array(25).fill(0),
    });
    expect(data.length).toBe(PSTATE_LEN);
    const s = decodePlayerState(data);
    expect(s.player.equals(player) && s.world.equals(wld)).toBe(true);
    expect(s.bump).toBe(250);
    expect(s.move).toEqual({
      lastMs: 1_760_000_000_500,
      supportMs: 1_760_000_000_400,
      pos: [100, 7000, -300],
      vel: [-5, 6, 7],
      fallStartY: 8000,
      supportY: 6912,
      onGround: true,
      inWater: false,
    });
    expect([s.health, s.food, s.exhaustion, s.heldSlot, s.cx, s.cz]).toEqual([17, 12, 3000, 4, -2, 5]);
    expect(s.inventory).toHaveLength(36);
    expect(s.inventory[0]).toEqual({ item: 256, count: 1, durability: 59 });
    expect(s.inventory[35]).toEqual({ item: 9, count: 64, durability: 0 });
    expect([s.breakUntilMs, s.attackUntilMs, s.foodTickMs, s.respawnMs]).toEqual([
      1760000000600, 1760000000700, 1760000000800, 1760000000900,
    ]);
    expect(s.inWorld).toBe(true);
  });

  it("Player", async () => {
    const authority = Keypair.generate().publicKey;
    const data = await coder.accounts.encode("player", {
      authority,
      bump: 249,
      openChunks: 70_000,
      reserved: new Array(60).fill(0),
    });
    expect(data.length).toBe(105);
    const p = decodePlayer(data);
    expect(p.authority.equals(authority)).toBe(true);
    expect([p.bump, p.openChunks]).toEqual([249, 70_000]);
  });
});

describe("WorldParams validation (core::physics::WorldParams::validate)", () => {
  it("accepts defaults, rejects out-of-range fields", () => {
    expect(validateWorldParams({ ...DEFAULT_WORLD_PARAMS })).toBeNull();
    expect(validateWorldParams({ ...DEFAULT_WORLD_PARAMS, dayLengthSecs: 59 })).toBe("dayLengthSecs");
    expect(validateWorldParams({ ...DEFAULT_WORLD_PARAMS, sprintSpeed: 1000 })).toBe("sprintSpeed");
    expect(validateWorldParams({ ...DEFAULT_WORLD_PARAMS, zombieCapPerChunk: 9 })).toBe("zombieCapPerChunk");
    expect(validateWorldParams({ ...DEFAULT_WORLD_PARAMS, jumpVelocity: 12_800, gravity: 256 })).toBe("jumpHeight");
    expect(validateWorldParams({ ...DEFAULT_WORLD_PARAMS, pad: 1 })).toBe("pad");
    expect(validateWorldParams({ ...DEFAULT_WORLD_PARAMS, reach: 1.5 })).toBe("reach");
  });
});
