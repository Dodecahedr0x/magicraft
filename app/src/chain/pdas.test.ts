import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import {
  chunkPda,
  dayTaskId,
  GPL_SESSION,
  playerPda,
  presencePda,
  pstatePda,
  sessionTokenPda,
  tickTaskId,
  worldPda,
} from "./pdas";
import { makeProgram } from "./program";

const cfg = loadConfig();
const pid = cfg.programId;
const program = makeProgram(cfg, new Connection("http://127.0.0.1:1"));

/** Independent re-implementation (node crypto, as in tests/helpers). */
function refTaskId(tag: string, key: PublicKey, epoch: number) {
  const h = createHash("sha256").update(tag).update(key.toBuffer()).update(Buffer.from([epoch])).digest();
  const id = h.readBigInt64LE(0) & 0x7fff_ffff_ffff_ffffn;
  return id === 0n ? 1n : id;
}

describe("pdas", () => {
  const wallet = Keypair.generate().publicKey;

  it("player PDA matches the IDL's seeds (Anchor resolver)", async () => {
    const ix = await program.methods.initPlayer().accounts({ authority: wallet }).instruction();
    expect(ix.keys[1].pubkey.equals(playerPda(pid, wallet))).toBe(true);
  });

  it("seeds", () => {
    const world = worldPda(pid, wallet, 42n);
    const nonce = Buffer.alloc(8);
    nonce.writeBigUInt64LE(42n);
    expect(world.equals(PublicKey.findProgramAddressSync([Buffer.from("world"), wallet.toBuffer(), nonce], pid)[0])).toBe(true);
    expect(worldPda(pid, wallet, 42).equals(world)).toBe(true);

    const c = Buffer.alloc(8);
    c.writeInt32LE(-1, 0);
    c.writeInt32LE(5, 4);
    const chunk = chunkPda(pid, world, -1, 5);
    expect(
      chunk.equals(
        PublicKey.findProgramAddressSync([Buffer.from("chunk"), world.toBuffer(), c.subarray(0, 4), c.subarray(4)], pid)[0],
      ),
    ).toBe(true);
    expect(presencePda(pid, chunk).equals(PublicKey.findProgramAddressSync([Buffer.from("presence"), chunk.toBuffer()], pid)[0])).toBe(true);
    const player = playerPda(pid, wallet);
    expect(
      pstatePda(pid, world, player).equals(
        PublicKey.findProgramAddressSync([Buffer.from("pstate"), world.toBuffer(), player.toBuffer()], pid)[0],
      ),
    ).toBe(true);
    const signer = Keypair.generate().publicKey;
    expect(
      sessionTokenPda(pid, signer, wallet).equals(
        PublicKey.findProgramAddressSync(
          [Buffer.from("session_token_v2"), pid.toBuffer(), signer.toBuffer(), wallet.toBuffer()],
          GPL_SESSION,
        )[0],
      ),
    ).toBe(true);
  });

  it("task ids (sha256 tag ‖ key ‖ epoch, masked positive)", () => {
    for (let i = 0; i < 20; i++) {
      const k = Keypair.generate().publicKey;
      for (const epoch of [0, 1, 255]) {
        expect(dayTaskId(k, epoch)).toBe(refTaskId("day", k, epoch));
        expect(tickTaskId(k, epoch)).toBe(refTaskId("tick", k, epoch));
        expect(tickTaskId(k, epoch) > 0n).toBe(true);
      }
    }
  });
});
