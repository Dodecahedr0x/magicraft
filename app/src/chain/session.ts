// Session keys: hand-built gpl_session V2 client (ported from tests/helpers/session.ts; no
// gum SDK, which pulls @coral-xyz/anchor 0.30) + a localStorage-backed key manager.
//
// Flow: `createSessionTx` → the wallet signs (authority + fee payer; the session keypair has
// already partially signed) and sends it on the base layer → `saveSession`. The session key
// signs and pays every ER gameplay tx with 0 lamports (ER fees are 0), so no top-up is
// requested. Tokens are plain base-layer accounts that don't reference the Player, so they
// can be created / revoked while the Player is delegated; revocation is seen by the ER at once.
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha2";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Connection,
} from "@solana/web3.js";
import { GPL_SESSION, sessionTokenPda } from "./pdas";

export { GPL_SESSION, sessionTokenPda };
export { SESSION_ERRORS } from "./program";

/** gpl_session rejects `valid_until` beyond now + 7 days (`ValidityTooLong`, 6000). */
export const MAX_SESSION_SECS = 7 * 24 * 3600;
/** Default validity: 7 days minus a margin for clock skew between client and chain. */
export const DEFAULT_SESSION_SECS = MAX_SESSION_SECS - 600;
/** A stored session closer than this to expiry is treated as expired (renew instead). */
export const SESSION_RENEW_MARGIN_SECS = 300;

const disc = (name: string) => Buffer.from(sha256(Buffer.from(`global:${name}`))).subarray(0, 8);

const SYSTEM = { pubkey: SystemProgram.programId, isSigner: false, isWritable: false };

const optBool = (v?: boolean) => (v === undefined ? Buffer.from([0]) : Buffer.from([1, v ? 1 : 0]));
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

/** gpl_session `create_session_v2(top_up, valid_until, lamports)`. Signers: session
 *  signer, fee payer (default: authority), authority. */
export function createSessionIx(o: {
  programId: PublicKey;
  signer: PublicKey;
  authority: PublicKey;
  validUntil: number;
  topUpLamports?: number;
  feePayer?: PublicKey;
}): TransactionInstruction {
  const feePayer = o.feePayer ?? o.authority;
  return new TransactionInstruction({
    programId: GPL_SESSION,
    keys: [
      { pubkey: sessionTokenPda(o.programId, o.signer, o.authority), isSigner: false, isWritable: true },
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

/** gpl_session `revoke_session_v2`. Rent goes to the token's recorded fee payer (default:
 *  authority); the authority must sign while the token is active. */
export function revokeSessionIx(
  token: PublicKey,
  authority: PublicKey,
  feePayer: PublicKey = authority,
): TransactionInstruction {
  return new TransactionInstruction({
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

/** `SessionTokenV2` account (144 B): authority @8, target_program @40, session_signer @72,
 *  fee_payer @104, valid_until i64 @136. */
export type SessionTokenAccount = {
  authority: PublicKey;
  targetProgram: PublicKey;
  sessionSigner: PublicKey;
  feePayer: PublicKey;
  validUntil: number;
};

export function decodeSessionToken(d: Uint8Array): SessionTokenAccount {
  if (d.length < 144) throw new Error(`session token: ${d.length} bytes`);
  const b = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
  return {
    authority: new PublicKey(b.subarray(8, 40)),
    targetProgram: new PublicKey(b.subarray(40, 72)),
    sessionSigner: new PublicKey(b.subarray(72, 104)),
    feePayer: new PublicKey(b.subarray(104, 136)),
    validUntil: Number(b.readBigInt64LE(136)),
  };
}

/** A session key (0 lamports) and its token for a Player's wallet. */
export type Session = {
  kp: Keypair;
  token: PublicKey;
  authority: PublicKey;
  programId: PublicKey;
  /** Unix seconds. */
  validUntil: number;
};

/** The `signer` / `sessionToken` accounts of a session-authed ix builder. */
export const sessionAccounts = (s: Pick<Session, "kp" | "token">) => ({
  signer: s.kp.publicKey,
  sessionToken: s.token,
});

const nowSecs = () => Math.floor(Date.now() / 1000);

/** A fresh session keypair + its `create_session_v2` ix (validity clamped to ≤ 7 days). */
export function newSession(
  programId: PublicKey,
  authority: PublicKey,
  validSecs = DEFAULT_SESSION_SECS,
): { session: Session; ix: TransactionInstruction } {
  const kp = Keypair.generate();
  const validUntil = nowSecs() + Math.max(60, Math.min(validSecs, MAX_SESSION_SECS - 60));
  const session: Session = {
    kp,
    token: sessionTokenPda(programId, kp.publicKey, authority),
    authority,
    programId,
    validUntil,
  };
  return {
    session,
    ix: createSessionIx({ programId, signer: kp.publicKey, authority, validUntil }),
  };
}

/** Base-layer tx creating a session for `authority` (the wallet pays the token rent and
 *  the fee). Already partially signed by the session key: the wallet signs and sends it,
 *  then call `saveSession`. */
export async function createSessionTx(
  base: Connection,
  programId: PublicKey,
  authority: PublicKey,
  validSecs = DEFAULT_SESSION_SECS,
): Promise<{ tx: Transaction; session: Session }> {
  const { session, ix } = newSession(programId, authority, validSecs);
  const tx = new Transaction().add(ix);
  tx.feePayer = authority;
  tx.recentBlockhash = (await base.getLatestBlockhash("confirmed")).blockhash;
  tx.partialSign(session.kp);
  return { tx, session };
}

/** Base-layer tx revoking `s` (wallet-signed; rent returns to the wallet). */
export async function revokeSessionTx(base: Connection, s: Session): Promise<Transaction> {
  const tx = new Transaction().add(revokeSessionIx(s.token, s.authority));
  tx.feePayer = s.authority;
  tx.recentBlockhash = (await base.getLatestBlockhash("confirmed")).blockhash;
  return tx;
}

/** True if the token exists on the base layer and matches `s` (signer, authority, program,
 *  not expiring within the renew margin). */
export async function verifySession(base: Connection, s: Session): Promise<boolean> {
  const info = await base.getAccountInfo(s.token, "confirmed");
  if (!info || !info.owner.equals(GPL_SESSION)) return false;
  try {
    const t = decodeSessionToken(info.data);
    return (
      t.sessionSigner.equals(s.kp.publicKey) &&
      t.authority.equals(s.authority) &&
      t.targetProgram.equals(s.programId) &&
      t.validUntil > nowSecs() + SESSION_RENEW_MARGIN_SECS
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- persistence

/** The subset of `Storage` used (inject a fake in tests). */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** `window.localStorage`, or null where it is missing or throws (private mode, SSR). */
export function browserStorage(): KeyValueStore | null {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const k = "__magicraft_probe";
    s.setItem(k, "1");
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}

const storageKey = (programId: PublicKey, authority: PublicKey) =>
  `magicraft.session.${programId.toBase58()}.${authority.toBase58()}`;

type Stored = { v: 1; secret: string; token: string; validUntil: number };

/** Persists `s` (session secret key in plain localStorage: it can only act as this player
 *  in this program until expiry/revocation). Returns false if storage is unavailable. */
export function saveSession(store: KeyValueStore | null, s: Session): boolean {
  if (!store) return false;
  try {
    const v: Stored = {
      v: 1,
      secret: Buffer.from(s.kp.secretKey).toString("base64"),
      token: s.token.toBase58(),
      validUntil: s.validUntil,
    };
    store.setItem(storageKey(s.programId, s.authority), JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
}

/** The stored session of `authority`, or null if absent, corrupt, mismatched or expiring
 *  within the renew margin (an unusable entry is removed). Check it onchain with
 *  `verifySession` before relying on it. */
export function loadSession(
  store: KeyValueStore | null,
  programId: PublicKey,
  authority: PublicKey,
): Session | null {
  if (!store) return null;
  const key = storageKey(programId, authority);
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Stored;
    const kp = Keypair.fromSecretKey(Buffer.from(v.secret, "base64"));
    const token = sessionTokenPda(programId, kp.publicKey, authority);
    if (v.v !== 1 || token.toBase58() !== v.token || !(v.validUntil > nowSecs() + SESSION_RENEW_MARGIN_SECS)) {
      store.removeItem(key);
      return null;
    }
    return { kp, token, authority, programId, validUntil: v.validUntil };
  } catch {
    try {
      store.removeItem(key);
    } catch {
      /* storage unavailable */
    }
    return null;
  }
}

export function clearSession(store: KeyValueStore | null, programId: PublicKey, authority: PublicKey) {
  try {
    store?.removeItem(storageKey(programId, authority));
  } catch {
    /* storage unavailable */
  }
}
