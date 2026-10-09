// Task 5 spike: MagicBlock VRF requested inside the ER (callback writes into an
// EPHEMERAL chunk) and gpl_session session keys used on the ER.
// spike_* instructions are temporary (removed in Task 6).
import { randomBytes } from "crypto";
import { expect } from "chai";
import { web3 } from "@anchor-lang/core";
import { baseConn, erConn, erProgramFor, sendEr, TxError } from "./helpers/env";
import {
  createSessionIx,
  ER_TEST_QUEUE,
  GPL_SESSION,
  revokeSessionIx,
  sessionTokenPda,
} from "./helpers/session";
import { setupPlayer, sleep, SpikePlayer, until } from "./helpers/spike";

const VRF_OFFSET = 16;
const PING_OFFSET = 8;

async function chunkData(chunk: web3.PublicKey): Promise<Buffer> {
  return (await erConn.getAccountInfo(chunk, "confirmed"))!.data;
}
const vrfBytes = async (chunk: web3.PublicKey) =>
  (await chunkData(chunk)).subarray(VRF_OFFSET, VRF_OFFSET + 32);
const pings = async (chunk: web3.PublicKey) =>
  Number((await chunkData(chunk)).readBigUInt64LE(PING_OFFSET));
const erLamports = async (pk: web3.PublicKey) =>
  (await erConn.getAccountInfo(pk, "confirmed"))?.lamports ?? 0;

async function expectTxError(p: Promise<unknown>): Promise<TxError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TxError) return e;
    throw e;
  }
  throw new Error("expected the transaction to fail");
}

async function sendBase(
  ixs: web3.TransactionInstruction[],
  signers: web3.Keypair[]
): Promise<string> {
  return web3.sendAndConfirmTransaction(
    baseConn,
    new web3.Transaction().add(...ixs),
    signers,
    { commitment: "confirmed" }
  );
}

async function baseNow(): Promise<number> {
  return (await baseConn.getBlockTime(await baseConn.getSlot()))!;
}

/** Create a session token on the base layer for `p`'s wallet. */
async function createSession(
  p: SpikePlayer,
  validForSecs: number,
  topUpLamports?: number
): Promise<{ kp: web3.Keypair; token: web3.PublicKey }> {
  const kp = web3.Keypair.generate();
  await sendBase(
    [
      createSessionIx({
        programId: p.base.programId,
        signer: kp.publicKey,
        authority: p.authority.publicKey,
        validUntil: (await baseNow()) + validForSecs,
        topUpLamports,
      }),
    ],
    [p.authority, kp]
  );
  return {
    kp,
    token: sessionTokenPda(
      p.base.programId,
      kp.publicKey,
      p.authority.publicKey
    ),
  };
}

/** spike_session_ping signed (and fee-paid) by `signer`. */
async function ping(
  p: SpikePlayer,
  signer: web3.Keypair,
  sessionToken: web3.PublicKey | null,
  feePayer: web3.Keypair = signer
): Promise<string> {
  const ix = await erProgramFor(signer)
    .methods.spikeSessionPing(0, 0)
    .accountsPartial({
      signer: signer.publicKey,
      player: p.player,
      sessionToken,
      chunk: p.chunk,
    })
    .instruction();
  const signers = feePayer === signer ? [signer] : [feePayer, signer];
  return sendEr([ix], signers);
}

// ---------- VRF ----------

describe("spike: VRF inside the ER", () => {
  let p: SpikePlayer;

  before(async () => {
    p = await setupPlayer({ depositSol: 0.05, chunk: true });
  });

  async function requestVrf(payerMode: number): Promise<string> {
    const ix = await p.er.methods
      .spikeVrf(0, 0, [...randomBytes(32)], payerMode)
      .accounts({
        authority: p.authority.publicKey,
        oracleQueue: ER_TEST_QUEUE,
      })
      .instruction();
    return sendEr([ix], [p.authority]);
  }

  it("wallet-paid request on the ER: callback writes 32 random bytes into the ephemeral chunk", async () => {
    expect((await vrfBytes(p.chunk)).every((b) => b === 0)).to.equal(true);
    const wallet0 = await erLamports(p.authority.publicKey);
    const player0 = await erLamports(p.player);
    const t0 = Date.now();
    const sig = await requestVrf(0);
    const got = await until(
      async () => (await vrfBytes(p.chunk)).some((b) => b !== 0),
      10_000
    );
    const ms = Date.now() - t0;
    console.log(`      request ${sig}`);
    console.log(
      `      callback landed: ${got} after ${ms} ms; bytes ${(
        await vrfBytes(p.chunk)
      ).toString("hex")}`
    );
    console.log(
      `      ER lamport deltas: wallet ${
        (await erLamports(p.authority.publicKey)) - wallet0
      }, player ${(await erLamports(p.player)) - player0}`
    );
    expect(got, "VRF callback did not land within 10 s").to.equal(true);
  });

  it("Player-PDA-paid request on the ER (invoke_signed with Player seeds) also fulfils", async () => {
    // The ephemeral queues are fee-exempt, so the VRF program only checks that
    // the payer signed: a delegated, data-carrying PDA works.
    const before = Buffer.from(await vrfBytes(p.chunk));
    const player0 = await erLamports(p.player);
    const t0 = Date.now();
    await requestVrf(1);
    const got = await until(
      async () => !(await vrfBytes(p.chunk)).equals(before),
      10_000
    );
    console.log(
      `      callback landed: ${got} after ${
        Date.now() - t0
      } ms; player ER delta ${(await erLamports(p.player)) - player0}`
    );
    expect(got, "VRF callback did not land within 10 s").to.equal(true);
    expect(await erLamports(p.player)).to.equal(player0);
  });

  it("callback signed by a non-VRF key is rejected (#[vrf_callback] identity check)", async () => {
    const fake = web3.Keypair.generate();
    const ix = await erProgramFor(fake)
      .methods.spikeVrfCallback([...Buffer.alloc(32, 7)])
      .accountsPartial({ vrfProgramIdentity: fake.publicKey, chunk: p.chunk })
      .instruction();
    const err = await expectTxError(sendEr([ix], [p.authority, fake]));
    console.log(`      forged callback: ${err.code} (${err.number})`);
    expect(err.code).to.equal("ConstraintAddress");
  });
});

// ---------- Session keys ----------

describe("spike: session keys on the ER", () => {
  let p: SpikePlayer;
  let s: { kp: web3.Keypair; token: web3.PublicKey };

  before(async () => {
    p = await setupPlayer({ depositSol: 0.05, chunk: true });
    s = await createSession(p, 3600, 10_000_000);
  });

  it("SessionToken created on base is visible on the ER", async () => {
    const base = await baseConn.getAccountInfo(s.token);
    expect(base?.owner.toBase58()).to.equal(GPL_SESSION.toBase58());
    const er = await erConn.getAccountInfo(s.token);
    console.log(
      `      ER getAccountInfo(token): ${
        er ? `owner ${er.owner.toBase58()}, ${er.data.length} B` : "null"
      }`
    );
    expect(er?.owner.toBase58()).to.equal(GPL_SESSION.toBase58());
    expect(er?.data.equals(base!.data)).to.equal(true);
    console.log(
      `      session signer lamports base ${await baseConn.getBalance(
        s.kp.publicKey
      )}, ER ${await erLamports(s.kp.publicKey)}`
    );
  });

  it("session key signs spike_session_ping on the ER (and pays the fee)", async () => {
    const lam0 = await erLamports(s.kp.publicKey);
    await ping(p, s.kp, s.token);
    expect(await pings(p.chunk)).to.equal(1);
    // ER txs are free in this release: the fee payer is not charged.
    expect(await erLamports(s.kp.publicKey)).to.equal(lam0);
  });

  it("wallet signs without a token", async () => {
    await ping(p, p.authority, null);
    expect(await pings(p.chunk)).to.equal(2);
  });

  it("random keypair without a token is rejected", async () => {
    const rnd = web3.Keypair.generate();
    const err = await expectTxError(ping(p, rnd, null, p.authority));
    console.log(`      ${err.code} (${err.number})`);
    expect(err.code).to.equal("NotPlayerAuthority");
  });

  it("random keypair presenting someone else's token is rejected", async () => {
    const rnd = web3.Keypair.generate();
    const err = await expectTxError(ping(p, rnd, s.token, p.authority));
    console.log(`      ${err.code} (${err.number})`);
    expect(err.code).to.equal("InvalidToken");
  });

  it("expired token is rejected", async () => {
    const old = await createSession(p, -60);
    const err = await expectTxError(ping(p, old.kp, old.token, p.authority));
    console.log(`      ${err.code} (${err.number})`);
    expect(err.code).to.equal("InvalidToken");
  });

  it("short-lived token stops working on the ER after valid_until", async () => {
    const short = await createSession(p, 4);
    const t0 = Date.now();
    await ping(p, short.kp, short.token, p.authority);
    let err: TxError | undefined;
    while (!err && Date.now() - t0 < 20_000) {
      await sleep(500);
      try {
        await ping(p, short.kp, short.token, p.authority);
      } catch (e) {
        if (!(e instanceof TxError)) throw e;
        err = e;
      }
    }
    console.log(
      `      first rejection after ${Date.now() - t0} ms: ${err?.code}`
    );
    expect(err?.code).to.equal("InvalidToken");
  });

  it("session signer with 0 lamports (no top-up) can be the ER fee payer", async () => {
    const zero = await createSession(p, 3600); // no top-up
    expect(await baseConn.getBalance(zero.kp.publicKey)).to.equal(0);
    const n = await pings(p.chunk);
    await ping(p, zero.kp, zero.token);
    expect(await pings(p.chunk)).to.equal(n + 1);
  });

  it("revoking the token on base (Player still delegated) stops it on the ER", async () => {
    const r = await createSession(p, 3600, 1_000_000);
    await ping(p, r.kp, r.token);
    await sendBase(
      [revokeSessionIx(r.token, p.authority.publicKey)],
      [p.authority]
    );
    expect(await baseConn.getAccountInfo(r.token)).to.equal(null);
    const t0 = Date.now();
    let err: TxError | undefined;
    while (!err && Date.now() - t0 < 10_000) {
      try {
        await ping(p, r.kp, r.token);
      } catch (e) {
        if (!(e instanceof TxError)) throw e;
        err = e;
      }
      if (!err) await sleep(200);
    }
    console.log(
      `      after revoke: first ER rejection after ${Date.now() - t0} ms: ${
        err?.code ?? err?.message
      }`
    );
    expect(err?.code).to.equal("AccountNotInitialized");
  });
});
