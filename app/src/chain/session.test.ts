import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, wsFor } from "./config";
import {
  clearSession,
  createSessionIx,
  createSessionTx,
  decodeSessionToken,
  GPL_SESSION,
  loadSession,
  MAX_SESSION_SECS,
  newSession,
  revokeSessionIx,
  saveSession,
  SESSION_RENEW_MARGIN_SECS,
  verifySession,
  type KeyValueStore,
} from "./session";
import { sessionTokenPda } from "./pdas";

const pid = loadConfig().programId;
const wallet = Keypair.generate().publicKey;
const disc = (n: string) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);

class MemStore implements KeyValueStore {
  m = new Map<string, string>();
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
  removeItem = (k: string) => void this.m.delete(k);
}
const throwing: KeyValueStore = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceeded");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

afterEach(() => vi.useRealTimers());

describe("gpl_session ixs (port of tests/helpers/session.ts)", () => {
  it("create_session_v2 data and accounts", () => {
    const signer = Keypair.generate().publicKey;
    const ix = createSessionIx({ programId: pid, signer, authority: wallet, validUntil: 1_800_000_000 });
    expect(ix.programId.equals(GPL_SESSION)).toBe(true);
    // disc ‖ top_up: Some(false) ‖ valid_until: Some(i64) ‖ lamports: None
    const expected = Buffer.concat([disc("create_session_v2"), Buffer.from([1, 0, 1]), Buffer.alloc(8), Buffer.from([0])]);
    expected.writeBigInt64LE(1_800_000_000n, 11);
    expect(Buffer.from(ix.data).equals(expected)).toBe(true);
    expect(ix.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([
      [false, true],
      [true, true],
      [true, true],
      [true, false],
      [false, false],
      [false, false],
    ]);
    expect(ix.keys[0].pubkey.equals(sessionTokenPda(pid, signer, wallet))).toBe(true);
    const top = createSessionIx({ programId: pid, signer, authority: wallet, validUntil: 1, topUpLamports: 5 });
    expect([...top.data.subarray(8, 10)]).toEqual([1, 1]); // top_up: Some(true)
    expect(top.data.readBigUInt64LE(top.data.length - 8)).toBe(5n);
  });

  it("revoke_session_v2", () => {
    const token = Keypair.generate().publicKey;
    const ix = revokeSessionIx(token, wallet);
    expect(Buffer.from(ix.data).equals(disc("revoke_session_v2"))).toBe(true);
    expect(ix.keys[2]).toMatchObject({ isSigner: true, isWritable: false });
    expect(ix.keys[2].pubkey.equals(wallet)).toBe(true);
  });

  it("validity is clamped to ≤ 7 days", () => {
    const now = Math.floor(Date.now() / 1000);
    const { session, ix } = newSession(pid, wallet, 30 * 24 * 3600);
    expect(session.validUntil).toBeLessThanOrEqual(now + MAX_SESSION_SECS);
    expect(Number(ix.data.readBigInt64LE(11))).toBe(session.validUntil);
    expect(session.token.equals(sessionTokenPda(pid, session.kp.publicKey, wallet))).toBe(true);
  });

  it("createSessionTx is partially signed by the session key only", async () => {
    const conn = { getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }) };
    const { tx, session } = await createSessionTx(conn as never, pid, wallet);
    expect(tx.feePayer!.equals(wallet)).toBe(true);
    const sigs = tx.signatures.map((s) => [s.publicKey.toBase58(), !!s.signature]);
    expect(sigs).toContainEqual([session.kp.publicKey.toBase58(), true]);
    expect(sigs).toContainEqual([wallet.toBase58(), false]);
  });

  it("decodes SessionTokenV2 and verifies it", async () => {
    const { session } = newSession(pid, wallet);
    const d = Buffer.alloc(144);
    d.set(wallet.toBuffer(), 8);
    d.set(pid.toBuffer(), 40);
    d.set(session.kp.publicKey.toBuffer(), 72);
    d.set(wallet.toBuffer(), 104);
    d.writeBigInt64LE(BigInt(session.validUntil), 136);
    const t = decodeSessionToken(d);
    expect(t.sessionSigner.equals(session.kp.publicKey) && t.targetProgram.equals(pid)).toBe(true);
    expect(t.validUntil).toBe(session.validUntil);
    const conn = (owner: PublicKey, data: Buffer) => ({ getAccountInfo: async () => ({ owner, data }) });
    expect(await verifySession(conn(GPL_SESSION, d) as never, session)).toBe(true);
    expect(await verifySession(conn(pid, d) as never, session)).toBe(false);
    const other = Buffer.from(d);
    other.set(Keypair.generate().publicKey.toBuffer(), 72);
    expect(await verifySession(conn(GPL_SESSION, other) as never, session)).toBe(false);
    expect(await verifySession({ getAccountInfo: async () => null } as never, session)).toBe(false);
  });
});

describe("session persistence", () => {
  it("round-trips through storage", () => {
    const store = new MemStore();
    const { session } = newSession(pid, wallet);
    expect(saveSession(store, session)).toBe(true);
    const back = loadSession(store, pid, wallet)!;
    expect(back.kp.publicKey.equals(session.kp.publicKey)).toBe(true);
    expect(Buffer.from(back.kp.secretKey).equals(Buffer.from(session.kp.secretKey))).toBe(true);
    expect(back.token.equals(session.token)).toBe(true);
    expect(back.validUntil).toBe(session.validUntil);
    // other wallet / program: nothing
    expect(loadSession(store, pid, Keypair.generate().publicKey)).toBeNull();
    clearSession(store, pid, wallet);
    expect(loadSession(store, pid, wallet)).toBeNull();
  });

  it("drops expiring and corrupt entries", () => {
    const store = new MemStore();
    const { session } = newSession(pid, wallet, 3600);
    saveSession(store, session);
    vi.useFakeTimers();
    vi.setSystemTime((session.validUntil - SESSION_RENEW_MARGIN_SECS + 1) * 1000);
    expect(loadSession(store, pid, wallet)).toBeNull();
    expect(store.m.size).toBe(0);
    vi.useRealTimers();
    for (const junk of ["{", '{"v":1,"secret":"AAAA","token":"x","validUntil":9999999999}', "null"]) {
      saveSession(store, session);
      const k = [...store.m.keys()][0];
      store.m.set(k, junk);
      expect(loadSession(store, pid, wallet)).toBeNull();
    }
  });

  it("tolerates missing or throwing storage", () => {
    const { session } = newSession(pid, wallet);
    expect(saveSession(null, session)).toBe(false);
    expect(saveSession(throwing, session)).toBe(false);
    expect(loadSession(null, pid, wallet)).toBeNull();
    expect(loadSession(throwing, pid, wallet)).toBeNull();
    expect(() => clearSession(throwing, pid, wallet)).not.toThrow();
  });
});

describe("config", () => {
  it("defaults to the local stack", () => {
    const c = loadConfig();
    expect(c.baseRpc).toBe("http://127.0.0.1:8799");
    expect(c.baseWs).toBe("ws://127.0.0.1:8800");
    expect(c.erWs).toBe("ws://127.0.0.1:7800");
  });
  it("reads env overrides and derives websockets", () => {
    const k = Keypair.generate().publicKey.toBase58();
    const c = loadConfig({
      VITE_BASE_RPC: "https://api.devnet.solana.com",
      VITE_ER_RPC: "https://devnet.magicblock.app:8899/",
      VITE_PROGRAM_ID: k,
      VITE_ER_VALIDATOR: k,
      VITE_VRF_QUEUE: " ",
    });
    expect(c.baseWs).toBe("wss://api.devnet.solana.com");
    expect(c.erWs).toBe("wss://devnet.magicblock.app:8900");
    expect(c.programId.toBase58()).toBe(k);
    expect(c.erValidator.toBase58()).toBe(k);
    expect(() => loadConfig({ VITE_PROGRAM_ID: "nope" })).toThrow(/VITE_PROGRAM_ID/);
    expect(wsFor("http://localhost:7799")).toBe("ws://localhost:7800");
  });
});
