// Hand-built gpl_session (session keys) client: no @magicblock-labs/gum-sdk
// dependency (it pulls @coral-xyz/anchor 0.30, axios, graphql). V2 tokens only.
import { createHash } from "crypto";
import { web3 } from "@anchor-lang/core";

export const GPL_SESSION = new web3.PublicKey(
  "KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5"
);

/** session_keys::SessionError numbers as seen from our program (not in our IDL). */
export const SESSION_ERRORS: Record<number, string> = {
  6000: "ValidityTooLong",
  6001: "InvalidToken",
  6002: "NoToken",
  6003: "InvalidAuthority",
};

const disc = (name: string) =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

const SYSTEM = {
  pubkey: web3.SystemProgram.programId,
  isSigner: false,
  isWritable: false,
};

function optBool(v?: boolean): Buffer {
  return v === undefined ? Buffer.from([0]) : Buffer.from([1, v ? 1 : 0]);
}
function optI64(v?: number | bigint): Buffer {
  if (v === undefined) return Buffer.from([0]);
  const b = Buffer.alloc(9);
  b[0] = 1;
  b.writeBigInt64LE(BigInt(v), 1);
  return b;
}
function optU64(v?: number | bigint): Buffer {
  if (v === undefined) return Buffer.from([0]);
  const b = Buffer.alloc(9);
  b[0] = 1;
  b.writeBigUInt64LE(BigInt(v), 1);
  return b;
}

/** Seeds ["session_token_v2", target_program, session_signer, authority]. */
export function sessionTokenPda(
  programId: web3.PublicKey,
  signer: web3.PublicKey,
  authority: web3.PublicKey
): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("session_token_v2"),
      programId.toBuffer(),
      signer.toBuffer(),
      authority.toBuffer(),
    ],
    GPL_SESSION
  )[0];
}

/** gpl_session `create_session_v2(top_up, valid_until, lamports)`. Signers:
 *  session signer, fee payer (default: authority), authority. */
export function createSessionIx(o: {
  programId: web3.PublicKey;
  signer: web3.PublicKey;
  authority: web3.PublicKey;
  validUntil: number;
  topUpLamports?: number;
  feePayer?: web3.PublicKey;
}): web3.TransactionInstruction {
  const feePayer = o.feePayer ?? o.authority;
  return new web3.TransactionInstruction({
    programId: GPL_SESSION,
    keys: [
      {
        pubkey: sessionTokenPda(o.programId, o.signer, o.authority),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: o.signer, isSigner: true, isWritable: true },
      { pubkey: feePayer, isSigner: true, isWritable: true },
      { pubkey: o.authority, isSigner: true, isWritable: false },
      { pubkey: o.programId, isSigner: false, isWritable: false },
      SYSTEM,
    ],
    data: Buffer.concat([
      disc("create_session_v2"),
      optBool(o.topUpLamports !== undefined),
      optI64(o.validUntil),
      optU64(o.topUpLamports),
    ]),
  });
}

/** gpl_session `revoke_session_v2`. Rent goes to the token's recorded fee payer
 *  (default: authority); the authority must sign while the token is active. */
export function revokeSessionIx(
  token: web3.PublicKey,
  authority: web3.PublicKey,
  feePayer: web3.PublicKey = authority
): web3.TransactionInstruction {
  return new web3.TransactionInstruction({
    programId: GPL_SESSION,
    keys: [
      { pubkey: token, isSigner: false, isWritable: true },
      { pubkey: feePayer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      SYSTEM,
    ],
    data: disc("revoke_session_v2"),
  });
}
