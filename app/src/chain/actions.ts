// Typed builders for every gameplay ix (ported from tests/helpers/{world,chunk,play,actions,
// crank}.ts). They only build ixs; send them with `ErSender` (session key signs + pays).
//
// Chunk knowledge: the ER rejects a tx listing a non-existent account as writable, and
// gameplay ixs reject a passed chunk that is not fully generated (`ChunkNotReady`). Builders
// that take neighbor chunks get a `ChunkView` (`exists` / `ready` per chunk coordinate) from
// the client's chunk store; `viewOf(existing, ready)` builds one from key sets and
// `fetchChunkView` asks the ER. A builder that needs a chunk that is not ready throws
// `ChunkNotReadyError` (the sender reports it as kind `notReady`).
import { BN } from "@anchor-lang/core";
import { SYSVAR_CLOCK_PUBKEY, type Connection, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  chainEstimate,
  chunkReady,
  chunkOfBlock,
  chunkOfFp,
  GROUND_HALF_W,
  localOfBlock,
  decodeWorld,
  nextClientMs,
  type V3,
  type WorldParams,
} from "./layout";
import type { MagicraftProgram } from "./program";
import { chunkKey, chunkPda, presencePda, pstatePda, worldPda } from "./pdas";
import type { Session } from "./session";

/** Who acts: the wallet's Player, signed by the session key (or the wallet itself). */
export type Auth = {
  /** The tx signer: session key, or the wallet (`sessionToken` null). */
  signer: PublicKey;
  /** The wallet (Player authority, World creator). */
  authority: PublicKey;
  /** The Player PDA. */
  player: PublicKey;
  sessionToken: PublicKey | null;
};

export const sessionAuth = (s: Session, player: PublicKey): Auth => ({
  signer: s.kp.publicKey,
  authority: s.authority,
  player,
  sessionToken: s.token,
});

export const walletAuth = (wallet: PublicKey, player: PublicKey): Auth => ({
  signer: wallet,
  authority: wallet,
  player,
  sessionToken: null,
});

const authAccounts = (a: Auth) => ({ signer: a.signer, player: a.player, sessionToken: a.sessionToken });

/** What the client knows about chunk `(cx, cz)` of the world. */
export type ChunkView = {
  /** The chunk account exists on the ER (any gen stage). */
  exists(cx: number, cz: number): boolean;
  /** Full size and `gen_stage == DONE` (implies `exists`). */
  ready(cx: number, cz: number): boolean;
};

/** A `ChunkView` from key sets (`"cx,cz"`); `ready` defaults to `existing` (all generated). */
export const viewOf = (existing: ReadonlySet<string>, ready: ReadonlySet<string> = existing): ChunkView => ({
  exists: (cx, cz) => existing.has(chunkKey(cx, cz)),
  ready: (cx, cz) => ready.has(chunkKey(cx, cz)),
});

/** A builder needed a chunk that is not (known to be) ready. */
export class ChunkNotReadyError extends Error {
  constructor(
    readonly cx: number,
    readonly cz: number,
  ) {
    super(`chunk ${cx},${cz} is not ready`);
    this.name = "ChunkNotReadyError";
  }
}

/** Neighbor offsets N, S, E, W (`chunk_n/s/e/w`, `ChunkHeader::nbr_mask` bit order). */
export const NBR_OFF: readonly [number, number][] = [
  [0, -1],
  [0, 1],
  [1, 0],
  [-1, 0],
];

/** Which of `coords` exist / are ready on the ER (one `getMultipleAccountsInfo` per 100). */
export async function fetchChunkView(
  er: Connection,
  programId: PublicKey,
  world: PublicKey,
  coords: [number, number][],
): Promise<ChunkView & { existing: Set<string>; readySet: Set<string> }> {
  const existing = new Set<string>();
  const readySet = new Set<string>();
  for (let i = 0; i < coords.length; i += 100) {
    const part = coords.slice(i, i + 100);
    const infos = await er.getMultipleAccountsInfo(
      part.map(([cx, cz]) => chunkPda(programId, world, cx, cz)),
      "confirmed",
    );
    part.forEach(([cx, cz], j) => {
      const info = infos[j];
      if (!info?.owner.equals(programId)) return;
      existing.add(chunkKey(cx, cz));
      if (chunkReady(info.data)) readySet.add(chunkKey(cx, cz));
    });
  }
  return { ...viewOf(existing, readySet), existing, readySet };
}

/** Sets the writability of the neighbor-slot metas of a built ix. */
function setWritable(ix: TransactionInstruction, slots: { pubkey: PublicKey; writable: boolean }[]) {
  for (const s of slots) for (const m of ix.keys) if (m.pubkey.equals(s.pubkey)) m.isWritable = s.writable;
  return ix;
}

/** The 4 neighbor slots of create_chunk / close_chunk: each neighbor's chunk PDA,
 *  writable iff it exists. */
export function neighborSlots(programId: PublicKey, world: PublicKey, cx: number, cz: number, view: ChunkView) {
  return NBR_OFF.map(([dx, dz]) => ({
    pubkey: chunkPda(programId, world, cx + dx, cz + dz),
    writable: view.exists(cx + dx, cz + dz),
  }));
}

// ---------------------------------------------------------------- worlds

/** 32-byte zero-padded UTF-8 world name (truncated on a char boundary). */
export function nameBytes(name: string): number[] {
  const enc = new TextEncoder();
  let s = name;
  while (enc.encode(s).length > 32) s = s.slice(0, -1);
  const b = new Uint8Array(32);
  b.set(enc.encode(s));
  return [...b];
}

/** A fresh world nonce (ms timestamp × 1000 + random: unique per creator in practice). */
export const freshNonce = (): bigint =>
  BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

/** `create_world(nonce, name, params, us_per_slot_hint)`; the World PDA is
 *  `["world", wallet, nonce]`. `usPerSlotHint`: the ER slot rate (`measureUsPerSlot`),
 *  0 = the program's 50 ms default (the local ER's rate; wrong on devnet's ~10 ms ERs). */
export async function createWorldIx(
  program: MagicraftProgram,
  auth: Auth,
  nonce: bigint,
  name: string,
  params: WorldParams,
  usPerSlotHint = 0,
) {
  return program.methods
    .createWorld(new BN(nonce.toString()), nameBytes(name), params, usPerSlotHint)
    .accountsPartial({
      ...authAccounts(auth),
      world: worldPda(program.programId, auth.authority, nonce),
    })
    .instruction();
}

/** Measures the ER slot rate in µs per slot over ~`spanMs` (two `getSlot` readings,
 *  each placed at its request's round-trip midpoint): the `create_world` hint. 0 if the
 *  slot did not advance or a reading failed (the program then uses its default). */
export async function measureUsPerSlot(
  er: Pick<Connection, "getSlot">,
  spanMs = 2_000,
  now: () => number = () => performance.now(),
): Promise<number> {
  const read = async () => {
    const t0 = now();
    const slot = await er.getSlot("processed");
    return { slot, t: (t0 + now()) / 2 };
  };
  try {
    const a = await read();
    await new Promise((r) => setTimeout(r, spanMs));
    const b = await read();
    if (b.slot <= a.slot) return 0;
    // The program clamps to 1 000–1 000 000 µs; keep the hint a sane u32 either way.
    return Math.min(1_000_000, Math.max(0, Math.round(((b.t - a.t) * 1000) / (b.slot - a.slot))));
  } catch {
    return 0;
  }
}

/** `request_seed(client_seed)` (VRF on the configured queue; any session-authed delegated
 *  Player may pay while the seed is unset). */
export async function requestSeedIx(
  program: MagicraftProgram,
  auth: Auth,
  world: PublicKey,
  clientSeed: Uint8Array = crypto.getRandomValues(new Uint8Array(32)),
) {
  return program.methods
    .requestSeed([...clientSeed])
    .accountsPartial({ ...authAccounts(auth), world })
    .instruction();
}

/** Permissionless day-crank watchdog re-arm (no-op unless the crank is stale). */
export async function scheduleDayCrankIx(program: MagicraftProgram, world: PublicKey) {
  return program.methods.scheduleDayCrank().accountsPartial({ world }).instruction();
}

// ---------------------------------------------------------------- chunks

/** `create_chunk(cx, cz)`: adjacency = any `DONE` neighbor, or the player's own chunk
 *  (`playerState`), or (0,0) in an empty world. */
export async function createChunkIx(
  program: MagicraftProgram,
  auth: Auth,
  world: PublicKey,
  cx: number,
  cz: number,
  view: ChunkView,
  playerState: PublicKey | null = null,
) {
  const pid = program.programId;
  const chunk = chunkPda(pid, world, cx, cz);
  const slots = neighborSlots(pid, world, cx, cz, view);
  const ix = await program.methods
    .createChunk(cx, cz)
    .accountsPartial({
      ...authAccounts(auth),
      world,
      chunk,
      presence: presencePda(pid, chunk),
      chunkN: slots[0].pubkey,
      chunkS: slots[1].pubkey,
      chunkE: slots[2].pubkey,
      chunkW: slots[3].pubkey,
      playerState,
    })
    .instruction();
  return setWritable(ix, slots);
}

/** `grow_chunk` (permissionless; `payerPlayer` = the chunk's payer Player, which sponsors
 *  the resize). */
export async function growChunkIx(
  program: MagicraftProgram,
  payerPlayer: PublicKey,
  world: PublicKey,
  cx: number,
  cz: number,
) {
  return program.methods
    .growChunk(cx, cz)
    .accountsPartial({ player: payerPlayer, world, chunk: chunkPda(program.programId, world, cx, cz) })
    .instruction();
}

/** Generation tx 1 (send with `gen: true`): `create_chunk` + `grow_chunk`. */
export async function createAndGrowIxs(
  program: MagicraftProgram,
  auth: Auth,
  world: PublicKey,
  cx: number,
  cz: number,
  view: ChunkView,
  playerState: PublicKey | null = null,
) {
  return [
    await createChunkIx(program, auth, world, cx, cz, view, playerState),
    await growChunkIx(program, auth.player, world, cx, cz),
  ];
}

/** Generation tx 2 (send with `gen: true`, any fee payer): `populate_chunk`. */
export async function populateChunkIx(program: MagicraftProgram, world: PublicKey, cx: number, cz: number) {
  return program.methods
    .populateChunk(cx, cz)
    .accountsPartial({ world, chunk: chunkPda(program.programId, world, cx, cz) })
    .instruction();
}

/** Permissionless, once: world spawn from the populated chunk (0,0). */
export async function setSpawnIx(program: MagicraftProgram, world: PublicKey) {
  return program.methods
    .setSpawn()
    .accountsPartial({ world, chunk: chunkPda(program.programId, world, 0, 0) })
    .instruction();
}

/** `close_chunk` (payer only, unedited, empty presence): refunds rent to the Player. */
export async function closeChunkIx(
  program: MagicraftProgram,
  auth: Auth,
  world: PublicKey,
  cx: number,
  cz: number,
  view: ChunkView,
) {
  const pid = program.programId;
  const chunk = chunkPda(pid, world, cx, cz);
  const slots = neighborSlots(pid, world, cx, cz, view);
  const ix = await program.methods
    .closeChunk(cx, cz)
    .accountsPartial({
      ...authAccounts(auth),
      world,
      chunk,
      presence: presencePda(pid, chunk),
      chunkN: slots[0].pubkey,
      chunkS: slots[1].pubkey,
      chunkE: slots[2].pubkey,
      chunkW: slots[3].pubkey,
    })
    .instruction();
  return setWritable(ix, slots);
}

/** Permissionless chunk-crank watchdog re-arm (no-op unless stale). */
export async function armChunkIx(program: MagicraftProgram, world: PublicKey, cx: number, cz: number) {
  return program.methods
    .armChunk()
    .accountsPartial({ world, chunk: chunkPda(program.programId, world, cx, cz) })
    .instruction();
}

/** The chunks to create (in order) so that `target` ("cx,cz") becomes creatable next to
 *  `existing`: the shortest edge-adjacent chain from an existing chunk (or (0,0) when none
 *  exists), within `|cx|, |cz| ≤ bound`. Ends with `target`; empty if it exists. */
export function creationChain(existing: ReadonlySet<string>, target: string, bound = Infinity): string[] {
  if (existing.has(target)) return [];
  if (!existing.size) {
    if (target === "0,0") return ["0,0"];
  }
  const roots = existing.size ? [...existing] : ["0,0"];
  const prev = new Map<string, string | null>(roots.map((k) => [k, null]));
  const q = [...roots];
  for (let i = 0; i < q.length; i++) {
    const [cx, cz] = q[i].split(",").map(Number);
    for (const [dx, dz] of NBR_OFF) {
      const [nx, nz] = [cx + dx, cz + dz];
      const k = chunkKey(nx, nz);
      if (Math.abs(nx) > bound || Math.abs(nz) > bound || prev.has(k)) continue;
      prev.set(k, q[i]);
      if (k === target) {
        const chain: string[] = [];
        for (let c: string | null = k; c && !existing.has(c); c = prev.get(c) ?? null) chain.unshift(c);
        return chain;
      }
      q.push(k);
    }
  }
  throw new Error(`chunk ${target} is not reachable within ${bound}`);
}

// ---------------------------------------------------------------- play

export const pstateOf = (program: MagicraftProgram, auth: Auth, world: PublicKey) =>
  pstatePda(program.programId, world, auth.player);

/** `join_world`: creates the PlayerState at spawn (the first move adds presence). */
export async function joinWorldIx(program: MagicraftProgram, auth: Auth, world: PublicKey) {
  return program.methods
    .joinWorld()
    .accountsPartial({ ...authAccounts(auth), world, playerState: pstateOf(program, auth, world) })
    .instruction();
}

/** `physics::move_window`: origin of the 2×2 chunk window covering FP feet `a → b` (with
 *  the body half-width margin), or null if the move spans more than 2 chunks on an axis. */
export function moveWindow(a: readonly number[], b: readonly number[]): [number, number] | null {
  const span = (u: number, v: number) => {
    const lo = Math.min(u, v) - GROUND_HALF_W;
    const hi = Math.max(u, v) + GROUND_HALF_W - 1;
    const c0 = Math.floor(lo / 4096);
    const c1 = Math.floor(hi / 4096);
    return c1 - c0 > 1 ? null : c0;
  };
  const x = span(a[0], b[0]);
  const z = span(a[2], b[2]);
  return x === null || z === null ? null : [x, z];
}

/** `play::required_slots`: window slots (order `(cx0,cz0)`, `(cx0+1,cz0)`, `(cx0,cz0+1)`,
 *  `(cx0+1,cz0+1)`) overlapped by the xz footprint (± `GROUND_HALF_W`) of `a` or `b`; these
 *  chunks must be passed (and ready) or the move fails with `ChunkNotReady`. */
export function requiredSlots(a: readonly number[], b: readonly number[], cx0: number, cz0: number): boolean[] {
  const m = GROUND_HALF_W;
  const req = [false, false, false, false];
  for (const p of [a, b]) {
    const [x, z] = [p[0], p[2]];
    for (let cz = Math.floor((z - m) / 4096); cz <= Math.floor((z + m - 1) / 4096); cz++)
      for (let cx = Math.floor((x - m) / 4096); cx <= Math.floor((x + m - 1) / 4096); cx++) {
        const [dx, dz] = [cx - cx0, cz - cz0];
        if (dx >= 0 && dx < 2 && dz >= 0 && dz < 2) req[dz * 2 + dx] = true;
      }
  }
  return req;
}

/** Polls the World clock, ER slot and Clock sysvar until `nextClientMs` yields a timestamp
 *  (tests, simple callers; a game loop should use its own `ChainClock`). Uses
 *  `chainEstimate`, so it follows the program into coarse wall time when the anchor is
 *  stale or far off. */
export async function waitClientMs(
  er: Connection,
  world: PublicKey,
  lastMs: number,
  minDt = 1,
  timeoutMs = 10_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [info, slot, clk] = await Promise.all([
      er.getAccountInfo(world, "confirmed"),
      er.getSlot("processed"),
      er.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "processed"),
    ]);
    if (!info) throw new Error(`world ${world.toBase58()} not found`);
    const wall = clk && clk.data.length >= 40 ? Number(new DataView(clk.data.buffer, clk.data.byteOffset).getBigInt64(32, true)) * 1000 + 500 : null;
    const chain = chainEstimate(decodeWorld(info.data), slot, wall);
    const ms = chain === null ? null : nextClientMs(chain, lastMs, minDt);
    if (ms !== null) return ms;
    if (Date.now() > deadline) throw new Error("chain clock unavailable or behind lastMs");
    await new Promise((r) => setTimeout(r, 50));
  }
}

export type MoveArgs = {
  /** The position the chain checks this move from: the last **confirmed** move's position
   *  as tracked locally (equal to the onchain `MoveState.pos` once that update arrives;
   *  after a rejection, snap back to the onchain value). Not the last *sent* position. */
  prev: V3;
  pos: V3;
  vel?: V3;
  onGround: boolean;
  /** Client timestamp in chain ms. Must strictly increase from move to move and stay
   *  within the chain's lead tolerance: use `nextClientMs`. */
  clientMs: number;
  view: ChunkView;
};

/** `move_player(pos, vel, on_ground, client_ms)`. Window chunks: every required slot
 *  (`requiredSlots`) must be ready (else `ChunkNotReadyError`); other ready slots are
 *  passed too (read-only; an omitted one reads as stone, which only matters for a sweep
 *  across a chunk corner). `presence` of the new chunk, `old_presence` when crossing. */
export async function moveIx(program: MagicraftProgram, auth: Auth, world: PublicKey, m: MoveArgs) {
  const pid = program.programId;
  const [cx0, cz0] = moveWindow(m.prev, m.pos) ?? [chunkOfFp(m.prev[0]), chunkOfFp(m.prev[2])];
  const req = requiredSlots(m.prev, m.pos, cx0, cz0);
  const slot = (dx: number, dz: number) => {
    const [cx, cz] = [cx0 + dx, cz0 + dz];
    if (m.view.ready(cx, cz)) return chunkPda(pid, world, cx, cz);
    if (req[dz * 2 + dx]) throw new ChunkNotReadyError(cx, cz);
    return null;
  };
  const [ncx, ncz] = [chunkOfFp(m.pos[0]), chunkOfFp(m.pos[2])];
  const [ocx, ocz] = [chunkOfFp(m.prev[0]), chunkOfFp(m.prev[2])];
  const crossed = ncx !== ocx || ncz !== ocz;
  return program.methods
    .movePlayer(m.pos, m.vel ?? [0, 0, 0], m.onGround, new BN(Math.floor(m.clientMs)))
    .accountsPartial({
      ...authAccounts(auth),
      world,
      playerState: pstateOf(program, auth, world),
      chunk00: slot(0, 0),
      chunk10: slot(1, 0),
      chunk01: slot(0, 1),
      chunk11: slot(1, 1),
      presence: presencePda(pid, chunkPda(pid, world, ncx, ncz)),
      oldPresence: crossed ? presencePda(pid, chunkPda(pid, world, ocx, ocz)) : null,
    })
    .instruction();
}

const chunkOfB = (b: V3): [number, number] => [chunkOfBlock(b[0]), chunkOfBlock(b[2])];

/** `break_block(x, y, z)` (world block coords). The target chunk must be ready; ready
 *  neighbors across the borders the block touches are passed (`borderNeighbors`) so fluid
 *  enqueues can cross them. */
export async function breakBlockIx(
  program: MagicraftProgram,
  auth: Auth,
  world: PublicKey,
  b: V3,
  view: ChunkView,
) {
  const pid = program.programId;
  const [cx, cz] = chunkOfB(b);
  if (!view.ready(cx, cz)) throw new ChunkNotReadyError(cx, cz);
  return program.methods
    .breakBlock(b[0], b[1], b[2])
    .accountsPartial({
      ...authAccounts(auth),
      world,
      playerState: pstateOf(program, auth, world),
      chunk: chunkPda(pid, world, cx, cz),
      ...borderNeighbors(pid, world, b, view),
    })
    .instruction();
}

/** `chunkN/S/E/W` for an edit of block `b`: the ready neighbor across each border the
 *  block touches (E/W when `lx ∈ {0, 15}`, N/S when `lz ∈ {0, 15}`), else null (fewer
 *  write locks than passing every neighbor). */
export function borderNeighbors(programId: PublicKey, world: PublicKey, b: V3, view: ChunkView) {
  const [cx, cz] = chunkOfB(b);
  const [lx, lz] = [localOfBlock(b[0]), localOfBlock(b[2])];
  const nb = (touch: boolean, dx: number, dz: number) =>
    touch && view.ready(cx + dx, cz + dz) ? chunkPda(programId, world, cx + dx, cz + dz) : null;
  return {
    chunkN: nb(lz === 0, 0, -1),
    chunkS: nb(lz === 15, 0, 1),
    chunkE: nb(lx === 15, 1, 0),
    chunkW: nb(lx === 0, -1, 0),
  };
}

/** The border neighbours `place_block` needs as `remaining_accounts`
 *  (`actions::needed_neighbors`): for a block on a chunk edge, the chunk across each edge
 *  (and the diagonal one at a corner), in the order x-edge, z-edge, diagonal; each an
 *  existing chunk + its presence, else the chunk PDA alone. All read-only. */
export function placeRemainingAccounts(programId: PublicKey, world: PublicKey, b: V3, view: ChunkView) {
  const [cx, cz] = chunkOfB(b);
  const edge = (l: number) => (l === 0 ? -1 : l === 15 ? 1 : 0);
  const dx = edge(localOfBlock(b[0]));
  const dz = edge(localOfBlock(b[2]));
  const need: [number, number][] = [];
  if (dx) need.push([dx, 0]);
  if (dz) need.push([0, dz]);
  if (dx && dz) need.push([dx, dz]);
  const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  return need.flatMap(([ox, oz]) => {
    const c = chunkPda(programId, world, cx + ox, cz + oz);
    return view.exists(cx + ox, cz + oz) ? [ro(c), ro(presencePda(programId, c))] : [ro(c)];
  });
}

/** `place_block(x, y, z, slot)`: the target chunk must be ready; ready border neighbors go
 *  in `chunkN/S/E/W` (fluid), the required neighbor presences in `remaining_accounts`. */
export async function placeBlockIx(
  program: MagicraftProgram,
  auth: Auth,
  world: PublicKey,
  b: V3,
  slot: number,
  view: ChunkView,
) {
  const pid = program.programId;
  const [cx, cz] = chunkOfB(b);
  if (!view.ready(cx, cz)) throw new ChunkNotReadyError(cx, cz);
  const chunk = chunkPda(pid, world, cx, cz);
  return program.methods
    .placeBlock(b[0], b[1], b[2], slot)
    .accountsPartial({
      ...authAccounts(auth),
      world,
      playerState: pstateOf(program, auth, world),
      chunk,
      presence: presencePda(pid, chunk),
      ...borderNeighbors(pid, world, b, view),
    })
    .remainingAccounts(placeRemainingAccounts(pid, world, b, view))
    .instruction();
}

/** `select_slot(slot)` (held tool / weapon). */
export async function selectSlotIx(program: MagicraftProgram, auth: Auth, world: PublicKey, slot: number) {
  return program.methods
    .selectSlot(slot)
    .accountsPartial({ ...authAccounts(auth), playerState: pstateOf(program, auth, world) })
    .instruction();
}

/** `eat(slot)`. */
export async function eatIx(program: MagicraftProgram, auth: Auth, world: PublicKey, slot: number) {
  return program.methods
    .eat(slot)
    .accountsPartial({ ...authAccounts(auth), playerState: pstateOf(program, auth, world) })
    .instruction();
}

/** `craft(recipe_id, count, table?, furnace?)`: station block positions (world coords)
 *  when the recipe needs them; their chunks are passed. */
export async function craftIx(
  program: MagicraftProgram,
  auth: Auth,
  world: PublicKey,
  recipe: number,
  count: number,
  stations: { table?: V3 | null; furnace?: V3 | null } = {},
) {
  const pid = program.programId;
  const at = (b?: V3 | null) => (b ? chunkPda(pid, world, ...chunkOfB(b)) : null);
  return program.methods
    .craft(recipe, count, stations.table ?? null, stations.furnace ?? null)
    .accountsPartial({
      ...authAccounts(auth),
      world,
      playerState: pstateOf(program, auth, world),
      tableChunk: at(stations.table),
      furnaceChunk: at(stations.furnace),
    })
    .instruction();
}

/** `attack_mob(idx)` on mob slot `idx` of chunk `(cx, cz)`. */
export async function attackMobIx(
  program: MagicraftProgram,
  auth: Auth,
  world: PublicKey,
  cx: number,
  cz: number,
  idx: number,
) {
  return program.methods
    .attackMob(idx)
    .accountsPartial({
      ...authAccounts(auth),
      world,
      playerState: pstateOf(program, auth, world),
      chunk: chunkPda(program.programId, world, cx, cz),
    })
    .instruction();
}

/** `respawn` (only when dead: back to spawn, inventory cleared). */
export async function respawnIx(program: MagicraftProgram, auth: Auth, world: PublicKey) {
  return program.methods
    .respawn()
    .accountsPartial({ ...authAccounts(auth), world, playerState: pstateOf(program, auth, world) })
    .instruction();
}
