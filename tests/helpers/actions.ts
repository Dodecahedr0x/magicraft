// Action ix builders (break/place/select/craft/attack/eat/respawn) and
// PlayerState inventory / chunk fluid-queue decoding.
import { web3 } from "@anchor-lang/core";
import { TestPlayer } from "./player";
import { chunkData, chunkPda, presencePda } from "./chunk";
import { pstatePda } from "./play";

export type V3 = [number, number, number];

/** Item ids (core::items). */
export const ITEM = {
  DIRT: 2,
  COBBLESTONE: 4,
  LOG: 9,
  PLANKS: 11,
  CRAFTING_TABLE: 15,
  WOOD_PICKAXE: 256,
  WOOD_SHOVEL: 264,
  STICK: 512,
  RAW_PORK: 768,
  RAW_BEEF: 770,
  RAW_MUTTON: 772,
} as const;
/** Raw meat dropped by a mob kind (1 pig, 2 cow, 3 sheep). */
export const MEAT: Record<number, number> = { 1: 768, 2: 770, 3: 772 };
/** Recipe ids (core::recipes::RECIPES). */
export const RECIPE = {
  PLANKS: 0,
  STICKS: 1,
  TABLE: 2,
  WOOD_PICKAXE: 5,
  WOOD_SHOVEL: 13,
} as const;

export type Slot = { item: number; count: number; durability: number };

export function decodeInventory(bytes: number[] | Buffer): Slot[] {
  const b = Buffer.from(bytes);
  const out: Slot[] = [];
  for (let i = 0; i < 36; i++) {
    out.push({
      item: b.readUInt16LE(6 * i),
      count: b[6 * i + 2],
      durability: b.readUInt16LE(6 * i + 4),
    });
  }
  return out;
}

export const countItem = (inv: Slot[], item: number) =>
  inv.filter((s) => s.item === item).reduce((n, s) => n + s.count, 0);
export const slotOf = (inv: Slot[], item: number) =>
  inv.findIndex((s) => s.item === item && s.count > 0);
/** First slot holding a block item (placeable), or -1. */
export const placeableSlot = (inv: Slot[]) =>
  inv.findIndex((s) => s.count > 0 && s.item >= 1 && s.item <= 22);

/** Fluid queue of a chunk account (header @620: buf u16×64, head @750, len @751). */
export function fluidQueue(chunkData: Buffer) {
  const o = 620;
  const head = chunkData[o + 130];
  const len = chunkData[o + 131];
  const entries: number[] = [];
  for (let i = 0; i < len; i++)
    entries.push(chunkData.readUInt16LE(o + 2 * ((head + i) & 63)));
  return { len, entries, overflow: chunkData[o + 132] };
}

/** Mob slots of a chunk account (header @364, 8 × 32 bytes). */
export function chunkMobs(chunkData: Buffer) {
  const out = [];
  for (let i = 0; i < 8; i++) {
    const o = 364 + 32 * i;
    out.push({
      kind: chunkData[o],
      hp: chunkData[o + 1],
      pos: [
        chunkData.readInt32LE(o + 4),
        chunkData.readInt32LE(o + 8),
        chunkData.readInt32LE(o + 12),
      ] as V3,
    });
  }
  return out;
}

export type GroundItem = {
  idx: number;
  item: number;
  count: number;
  pos: V3;
  expiresMs: number;
};

/** Live ground items of a chunk account at chain time `now` (`core::ground`, 16 ×
 *  24 B after the blocks: item u16, count u8, pad, pos [i32; 3], expires_ms i64). */
export function groundItems(chunkData: Buffer, now: number): GroundItem[] {
  const out: GroundItem[] = [];
  for (let i = 0; i < 16; i++) {
    const o = 768 + 16_384 + 24 * i;
    if (o + 24 > chunkData.length) break;
    const count = chunkData[o + 2];
    const expiresMs = Number(chunkData.readBigInt64LE(o + 16));
    if (count === 0 || now >= expiresMs) continue;
    out.push({
      idx: i,
      item: chunkData.readUInt16LE(o),
      count,
      pos: [
        chunkData.readInt32LE(o + 4),
        chunkData.readInt32LE(o + 8),
        chunkData.readInt32LE(o + 12),
      ],
      expiresMs,
    });
  }
  return out;
}

export const localIndex = (b: V3) =>
  b[1] * 256 +
  (b[2] - Math.floor(b[2] / 16) * 16) * 16 +
  (b[0] - Math.floor(b[0] / 16) * 16);
const chunkOfBlock = (b: V3): [number, number] => [
  Math.floor(b[0] / 16),
  Math.floor(b[2] / 16),
];

type Auth = { signer?: web3.PublicKey; sessionToken?: web3.PublicKey | null };
const authOf = (p: TestPlayer, o: Auth) => ({
  signer: o.signer ?? p.authority.publicKey,
  player: p.player,
  sessionToken: o.sessionToken ?? null,
});

/** break_block; `neighbors`: pass the existing N/S/E/W chunks. */
export async function breakIx(
  p: TestPlayer,
  world: web3.PublicKey,
  b: V3,
  o: Auth & { neighbors?: Set<string> } = {}
) {
  const [cx, cz] = chunkOfBlock(b);
  const nb = (dx: number, dz: number) =>
    o.neighbors?.has(`${cx + dx},${cz + dz}`)
      ? chunkPda(world, cx + dx, cz + dz)
      : null;
  return p.er.methods
    .breakBlock(b[0], b[1], b[2])
    .accountsPartial({
      ...authOf(p, o),
      world,
      playerState: pstatePda(world, p.player),
      chunk: chunkPda(world, cx, cz),
      chunkN: nb(0, -1),
      chunkS: nb(0, 1),
      chunkE: nb(1, 0),
      chunkW: nb(-1, 0),
    })
    .instruction();
}

/** place_block with the neighbour accounts `actions::needed_neighbors`
 *  requires (an existing chunk + its presence, else the chunk PDA itself). */
export async function placeIx(
  p: TestPlayer,
  world: web3.PublicKey,
  b: V3,
  slot: number,
  existing: Set<string>,
  o: Auth = {}
) {
  const [cx, cz] = chunkOfBlock(b);
  const chunk = chunkPda(world, cx, cz);
  const edge = (l: number) => (l === 0 ? -1 : l === 15 ? 1 : 0);
  const dx = edge(b[0] - cx * 16);
  const dz = edge(b[2] - cz * 16);
  const need: [number, number][] = [];
  if (dx) need.push([dx, 0]);
  if (dz) need.push([0, dz]);
  if (dx && dz) need.push([dx, dz]);
  const ro = (pubkey: web3.PublicKey) => ({
    pubkey,
    isSigner: false,
    isWritable: false,
  });
  const remaining = need.flatMap(([ox, oz]) => {
    const c = chunkPda(world, cx + ox, cz + oz);
    return existing.has(`${cx + ox},${cz + oz}`)
      ? [ro(c), ro(presencePda(c))]
      : [ro(c)];
  });
  return p.er.methods
    .placeBlock(b[0], b[1], b[2], slot)
    .accountsPartial({
      ...authOf(p, o),
      world,
      playerState: pstatePda(world, p.player),
      chunk,
      presence: presencePda(chunk),
      chunkN: null,
      chunkS: null,
      chunkE: null,
      chunkW: null,
    })
    .remainingAccounts(remaining)
    .instruction();
}

export async function selectIx(
  p: TestPlayer,
  world: web3.PublicKey,
  slot: number,
  o: Auth = {}
) {
  return p.er.methods
    .selectSlot(slot)
    .accountsPartial({
      ...authOf(p, o),
      playerState: pstatePda(world, p.player),
    })
    .instruction();
}

export async function eatIx(
  p: TestPlayer,
  world: web3.PublicKey,
  slot: number,
  o: Auth = {}
) {
  return p.er.methods
    .eat(slot)
    .accountsPartial({
      ...authOf(p, o),
      playerState: pstatePda(world, p.player),
    })
    .instruction();
}

export async function craftIx(
  p: TestPlayer,
  world: web3.PublicKey,
  recipe: number,
  count: number,
  table: V3 | null = null,
  o: Auth = {}
) {
  const tc = table ? chunkOfBlock(table) : null;
  return p.er.methods
    .craft(recipe, count, table, null)
    .accountsPartial({
      ...authOf(p, o),
      world,
      playerState: pstatePda(world, p.player),
      tableChunk: tc ? chunkPda(world, tc[0], tc[1]) : null,
      furnaceChunk: null,
    })
    .instruction();
}

export async function attackIx(
  p: TestPlayer,
  world: web3.PublicKey,
  chunk: web3.PublicKey,
  idx: number,
  o: Auth = {}
) {
  return p.er.methods
    .attackMob(idx)
    .accountsPartial({
      ...authOf(p, o),
      world,
      playerState: pstatePda(world, p.player),
      chunk,
    })
    .instruction();
}

export async function pickupIx(
  p: TestPlayer,
  world: web3.PublicKey,
  chunk: web3.PublicKey,
  idx: number,
  o: Auth = {}
) {
  return p.er.methods
    .pickupItem(idx)
    .accountsPartial({
      ...authOf(p, o),
      world,
      playerState: pstatePda(world, p.player),
      chunk,
    })
    .instruction();
}

/** pickup_item for every live ground item of the chunk holding block `b`
 *  within pickup reach of `feet` (FP; 2.25 blocks from the body center, under
 *  the onchain 2.5); empty if none. */
export function collectIxs(
  p: TestPlayer,
  world: web3.PublicKey,
  b: V3,
  data: Buffer,
  now: number,
  feet: number[],
  o: Auth = {}
) {
  const chunk = chunkPda(world, ...chunkOfBlock(b));
  const r = 2.25 * 256;
  return groundItems(data, now)
    .filter(
      (g) =>
        (g.pos[0] - feet[0]) ** 2 +
          (g.pos[1] - feet[1] - 230) ** 2 +
          (g.pos[2] - feet[2]) ** 2 <=
        r * r
    )
    .map((g) => pickupIx(p, world, chunk, g.idx, o));
}

/** attack_player: `target` = the victim's Player PDA, listed in the presence of
 *  `chunk` (block-chunk coordinates). */
export async function attackPlayerIx(
  p: TestPlayer,
  world: web3.PublicKey,
  target: web3.PublicKey,
  cx: number,
  cz: number,
  o: Auth = {}
) {
  const chunk = chunkPda(world, cx, cz);
  return p.er.methods
    .attackPlayer(target)
    .accountsPartial({
      ...authOf(p, o),
      world,
      playerState: pstatePda(world, p.player),
      chunk,
      presence: presencePda(chunk),
      targetState: pstatePda(world, target),
    })
    .instruction();
}

/** leave_world from chunk `(cx, cz)` (the PlayerState's current chunk). */
export async function leaveWorldIx(
  p: TestPlayer,
  world: web3.PublicKey,
  cx: number,
  cz: number,
  o: Auth = {}
) {
  const chunk = chunkPda(world, cx, cz);
  return p.er.methods
    .leaveWorld()
    .accountsPartial({
      ...authOf(p, o),
      world,
      playerState: pstatePda(world, p.player),
      chunk,
      presence: presencePda(chunk),
    })
    .instruction();
}

export async function respawnIx(
  p: TestPlayer,
  world: web3.PublicKey,
  o: Auth = {}
) {
  return p.er.methods
    .respawn()
    .accountsPartial({
      ...authOf(p, o),
      world,
      playerState: pstatePda(world, p.player),
    })
    .instruction();
}

let uniqN = 0;
/** A ComputeBudget ix with a fresh limit: keeps otherwise identical ER txs
 *  distinct (the ER rejects byte-identical txs within a blockhash). */
export const uniq = () =>
  web3.ComputeBudgetProgram.setComputeUnitLimit({
    units: 400_000 + (uniqN++ % 100_000),
  });

export const ZOMBIE = 4;

/** Live mobs of kind `kind` in the chunks `keys` ("cx,cz"), with their chunk,
 *  slot index and FP feet position. */
export async function mobsIn(
  world: web3.PublicKey,
  keys: Iterable<string>,
  kind: number
) {
  const out: { chunk: string; idx: number; pos: V3; hp: number }[] = [];
  for (const k of keys) {
    const [cx, cz] = k.split(",").map(Number);
    const d = await chunkData(chunkPda(world, cx, cz));
    if (!d) continue;
    chunkMobs(d).forEach((m, idx) => {
      if (m.kind === kind) out.push({ chunk: k, idx, pos: m.pos, hp: m.hp });
    });
  }
  return out;
}
