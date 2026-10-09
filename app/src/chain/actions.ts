// Typed builders for every gameplay ix (ported from tests/helpers/{world,chunk,play,actions,
// crank}.ts). They only build ixs; send them with `ErSender` (session key signs + pays).
//
// Chunk existence: the ER rejects a tx listing a non-existent account as writable, so
// builders that take neighbor chunks need to know which exist. They take an `Exists`
// predicate (the client's chunk store; `existsIn(set)` for a `Set<"cx,cz">`), or use
// `fetchExisting` to ask the ER.
import { BN } from "@anchor-lang/core";
import type { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  chunkOfBlock,
  chunkOfFp,
  localOfBlock,
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

export type Exists = (cx: number, cz: number) => boolean;
export const existsIn = (set: ReadonlySet<string>): Exists => (cx, cz) => set.has(chunkKey(cx, cz));

/** Neighbor offsets N, S, E, W (`chunk_n/s/e/w`, `ChunkHeader::nbr_mask` bit order). */
export const NBR_OFF: readonly [number, number][] = [
  [0, -1],
  [0, 1],
  [1, 0],
  [-1, 0],
];

/** Which of `coords` exist on the ER as magicraft chunks (one `getMultipleAccountsInfo`
 *  per 100). */
export async function fetchExisting(
  er: Connection,
  programId: PublicKey,
  world: PublicKey,
  coords: [number, number][],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < coords.length; i += 100) {
    const part = coords.slice(i, i + 100);
    const infos = await er.getMultipleAccountsInfo(
      part.map(([cx, cz]) => chunkPda(programId, world, cx, cz)),
      "confirmed",
    );
    part.forEach(([cx, cz], j) => {
      if (infos[j]?.owner.equals(programId)) out.add(chunkKey(cx, cz));
    });
  }
  return out;
}

/** Sets the writability of the neighbor-slot metas of a built ix. */
function setWritable(ix: TransactionInstruction, slots: { pubkey: PublicKey; writable: boolean }[]) {
  for (const s of slots) for (const m of ix.keys) if (m.pubkey.equals(s.pubkey)) m.isWritable = s.writable;
  return ix;
}

/** The 4 neighbor slots of create_chunk / close_chunk: each neighbor's chunk PDA,
 *  writable iff it exists. */
export function neighborSlots(programId: PublicKey, world: PublicKey, cx: number, cz: number, exists: Exists) {
  return NBR_OFF.map(([dx, dz]) => ({
    pubkey: chunkPda(programId, world, cx + dx, cz + dz),
    writable: exists(cx + dx, cz + dz),
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

/** `create_world(nonce, name, params)`; the World PDA is `["world", wallet, nonce]`. */
export async function createWorldIx(
  program: MagicraftProgram,
  auth: Auth,
  nonce: bigint,
  name: string,
  params: WorldParams,
) {
  return program.methods
    .createWorld(new BN(nonce.toString()), nameBytes(name), params)
    .accountsPartial({
      ...authAccounts(auth),
      world: worldPda(program.programId, auth.authority, nonce),
    })
    .instruction();
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
  exists: Exists,
  playerState: PublicKey | null = null,
) {
  const pid = program.programId;
  const chunk = chunkPda(pid, world, cx, cz);
  const slots = neighborSlots(pid, world, cx, cz, exists);
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
  exists: Exists,
  playerState: PublicKey | null = null,
) {
  return [
    await createChunkIx(program, auth, world, cx, cz, exists, playerState),
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
  exists: Exists,
) {
  const pid = program.programId;
  const chunk = chunkPda(pid, world, cx, cz);
  const slots = neighborSlots(pid, world, cx, cz, exists);
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

export type MoveArgs = {
  /** Last accepted FP feet position (the onchain `MoveState.pos`). */
  prev: V3;
  pos: V3;
  vel?: V3;
  onGround: boolean;
  /** Client timestamp in chain ms (`worldChainMs`, slightly behind the estimate). */
  clientMs: number;
  exists: Exists;
};

/** `move_player(pos, vel, on_ground, client_ms)` with the 2×2 window chunks (passed when
 *  they exist), `presence` of the new chunk and `old_presence` when crossing. */
export async function moveIx(program: MagicraftProgram, auth: Auth, world: PublicKey, m: MoveArgs) {
  const pid = program.programId;
  const [cx0, cz0] = moveWindow(m.prev, m.pos) ?? [chunkOfFp(m.prev[0]), chunkOfFp(m.prev[2])];
  const slot = (dx: number, dz: number) =>
    m.exists(cx0 + dx, cz0 + dz) ? chunkPda(pid, world, cx0 + dx, cz0 + dz) : null;
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

/** `break_block(x, y, z)` (world block coords); existing N/S/E/W neighbors are passed so
 *  fluid enqueues can cross the border. */
export async function breakBlockIx(
  program: MagicraftProgram,
  auth: Auth,
  world: PublicKey,
  b: V3,
  exists: Exists,
) {
  const pid = program.programId;
  const [cx, cz] = chunkOfB(b);
  const nb = (dx: number, dz: number) =>
    exists(cx + dx, cz + dz) ? chunkPda(pid, world, cx + dx, cz + dz) : null;
  return program.methods
    .breakBlock(b[0], b[1], b[2])
    .accountsPartial({
      ...authAccounts(auth),
      world,
      playerState: pstateOf(program, auth, world),
      chunk: chunkPda(pid, world, cx, cz),
      chunkN: nb(0, -1),
      chunkS: nb(0, 1),
      chunkE: nb(1, 0),
      chunkW: nb(-1, 0),
    })
    .instruction();
}

/** The border neighbours `place_block` needs as `remaining_accounts`
 *  (`actions::needed_neighbors`): for a block on a chunk edge, the chunk across each edge
 *  (and the diagonal one at a corner), in the order x-edge, z-edge, diagonal; each an
 *  existing chunk + its presence, else the chunk PDA alone. All read-only. */
export function placeRemainingAccounts(programId: PublicKey, world: PublicKey, b: V3, exists: Exists) {
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
    return exists(cx + ox, cz + oz) ? [ro(c), ro(presencePda(programId, c))] : [ro(c)];
  });
}

/** `place_block(x, y, z, slot)`. */
export async function placeBlockIx(
  program: MagicraftProgram,
  auth: Auth,
  world: PublicKey,
  b: V3,
  slot: number,
  exists: Exists,
) {
  const pid = program.programId;
  const [cx, cz] = chunkOfB(b);
  const chunk = chunkPda(pid, world, cx, cz);
  return program.methods
    .placeBlock(b[0], b[1], b[2], slot)
    .accountsPartial({
      ...authAccounts(auth),
      world,
      playerState: pstateOf(program, auth, world),
      chunk,
      presence: presencePda(pid, chunk),
      chunkN: null,
      chunkS: null,
      chunkE: null,
      chunkW: null,
    })
    .remainingAccounts(placeRemainingAccounts(pid, world, b, exists))
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
