// Playing helpers: PlayerState PDA/decoding, join_world / move_player builders,
// the chain-time estimate (`World.clock`), presence decoding and a tiny path
// planner over magicraft-core reference blocks (for walking tests).
import { BN, web3 } from "@anchor-lang/core";
import { erConn, erProgram } from "./env";
import { TestPlayer } from "./player";
import { chunkPda, presencePda } from "./chunk";
import { fetchWorld, programId } from "./world";

export const FP = 256;
export const PSTATE_LEN = 432;
export const PRESENCE_HEADER = 48;
export const PRESENCE_ENTRY = 56;
/** Rent of one presence entry (56 × 32). */
export const ENTRY_RENT = PRESENCE_ENTRY * 32;
/** presence::STALE_MS */
export const STALE_MS = 5_000;

export function pstatePda(
  world: web3.PublicKey,
  player: web3.PublicKey
): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("pstate"), world.toBuffer(), player.toBuffer()],
    programId
  )[0];
}

export type MoveState = {
  lastMs: number;
  supportMs: number;
  pos: [number, number, number];
  vel: [number, number, number];
  fallStartY: number;
  supportY: number;
  onGround: boolean;
  inWater: boolean;
};

export function decodeMoveState(b: Buffer): MoveState {
  return {
    lastMs: Number(b.readBigInt64LE(0)),
    supportMs: Number(b.readBigInt64LE(8)),
    pos: [b.readInt32LE(16), b.readInt32LE(20), b.readInt32LE(24)],
    vel: [b.readInt32LE(28), b.readInt32LE(32), b.readInt32LE(36)],
    fallStartY: b.readInt32LE(40),
    supportY: b.readInt32LE(44),
    onGround: b[48] === 1,
    inWater: b[49] === 1,
  };
}

export async function fetchPlayerState(pstate: web3.PublicKey) {
  const info = await erConn.getAccountInfo(pstate, "confirmed");
  if (!info) return null;
  const acc = erProgram.coder.accounts.decode("playerState", info.data);
  return {
    info,
    acc,
    move: decodeMoveState(Buffer.from(acc.moveState as number[])),
  };
}

export type Presence = {
  len: number;
  count: number;
  entries: {
    player: web3.PublicKey;
    pos: [number, number, number];
    lastSeenMs: number;
    pendingDamage: number;
  }[];
};

export async function fetchPresence(
  presence: web3.PublicKey
): Promise<Presence> {
  const info = await erConn.getAccountInfo(presence, "confirmed");
  const d = info!.data;
  const count = d.readUInt16LE(42);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = PRESENCE_HEADER + i * PRESENCE_ENTRY;
    entries.push({
      player: new web3.PublicKey(d.subarray(o, o + 32)),
      pos: [
        d.readInt32LE(o + 32),
        d.readInt32LE(o + 36),
        d.readInt32LE(o + 40),
      ] as [number, number, number],
      lastSeenMs: Number(d.readBigInt64LE(o + 44)),
      pendingDamage: d[o + 52],
    });
  }
  return { len: d.length, count, entries };
}

export const hasEntry = (p: Presence, player: web3.PublicKey) =>
  p.entries.some((e) => e.player.equals(player));

export async function erLamports(pk: web3.PublicKey): Promise<number> {
  return (await erConn.getAccountInfo(pk, "confirmed"))?.lamports ?? 0;
}

/** The program's chain-time estimate (`TimeAnchor::read`, fine path):
 *  `anchor_ms + (slot − anchor_slot) · ms_per_slot`. */
export async function chainMs(world: web3.PublicKey): Promise<number> {
  const [w, slot] = await Promise.all([
    fetchWorld(world),
    erConn.getSlot("processed"),
  ]);
  const c = w!.acc.clock;
  const anchorSlot = (c.anchorSlot as BN).toNumber();
  const anchorMs = (c.anchorMs as BN).toNumber();
  return anchorMs + Math.max(0, slot - anchorSlot) * c.msPerSlot;
}

/** Waits until a client timestamp ≥ `lastMs + minDt` is within the chain's
 *  bounds, and returns it (slightly behind the estimate, never ahead). */
export async function nextClientMs(
  world: web3.PublicKey,
  lastMs: number,
  minDt = 160
): Promise<number> {
  for (;;) {
    const c = (await chainMs(world)) - 30;
    if (c - lastMs >= minDt) return c;
    await new Promise((r) =>
      setTimeout(r, Math.min(100, minDt - (c - lastMs)))
    );
  }
}

/** Chunk of an FP coordinate. */
export const chunkOf = (v: number) => Math.floor(v / 4096);

/** physics::move_window: origin of the 2×2 chunk window covering a → b. */
export function moveWindow(a: number[], b: number[]): [number, number] | null {
  const span = (u: number, v: number) => {
    const lo = Math.min(u, v) - 78;
    const hi = Math.max(u, v) + 78 - 1;
    const c0 = Math.floor(lo / 4096);
    const c1 = Math.floor(hi / 4096);
    return c1 - c0 > 1 ? null : c0;
  };
  const x = span(a[0], b[0]);
  const z = span(a[2], b[2]);
  return x === null || z === null ? null : [x, z];
}

export async function joinWorldIx(
  p: TestPlayer,
  world: web3.PublicKey,
  o: { signer?: web3.PublicKey; sessionToken?: web3.PublicKey | null } = {}
) {
  return p.er.methods
    .joinWorld()
    .accountsPartial({
      signer: o.signer ?? p.authority.publicKey,
      player: p.player,
      sessionToken: o.sessionToken ?? null,
      world,
      playerState: pstatePda(world, p.player),
    })
    .instruction();
}

/** move_player with the window chunks derived from `prev → pos`: a chunk is
 *  passed if `(cx, cz)` is in `existing` (keys "cx,cz"). */
export async function moveIx(
  p: TestPlayer,
  world: web3.PublicKey,
  o: {
    prev: number[];
    pos: number[];
    vel?: number[];
    onGround: boolean;
    clientMs: number;
    existing: Set<string>;
    signer?: web3.PublicKey;
    sessionToken?: web3.PublicKey | null;
    /** Overrides of the derived presence accounts. */
    presence?: web3.PublicKey;
    oldPresence?: web3.PublicKey | null;
  }
) {
  const [cx0, cz0] = moveWindow(o.prev, o.pos) ?? [
    chunkOf(o.prev[0]),
    chunkOf(o.prev[2]),
  ];
  const slot = (dx: number, dz: number) =>
    o.existing.has(`${cx0 + dx},${cz0 + dz}`)
      ? chunkPda(world, cx0 + dx, cz0 + dz)
      : null;
  const [ncx, ncz] = [chunkOf(o.pos[0]), chunkOf(o.pos[2])];
  const [ocx, ocz] = [chunkOf(o.prev[0]), chunkOf(o.prev[2])];
  const crossed = ncx !== ocx || ncz !== ocz;
  return p.er.methods
    .movePlayer(
      o.pos as [number, number, number],
      (o.vel ?? [0, 0, 0]) as [number, number, number],
      o.onGround,
      new BN(o.clientMs)
    )
    .accountsPartial({
      signer: o.signer ?? p.authority.publicKey,
      player: p.player,
      sessionToken: o.sessionToken ?? null,
      world,
      playerState: pstatePda(world, p.player),
      chunk00: slot(0, 0),
      chunk10: slot(1, 0),
      chunk01: slot(0, 1),
      chunk11: slot(1, 1),
      presence: o.presence ?? presencePda(chunkPda(world, ncx, ncz)),
      oldPresence:
        o.oldPresence !== undefined
          ? o.oldPresence
          : crossed
          ? presencePda(chunkPda(world, ocx, ocz))
          : null,
    })
    .instruction();
}

// ---------- path planning over reference blocks ----------

/** core::blocks::is_solid: everything but air, torch and water (23..=30). */
export const isSolid = (b: number) =>
  !(b === 0 || b === 17 || (b >= 23 && b <= 30));

/** Feet y (blocks) on top of the topmost non-air block of a column, or null if
 *  that block is not solid (water, torch). Everything above is air. */
export function surface(blocks: Buffer, lx: number, lz: number): number | null {
  for (let y = 63; y >= 0; y--) {
    const b = blocks[y * 256 + lz * 16 + lx];
    if (b === 0) continue;
    return isSolid(b) ? y + 1 : null;
  }
  return null;
}

/** Shortest 4-connected walk between column centers from `start` (world block
 *  x, z) to any column of chunk `target`, over the chunks in `blocks` (key
 *  "cx,cz" → final blocks). Steps go up ≤ 1 block (one jump) or down ≤ 3 (no
 *  fall damage); since every column's surface has only air above, such steps
 *  satisfy every `check_move` rule at block centers. Returns world block
 *  `[x, feetY, z]` waypoints (start excluded) or null. */
export function planWalk(
  blocks: Map<string, Buffer>,
  start: [number, number],
  target: [number, number]
): [number, number, number][] | null {
  const h = (x: number, z: number): number | null => {
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const b = blocks.get(`${cx},${cz}`);
    if (!b) return null;
    return surface(b, x - cx * 16, z - cz * 16);
  };
  const key = (x: number, z: number) => `${x},${z}`;
  const prev = new Map<string, string | null>([[key(...start), null]]);
  const queue: [number, number][] = [start];
  while (queue.length) {
    const [x, z] = queue.shift()!;
    const hy = h(x, z);
    if (hy === null) continue;
    if (Math.floor(x / 16) === target[0] && Math.floor(z / 16) === target[1]) {
      const path: [number, number, number][] = [];
      let k: string | null = key(x, z);
      while (k && k !== key(...start)) {
        const [px, pz] = k.split(",").map(Number);
        path.unshift([px, h(px, pz)!, pz]);
        k = prev.get(k)!;
      }
      return path;
    }
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const [nx, nz] = [x + dx, z + dz];
      if (prev.has(key(nx, nz))) continue;
      const nh = h(nx, nz);
      if (nh === null || nh - hy > 1 || hy - nh > 3) continue;
      prev.set(key(nx, nz), key(x, z));
      queue.push([nx, nz]);
    }
  }
  return null;
}

/** FP feet position at the center of block column (x, z), feet at y. */
export const center = (x: number, y: number, z: number) => [
  x * FP + FP / 2,
  y * FP,
  z * FP + FP / 2,
];
