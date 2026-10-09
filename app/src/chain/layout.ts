// Byte-layout decoders for every account the client reads. Offsets are the tables in
// `programs/magicraft/src/state.rs` (module docs) and the magicraft-core layouts (`Mob`,
// `FluidQueue`, `MoveState`, `Inventory`, `WorldParams`). Borsh accounts (Player, World,
// PlayerState) are fixed-size, so they are decoded by offset too (cheaper than the Anchor
// coder on 8 Hz updates; `layout.test.ts` cross-checks them against the coder).
// Inputs are `Uint8Array`s (a `Buffer` is one); block / biome views are subarrays (no copy).
import { PublicKey } from "@solana/web3.js";
import idl from "../idl/magicraft.json";

// ---------------------------------------------------------------- constants

export const FP = 256;
export const CHUNK_W = 16;
export const CHUNK_H = 64;
export const CHUNK_VOL = CHUNK_W * CHUNK_W * CHUNK_H; // 16 384
export const SEA_LEVEL = 28;
/** `physics::GROUND_HALF_W`: half-width of the player's xz footprint, FP. */
export const GROUND_HALF_W = 78;

export const CHUNK_HEADER_SIZE = 768;
export const CHUNK_BLOCKS_OFFSET = CHUNK_HEADER_SIZE;
/** Offset of `ChunkHeader.gen_stage` (u8). */
export const CHUNK_GEN_STAGE_OFFSET = 82;
/** Offset of `ChunkHeader.payer` (Player PDA, 32 B). */
export const CHUNK_PAYER_OFFSET = 8;
export const CHUNK_INITIAL_LEN = 10_240;
export const CHUNK_FULL_LEN = CHUNK_BLOCKS_OFFSET + CHUNK_VOL; // 17 152
export const PRESENCE_HEADER_SIZE = 48;
export const PRESENCE_ENTRY_SIZE = 56;
export const PLAYER_LEN = 105;
export const WORLD_LEN = 265;
export const PSTATE_LEN = 432;
export const MOB_SLOTS = 8;
export const MOB_SIZE = 32;
export const FLUID_QUEUE_SIZE = 134;
export const FLUID_QUEUE_CAP = 64;
export const MOVE_STATE_SIZE = 72;
export const INV_SLOTS = 36;
export const INVENTORY_SIZE = 216;
export const WORLD_PARAMS_SIZE = 48;

export const GEN_CREATED = 0;
export const GEN_STAGE1 = 1;
export const GEN_DONE = 2;

/** `presence::STALE_MS`: entries older than this are ignored by mobs and pruned. */
export const PRESENCE_STALE_MS = 5_000;
/** `CRANK_STALE_MS`: a crank whose `last_tick_ms` is older is re-armed by the watchdogs. */
export const CRANK_STALE_MS = 3_000;
/** `SPONSOR_RESERVE_MARGIN`: lamports a sponsoring Player keeps above rent-exempt. */
export const SPONSOR_RESERVE_MARGIN = 100_000;

/** Ephemeral rent: `(data_len + 60) * 32` lamports. */
export const ephemeralRent = (len: number) => (len + 60) * 32;
/** Rent of one full chunk + its empty presence account (what `create_chunk` costs). */
export const CHUNK_TOTAL_RENT = ephemeralRent(CHUNK_FULL_LEN) + ephemeralRent(PRESENCE_HEADER_SIZE);
/** Rent of one presence entry (a player entering a chunk). */
export const PRESENCE_ENTRY_RENT = PRESENCE_ENTRY_SIZE * 32;

/** Mob kinds (`core::mobs`). */
export const MOB = { EMPTY: 0, PIG: 1, COW: 2, SHEEP: 3, ZOMBIE: 4 } as const;

// ---------------------------------------------------------------- discriminators

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const accDisc = (name: string): Uint8Array => {
  const a = (idl.accounts as { name: string; discriminator: number[] }[]).find((x) => x.name === name);
  if (!a) throw new Error(`IDL has no account ${name}`);
  return Uint8Array.from(a.discriminator);
};

/** `state::CHUNK_DISCRIMINATOR` (`sha256("account:Chunk")[..8]`). */
export const CHUNK_DISCRIMINATOR = Uint8Array.from([0x86, 0x43, 0x50, 0x41, 0x87, 0x8f, 0x9c, 0xc4]);
/** `state::PRESENCE_DISCRIMINATOR` (`sha256("account:ChunkPresence")[..8]`). */
export const PRESENCE_DISCRIMINATOR = Uint8Array.from([0x9b, 0xc2, 0x1d, 0x51, 0xbf, 0xfc, 0x83, 0x6b]);
export const PLAYER_DISCRIMINATOR = accDisc("Player");
export const WORLD_DISCRIMINATOR = accDisc("World");
export const PSTATE_DISCRIMINATOR = accDisc("PlayerState");

export type AccountKind = "chunk" | "presence" | "player" | "world" | "playerState";
const KINDS: [AccountKind, Uint8Array][] = [
  ["chunk", CHUNK_DISCRIMINATOR],
  ["presence", PRESENCE_DISCRIMINATOR],
  ["player", PLAYER_DISCRIMINATOR],
  ["world", WORLD_DISCRIMINATOR],
  ["playerState", PSTATE_DISCRIMINATOR],
];

/** Which magicraft account `data` is, by its 8-byte discriminator (null if unknown). */
export function accountKind(data: Uint8Array): AccountKind | null {
  if (data.length < 8) return null;
  const d = hex(data.subarray(0, 8));
  for (const [k, disc] of KINDS) if (hex(disc) === d) return k;
  return null;
}

function expectKind(data: Uint8Array, kind: AccountKind, minLen: number) {
  if (data.length < minLen) throw new Error(`${kind}: ${data.length} bytes, need ≥ ${minLen}`);
  if (accountKind(data) !== kind) throw new Error(`${kind}: wrong discriminator`);
}

// ---------------------------------------------------------------- reader

/** Little-endian reader over a byte view (no copies except for pubkeys). */
export class Reader {
  readonly dv: DataView;
  constructor(readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u8 = (o: number) => this.dv.getUint8(o);
  u16 = (o: number) => this.dv.getUint16(o, true);
  u32 = (o: number) => this.dv.getUint32(o, true);
  i32 = (o: number) => this.dv.getInt32(o, true);
  i64 = (o: number) => this.dv.getBigInt64(o, true);
  u64 = (o: number) => this.dv.getBigUint64(o, true);
  /** i64 as a JS number (ms timestamps, slots: well within 2^53). */
  n64 = (o: number) => Number(this.dv.getBigInt64(o, true));
  bool = (o: number) => this.dv.getUint8(o) !== 0;
  pubkey = (o: number) => new PublicKey(this.b.subarray(o, o + 32));
  view = (o: number, n: number) => this.b.subarray(o, o + n);
  v3 = (o: number): V3 => [this.i32(o), this.i32(o + 4), this.i32(o + 8)];
}

export type V3 = [number, number, number];

// ---------------------------------------------------------------- WorldParams (48 B)

/** `WorldParams` with the IDL's (camelCase) field names: what `create_world` takes. */
export type WorldParams = {
  walkSpeed: number;
  sprintSpeed: number;
  swimSpeed: number;
  jumpVelocity: number;
  gravity: number;
  maxFallSpeed: number;
  reach: number;
  attackCooldownMs: number;
  dayLengthSecs: number;
  mobTickMs: number;
  fluidTickMs: number;
  fallDamage: number;
  hunger: number;
  zombieCapPerChunk: number;
  pad: number;
};

/** `core::physics::WorldParams::default()`. */
export const DEFAULT_WORLD_PARAMS: Readonly<WorldParams> = Object.freeze({
  walkSpeed: 1101,
  sprintSpeed: 1434,
  swimSpeed: 512,
  jumpVelocity: 2290,
  gravity: 8192,
  maxFallSpeed: 19968,
  reach: 1280,
  attackCooldownMs: 600,
  dayLengthSecs: 1200,
  mobTickMs: 333,
  fluidTickMs: 250,
  fallDamage: 1,
  hunger: 1,
  zombieCapPerChunk: 4,
  pad: 0,
});

/** `core::physics::WorldParams::validate`: the name of the first out-of-range field, or null. */
export function validateWorldParams(p: WorldParams): string | null {
  const SPEED_MIN = FP;
  const SPEED_MAX = 50 * FP;
  const checks: [keyof WorldParams | "jumpHeight", boolean][] = [
    ["walkSpeed", p.walkSpeed >= SPEED_MIN && p.walkSpeed <= SPEED_MAX],
    ["sprintSpeed", p.sprintSpeed >= p.walkSpeed && p.sprintSpeed <= SPEED_MAX],
    ["swimSpeed", p.swimSpeed >= SPEED_MIN && p.swimSpeed <= SPEED_MAX],
    ["jumpVelocity", p.jumpVelocity >= SPEED_MIN && p.jumpVelocity <= SPEED_MAX],
    ["gravity", p.gravity >= FP && p.gravity <= 100 * FP],
    [
      "jumpHeight",
      (p.gravity > 0 ? Math.floor((p.jumpVelocity * p.jumpVelocity) / (2 * p.gravity)) : 0) <= 8 * FP,
    ],
    ["maxFallSpeed", p.maxFallSpeed >= SPEED_MIN && p.maxFallSpeed <= 200 * FP],
    ["reach", p.reach >= FP && p.reach <= 16 * FP],
    ["attackCooldownMs", p.attackCooldownMs >= 0 && p.attackCooldownMs <= 10_000],
    ["dayLengthSecs", p.dayLengthSecs >= 60 && p.dayLengthSecs <= 86_400],
    ["fallDamage", p.fallDamage === 0 || p.fallDamage === 1],
    ["hunger", p.hunger === 0 || p.hunger === 1],
    ["zombieCapPerChunk", p.zombieCapPerChunk >= 0 && p.zombieCapPerChunk <= MOB_SLOTS],
    ["mobTickMs", p.mobTickMs >= 100 && p.mobTickMs <= 60_000],
    ["fluidTickMs", p.fluidTickMs >= 100 && p.fluidTickMs <= 60_000],
    ["pad", p.pad === 0],
  ];
  for (const [k, ok] of checks) if (!ok || (k !== "jumpHeight" && !Number.isInteger(p[k]))) return k;
  return null;
}

export function decodeWorldParams(b: Uint8Array, o = 0): WorldParams {
  const r = new Reader(b);
  return {
    walkSpeed: r.u32(o),
    sprintSpeed: r.u32(o + 4),
    swimSpeed: r.u32(o + 8),
    jumpVelocity: r.u32(o + 12),
    gravity: r.u32(o + 16),
    maxFallSpeed: r.u32(o + 20),
    reach: r.u32(o + 24),
    attackCooldownMs: r.u32(o + 28),
    dayLengthSecs: r.u32(o + 32),
    mobTickMs: r.u32(o + 36),
    fluidTickMs: r.u32(o + 40),
    fallDamage: r.u8(o + 44),
    hunger: r.u8(o + 45),
    zombieCapPerChunk: r.u8(o + 46),
    pad: r.u8(o + 47),
  };
}

// ---------------------------------------------------------------- Player (105 B)

export type PlayerAccount = { authority: PublicKey; bump: number; openChunks: number };

export function decodePlayer(d: Uint8Array): PlayerAccount {
  expectKind(d, "player", PLAYER_LEN);
  const r = new Reader(d);
  return { authority: r.pubkey(8), bump: r.u8(40), openChunks: r.u32(41) };
}

// ---------------------------------------------------------------- World (265 B)

export type TimeAnchor = {
  anchorSlot: number;
  anchorMs: number;
  msPerSlot: number;
  baseMsPerSlot: number;
  syncSlot: number;
  syncMs: number;
};

export type WorldAccount = {
  creator: PublicKey;
  nonce: bigint;
  bump: number;
  /** UTF-8 name, trailing zeros stripped. */
  name: string;
  params: WorldParams;
  /** 32-byte VRF seed (view). */
  seed: Uint8Array;
  seedSet: boolean;
  /** Block coordinates of the spawn feet block. */
  spawn: V3;
  spawnSet: boolean;
  timeOfDayMs: number;
  dayTaskId: bigint;
  lastTickMs: number;
  chunkCount: number;
  clock: TimeAnchor;
  dayTicks: number;
  dayEpoch: number;
};

const utf8 = new TextDecoder();

export function decodeWorld(d: Uint8Array): WorldAccount {
  expectKind(d, "world", WORLD_LEN);
  const r = new Reader(d);
  const name = r.view(49, 32);
  let end = name.length;
  while (end > 0 && name[end - 1] === 0) end--;
  return {
    creator: r.pubkey(8),
    nonce: r.u64(40),
    bump: r.u8(48),
    name: utf8.decode(name.subarray(0, end)),
    params: decodeWorldParams(d, 81),
    seed: r.view(129, 32),
    seedSet: r.bool(161),
    spawn: r.v3(162),
    spawnSet: r.bool(174),
    timeOfDayMs: Number(r.u64(175)),
    dayTaskId: r.i64(183),
    lastTickMs: r.n64(191),
    chunkCount: r.u32(199),
    clock: {
      anchorSlot: Number(r.u64(203)),
      anchorMs: r.n64(211),
      msPerSlot: r.u32(219),
      baseMsPerSlot: r.u32(223),
      syncSlot: Number(r.u64(227)),
      syncMs: r.n64(235),
    },
    dayTicks: r.u32(243),
    dayEpoch: r.u8(247),
  };
}

/** The program's fine chain-time estimate at `slot` (`TimeAnchor::read`):
 *  `anchor_ms + (slot − anchor_slot) · ms_per_slot`; null while the World is not anchored
 *  (`ms_per_slot == 0`). The program falls back to coarse wall time when the anchor is
 *  older than 10 s; callers compare with `Date.now()` if they care. */
export function worldChainMs(w: Pick<WorldAccount, "clock">, slot: number): number | null {
  const c = w.clock;
  if (c.msPerSlot === 0) return null;
  return c.anchorMs + Math.max(0, slot - c.anchorSlot) * c.msPerSlot;
}

/** `physics::LEAD_MS`: how far a move's `client_ms` may run ahead of chain time (fine
 *  clock; 1 000 ms when the chain falls back to coarse wall time). */
export const LEAD_MS = 250;

/** The `client_ms` for the next move: strictly after the last one (`lastMs + minDt`; the
 *  chain also bounds the distance by the elapsed `client_ms`), ideally just behind the
 *  chain-time estimate. Null if that would run more than `LEAD_MS − 50` ahead of the
 *  estimate: wait (one slot) and retry. `lastMs` = `client_ms` of the last confirmed (or
 *  in-flight, if pipelining) move, or `MoveState.last_ms` after join / respawn / snap-back. */
export function nextClientMs(chainMs: number, lastMs: number, minDt = 1): number | null {
  const ms = Math.max(lastMs + minDt, Math.floor(chainMs) - 30);
  return ms <= chainMs + LEAD_MS - 50 ? ms : null;
}

/** The day crank is stale (`World::day_crank_stale`): the client sends `schedule_day_crank`. */
export const dayCrankStale = (w: Pick<WorldAccount, "lastTickMs">, chainMs: number) =>
  chainMs - w.lastTickMs > CRANK_STALE_MS;

// ---------------------------------------------------------------- PlayerState (432 B)

export type MoveState = {
  lastMs: number;
  supportMs: number;
  /** FP feet center. */
  pos: V3;
  /** FP/s as reported. */
  vel: V3;
  fallStartY: number;
  supportY: number;
  onGround: boolean;
  inWater: boolean;
};

export function decodeMoveState(b: Uint8Array, o = 0): MoveState {
  const r = new Reader(b);
  return {
    lastMs: r.n64(o),
    supportMs: r.n64(o + 8),
    pos: r.v3(o + 16),
    vel: r.v3(o + 28),
    fallStartY: r.i32(o + 40),
    supportY: r.i32(o + 44),
    onGround: r.u8(o + 48) === 1,
    inWater: r.u8(o + 49) === 1,
  };
}

export type InvSlot = { item: number; count: number; durability: number };

/** `core::inventory::Inventory` (36 × `Slot { item u16, count u8, _pad, durability u16 }`). */
export function decodeInventory(b: Uint8Array, o = 0): InvSlot[] {
  const r = new Reader(b);
  const out: InvSlot[] = [];
  for (let i = 0; i < INV_SLOTS; i++) {
    const s = o + 6 * i;
    out.push({ item: r.u16(s), count: r.u8(s + 2), durability: r.u16(s + 4) });
  }
  return out;
}

export type PlayerStateAccount = {
  player: PublicKey;
  world: PublicKey;
  bump: number;
  move: MoveState;
  /** 0..=20; 0 ⇔ dead. */
  health: number;
  food: number;
  exhaustion: number;
  inventory: InvSlot[];
  heldSlot: number;
  cx: number;
  cz: number;
  breakUntilMs: number;
  attackUntilMs: number;
  foodTickMs: number;
  respawnMs: number;
};

/** `PlayerState.move_state` offset in the account data (`MoveState`, 72 B). */
export const PSTATE_MOVE_OFFSET = 73;
/** `PlayerState.health` offset (u8; 0 ⇔ dead). */
export const PSTATE_HEALTH_OFFSET = 145;

export function decodePlayerState(d: Uint8Array): PlayerStateAccount {
  expectKind(d, "playerState", PSTATE_LEN);
  const r = new Reader(d);
  return {
    player: r.pubkey(8),
    world: r.pubkey(40),
    bump: r.u8(72),
    move: decodeMoveState(d, PSTATE_MOVE_OFFSET),
    health: r.u8(PSTATE_HEALTH_OFFSET),
    food: r.u8(146),
    exhaustion: r.u16(147),
    inventory: decodeInventory(d, 149),
    heldSlot: r.u8(365),
    cx: r.i32(366),
    cz: r.i32(370),
    breakUntilMs: r.n64(374),
    attackUntilMs: r.n64(382),
    foodTickMs: r.n64(390),
    respawnMs: r.n64(398),
  };
}

// ---------------------------------------------------------------- Chunk

export type Mob = {
  kind: number;
  hp: number;
  flags: number;
  dir: number;
  /** World FP feet position. */
  pos: V3;
  id: number;
  cooldownMs: number;
  burnMs: number;
  lastTick: number;
  aloneMs: number;
};

/** `core::mobs::Mob` (32 B) at offset `o`. */
export function decodeMob(b: Uint8Array, o = 0): Mob {
  const r = new Reader(b);
  return {
    kind: r.u8(o),
    hp: r.u8(o + 1),
    flags: r.u8(o + 2),
    dir: r.u8(o + 3),
    pos: r.v3(o + 4),
    id: r.u32(o + 16),
    cooldownMs: r.u16(o + 20),
    burnMs: r.u16(o + 22),
    lastTick: r.u8(o + 24),
    aloneMs: r.u16(o + 26),
  };
}

export type FluidQueue = {
  /** Raw ring storage (local block indices). */
  buf: number[];
  rescanCursor: number;
  head: number;
  /** Entries pending (raw values > 64 read as 64). */
  len: number;
  /** 0 clean, 1 rescan pass running, 2 dirty. */
  overflow: number;
  highWater: number;
  /** Pending local block indices, oldest first. */
  entries: number[];
};

/** `core::fluid::FluidQueue` (134 B) at offset `o`. */
export function decodeFluidQueue(b: Uint8Array, o = 0): FluidQueue {
  const r = new Reader(b);
  const buf: number[] = [];
  for (let i = 0; i < FLUID_QUEUE_CAP; i++) buf.push(r.u16(o + 2 * i));
  const head = r.u8(o + 130);
  const len = Math.min(r.u8(o + 131), FLUID_QUEUE_CAP);
  const entries: number[] = [];
  for (let i = 0; i < len; i++) entries.push(buf[(head + i) & 63]);
  return {
    buf,
    rescanCursor: r.u16(o + 128),
    head,
    len,
    overflow: r.u8(o + 132),
    highWater: r.u8(o + 133),
    entries,
  };
}

export type ChunkHeader = {
  payer: PublicKey;
  world: PublicKey;
  cx: number;
  cz: number;
  bump: number;
  edited: boolean;
  genStage: number;
  crankArmed: boolean;
  taskId: bigint;
  lastTickMs: number;
  tickCount: number;
  /** 256 biome bytes, index `lz * 16 + lx` (view). */
  biomes: Uint8Array;
  mobs: Mob[];
  fluid: FluidQueue;
  presenceBump: number;
  /** Bumps of the N, S, E, W chunk PDAs, then of their presence PDAs (view). */
  nbrBumps: Uint8Array;
  armTick: number;
  /** Bit i set ⇔ neighbor i (N, S, E, W) exists. */
  nbrMask: number;
  taskEpoch: number;
  repairS: number;
};

/** Decodes the 768-byte `ChunkHeader` (valid at any gen stage / data length ≥ 768). */
export function decodeChunkHeader(d: Uint8Array): ChunkHeader {
  expectKind(d, "chunk", CHUNK_HEADER_SIZE);
  const r = new Reader(d);
  const mobs: Mob[] = [];
  for (let i = 0; i < MOB_SLOTS; i++) mobs.push(decodeMob(d, 364 + MOB_SIZE * i));
  return {
    payer: r.pubkey(8),
    world: r.pubkey(40),
    cx: r.i32(72),
    cz: r.i32(76),
    bump: r.u8(80),
    edited: r.bool(81),
    genStage: r.u8(CHUNK_GEN_STAGE_OFFSET),
    crankArmed: r.bool(83),
    taskId: r.i64(84),
    lastTickMs: r.n64(92),
    tickCount: Number(r.u64(100)),
    biomes: r.view(108, 256),
    mobs,
    fluid: decodeFluidQueue(d, 620),
    presenceBump: r.u8(754),
    nbrBumps: r.view(755, 8),
    armTick: r.u8(763),
    nbrMask: r.u8(764),
    taskEpoch: r.u8(765),
    repairS: r.u16(766),
  };
}

/** A chunk is playable: full size and `gen_stage == DONE` (else ixs reject it). */
export const chunkReady = (d: Uint8Array) =>
  d.length === CHUNK_FULL_LEN && d[CHUNK_GEN_STAGE_OFFSET] === GEN_DONE && accountKind(d) === "chunk";

/** The 16 384 block bytes of a full chunk (a view into `d`, no copy); index
 *  `y * 256 + lz * 16 + lx` ([`blockIndex`]). Null while the chunk is not full size. */
export function chunkBlocks(d: Uint8Array): Uint8Array | null {
  if (d.length !== CHUNK_FULL_LEN) return null;
  return d.subarray(CHUNK_BLOCKS_OFFSET, CHUNK_FULL_LEN);
}

/** Local block index `y * 256 + lz * 16 + lx`. */
export const blockIndex = (lx: number, y: number, lz: number) => y * 256 + lz * 16 + lx;
/** Inverse of [`blockIndex`]: `[lx, y, lz]`. */
export const blockOfIndex = (i: number): V3 => [i & 15, i >> 8, (i >> 4) & 15];

/** Live (non-empty) mobs with their slot index. */
export const liveMobs = (h: Pick<ChunkHeader, "mobs">) =>
  h.mobs.flatMap((m, idx) => (m.kind !== MOB.EMPTY ? [{ ...m, idx }] : []));

// ---------------------------------------------------------------- ChunkPresence

export type PresenceEntry = {
  /** Player PDA. */
  player: PublicKey;
  /** FP feet position. */
  pos: V3;
  lastSeenMs: number;
  pendingDamage: number;
};

export type PresenceAccount = {
  chunk: PublicKey;
  bump: number;
  count: number;
  entries: PresenceEntry[];
};

export function decodePresence(d: Uint8Array): PresenceAccount {
  expectKind(d, "presence", PRESENCE_HEADER_SIZE);
  const r = new Reader(d);
  const count = r.u16(42);
  const n = Math.min(count, Math.floor((d.length - PRESENCE_HEADER_SIZE) / PRESENCE_ENTRY_SIZE));
  const entries: PresenceEntry[] = [];
  for (let i = 0; i < n; i++) {
    const o = PRESENCE_HEADER_SIZE + PRESENCE_ENTRY_SIZE * i;
    entries.push({
      player: r.pubkey(o),
      pos: r.v3(o + 32),
      lastSeenMs: r.n64(o + 44),
      pendingDamage: r.u8(o + 52),
    });
  }
  return { chunk: r.pubkey(8), bump: r.u8(40), count, entries };
}

/** Entries seen within `PRESENCE_STALE_MS` of `nowMs` (chain ms). */
export const freshEntries = (p: PresenceAccount, nowMs: number) =>
  p.entries.filter((e) => nowMs - e.lastSeenMs <= PRESENCE_STALE_MS);

// ---------------------------------------------------------------- coordinates

/** Chunk coordinate of an FP position component. */
export const chunkOfFp = (v: number) => Math.floor(v / (CHUNK_W * FP));
/** Chunk coordinate of a world block coordinate. */
export const chunkOfBlock = (v: number) => Math.floor(v / CHUNK_W);
/** Local (0..15) coordinate of a world block coordinate. */
export const localOfBlock = (v: number) => v - Math.floor(v / CHUNK_W) * CHUNK_W;
