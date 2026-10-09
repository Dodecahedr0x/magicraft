// PDA derivations mirroring `programs/magicraft/src/state.rs` seeds, the gpl_session token
// PDA and the crank task ids (`instructions/crank.rs`).
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha2";
import { PublicKey } from "@solana/web3.js";

export const PLAYER_SEED = "player";
export const WORLD_SEED = "world";
export const CHUNK_SEED = "chunk";
export const PRESENCE_SEED = "presence";
export const PSTATE_SEED = "pstate";

/** gpl_session program (session keys). */
export const GPL_SESSION = new PublicKey("KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5");
/** The Magic program's crank scheduler (`Crank1111…`). */
export const CRANK_PROGRAM = new PublicKey("Crank11111111111111111111111111111111111111");

const s = (v: string) => Buffer.from(v);
const i32le = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v);
  return b;
};
const u64le = (v: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};
const pda = (seeds: Uint8Array[], programId: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

/** `["player", authority]` (base layer, delegated). */
export const playerPda = (programId: PublicKey, authority: PublicKey) =>
  pda([s(PLAYER_SEED), authority.toBuffer()], programId);

/** `["world", creator wallet, nonce u64 LE]`. */
export const worldPda = (programId: PublicKey, creator: PublicKey, nonce: bigint | number) =>
  pda([s(WORLD_SEED), creator.toBuffer(), u64le(nonce)], programId);

/** `["chunk", world, cx i32 LE, cz i32 LE]`. */
export const chunkPda = (programId: PublicKey, world: PublicKey, cx: number, cz: number) =>
  pda([s(CHUNK_SEED), world.toBuffer(), i32le(cx), i32le(cz)], programId);

/** `["presence", chunk]`. */
export const presencePda = (programId: PublicKey, chunk: PublicKey) =>
  pda([s(PRESENCE_SEED), chunk.toBuffer()], programId);

/** `["pstate", world, player PDA]`. */
export const pstatePda = (programId: PublicKey, world: PublicKey, player: PublicKey) =>
  pda([s(PSTATE_SEED), world.toBuffer(), player.toBuffer()], programId);

/** gpl_session V2 token: `["session_token_v2", target_program, session_signer, authority]`. */
export const sessionTokenPda = (programId: PublicKey, signer: PublicKey, authority: PublicKey) =>
  pda(
    [s("session_token_v2"), programId.toBuffer(), signer.toBuffer(), authority.toBuffer()],
    GPL_SESSION,
  );

function taskId(tag: string, key: PublicKey, epoch: number): bigint {
  const h = sha256(Buffer.concat([s(tag), key.toBuffer(), Buffer.from([epoch & 0xff])]));
  const id = Buffer.from(h).readBigInt64LE(0) & 0x7fff_ffff_ffff_ffffn;
  return id === 0n ? 1n : id;
}

/** Day-crank task id: first 8 bytes (LE) of `sha256("day" ‖ world ‖ epoch u8)`, masked
 *  positive, non-zero (`World.day_epoch`; 0 at `create_world`). */
export const dayTaskId = (world: PublicKey, epoch = 0) => taskId("day", world, epoch);

/** Tick-crank task id: `sha256("tick" ‖ chunk ‖ epoch u8)` likewise (`ChunkHeader.task_epoch`). */
export const tickTaskId = (chunk: PublicKey, epoch = 0) => taskId("tick", chunk, epoch);

/** Chunk coordinate key used by client sets/maps. */
export const chunkKey = (cx: number, cz: number) => `${cx},${cz}`;
export const parseChunkKey = (k: string): [number, number] => {
  const [cx, cz] = k.split(",").map(Number);
  return [cx, cz];
};
