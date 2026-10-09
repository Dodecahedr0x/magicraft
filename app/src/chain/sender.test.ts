import { utils } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type SignatureStatus,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { ChunkNotReadyError } from "./actions";
import { ErSender, GEN_COMPUTE_UNITS, mapTxError, type SenderConnection, type TxFailure } from "./sender";

type Status = Pick<SignatureStatus, "err" | "confirmationStatus">;

/** In-memory ER: records sent txs; statuses come from `auto` (after `delayMs`) or `settle`. */
class MockEr {
  sent: { sig: string; tx: Transaction }[] = [];
  statuses = new Map<string, Status>();
  blockhashCalls = 0;
  blockhash = Keypair.generate().publicKey.toBase58();
  auto: ((i: number, tx: Transaction) => Status | "never") | null = () => ({ err: null, confirmationStatus: "confirmed" });
  delayMs = 5;
  sendError: Error | null = null;

  conn: SenderConnection = {
    getLatestBlockhash: (async () => {
      this.blockhashCalls++;
      return { blockhash: this.blockhash, lastValidBlockHeight: 100 };
    }) as SenderConnection["getLatestBlockhash"],
    sendRawTransaction: (async (raw: Buffer | Uint8Array) => {
      if (this.sendError) throw this.sendError;
      const tx = Transaction.from(raw);
      const sig = utils.bytes.bs58.encode(tx.signature!);
      if (this.sent.some((s) => s.sig === sig)) throw new Error("duplicate transaction");
      const i = this.sent.push({ sig, tx }) - 1;
      const st = this.auto?.(i, tx);
      if (st && st !== "never") setTimeout(() => this.statuses.set(sig, st), this.delayMs);
      return sig;
    }) as SenderConnection["sendRawTransaction"],
    getSignatureStatuses: (async (sigs: string[]) => ({
      context: { slot: 1 },
      value: sigs.map((s) => (this.statuses.get(s) as SignatureStatus) ?? null),
    })) as SenderConnection["getSignatureStatuses"],
    getTransaction: (async (sig: string) => ({ meta: { logMessages: [`Program log: ${sig.slice(0, 4)}`] } })) as never,
  };

  settle(i: number, st: Status = { err: null, confirmationStatus: "confirmed" }) {
    this.statuses.set(this.sent[i].sig, st);
  }
}

const memo = (n: number) =>
  new TransactionInstruction({
    programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    keys: [],
    data: Buffer.from([n]),
  });
const custom = (code: number, ix = 0) => ({ InstructionError: [ix, { Custom: code }] });
const until = async (f: () => boolean, ms = 1000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 2));
  }
};

function setup(opts: ConstructorParameters<typeof ErSender>[2] = {}) {
  const er = new MockEr();
  const kp = Keypair.generate();
  const errors: TxFailure[] = [];
  const s = new ErSender(er.conn, kp, { pollMs: 2, onError: (f) => errors.push(f), ...opts });
  return { er, kp, s, errors };
}

describe("ErSender", () => {
  it("signs with the session key as fee payer and confirms by polling", async () => {
    const { er, kp, s } = setup();
    const r = await s.send([memo(1)]);
    expect(r.status).toBe("confirmed");
    expect(er.sent).toHaveLength(1);
    const tx = er.sent[0].tx;
    expect(tx.feePayer!.equals(kp.publicKey)).toBe(true);
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.instructions).toHaveLength(1); // no compute budget by default
  });

  it("generation txs prepend a 1.4M compute-unit limit", async () => {
    const { er, s } = setup();
    await s.send([memo(1)], { gen: true });
    const ix0 = er.sent[0].tx.instructions[0];
    expect(ix0.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(ix0.data[0]).toBe(2); // SetComputeUnitLimit
    expect(ix0.data.readUInt32LE(1)).toBe(GEN_COMPUTE_UNITS);
    await s.send([memo(2)], { computeUnits: 300_000 });
    expect(er.sent[1].tx.instructions[0].data.readUInt32LE(1)).toBe(300_000);
  });

  it("maps program, session and runtime errors", async () => {
    const { er, s, errors } = setup();
    const codes = [6115, 6001, 6002, 6104, 6122, 6103, 6100, 2006, 9999, 6128, 6003, 6000];
    er.auto = (i) => ({ err: custom(codes[i], 1), confirmationStatus: "processed" });
    const res = [];
    for (const _ of codes) res.push(await s.send([memo(res.length)]));
    const fails = res.map((r) => (r.status === "failed" ? r.error : null));
    expect(fails.map((f) => [f?.code, f?.name, f?.kind])).toEqual([
      [6115, "MoveTooFast", "snapback"],
      [6001, "InvalidToken", "renewSession"],
      [6002, "NoToken", "renewSession"],
      [6104, "InsufficientSponsorFunds", "topup"],
      [6122, "Cooldown", "retry"],
      [6103, "ChunkNotReady", "notReady"],
      [6100, "Unauthorized", "other"],
      [2006, "ConstraintSeeds", "other"],
      [9999, undefined, "other"],
      [6128, "Dead", "dead"],
      [6003, "InvalidAuthority", "renewSession"],
      [6000, "ValidityTooLong", "renewSession"],
    ]);
    expect(fails[0]!.ixIndex).toBe(1);
    expect(errors).toHaveLength(codes.length);
    expect(mapTxError({ InstructionError: [0, "InvalidRealloc"] })).toMatchObject({ name: "InvalidRealloc", kind: "other" });
    expect(mapTxError("AccountNotFound").name).toBe("AccountNotFound");
  });

  it("decodes custom errors only for our program's ixs", async () => {
    const ours = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
    const { er, s } = setup({ programId: ours });
    er.auto = () => ({ err: custom(6001, 0), confirmationStatus: "processed" });
    const foreign = await s.send([ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }), memo(1)]);
    expect(foreign.status === "failed" && [foreign.error.name, foreign.error.kind, foreign.error.code]).toEqual([
      undefined,
      "other",
      6001,
    ]);
    er.auto = () => ({ err: custom(6001, 1), confirmationStatus: "processed" });
    const own = await s.send([ComputeBudgetProgram.setComputeUnitLimit({ units: 2 }), memo(1)]);
    expect(own.status === "failed" && own.error.name).toBe("InvalidToken");
  });

  it("a builder's ChunkNotReadyError is reported as notReady", async () => {
    const { er, s } = setup();
    const r = await s.send(() => {
      throw new ChunkNotReadyError(3, -4);
    }, { key: "move" });
    expect(r.status === "failed" && r.error.kind).toBe("notReady");
    expect(er.sent).toHaveLength(0);
  });

  it("keyed sends time out after laneTimeoutMs (may still land)", async () => {
    const { er, s } = setup({ laneTimeoutMs: 30, timeoutMs: 60_000 });
    er.auto = () => "never";
    const t0 = Date.now();
    const r = await s.send([memo(1)], { key: "move" });
    expect(r.status === "failed" && r.error.kind).toBe("timeout");
    expect(r.status === "failed" && r.error.message).toMatch(/may still land/);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("fetches logs on request", async () => {
    const { er, s } = setup();
    er.auto = () => ({ err: custom(6116), confirmationStatus: "processed" });
    const r = await s.send([memo(1)], { logs: true });
    expect(r.status === "failed" && r.error.logs?.[0]).toMatch(/^Program log: /);
  });

  it("latest-wins coalescing per key keeps order and drops stale requests", async () => {
    const { er, s } = setup();
    er.auto = () => "never"; // settle manually
    const built: number[] = [];
    const src = (n: number) => () => (built.push(n), [memo(n)]);
    const a = s.send(src(1), { key: "move" });
    await until(() => er.sent.length === 1);
    expect(s.busy("move")).toBe(true);
    const b = s.send(src(2), { key: "move" });
    const c = s.send(src(3), { key: "move" });
    const other = s.send(src(9), { key: "edit" }); // other keys are independent
    expect(await b).toEqual({ status: "superseded" });
    await until(() => er.sent.length === 2);
    expect(er.sent[1].tx.instructions[0].data[0]).toBe(9);
    er.settle(0);
    expect((await a).status).toBe("confirmed");
    await until(() => er.sent.length === 3);
    expect(er.sent[2].tx.instructions[0].data[0]).toBe(3); // newest, built only when sent
    expect(built).toEqual([1, 9, 3]);
    er.settle(1);
    er.settle(2);
    expect((await c).status).toBe("confirmed");
    expect((await other).status).toBe("confirmed");
    expect(s.busy("move")).toBe(false);
  });

  it("a failed in-flight tx still releases the lane", async () => {
    const { er, s } = setup();
    er.auto = (i) => (i === 0 ? { err: custom(6115), confirmationStatus: "processed" } : { err: null, confirmationStatus: "confirmed" });
    const a = s.send([memo(1)], { key: "move" });
    const b = s.send([memo(2)], { key: "move" });
    expect((await a).status).toBe("failed");
    expect((await b).status).toBe("confirmed");
  });

  it("keeps byte-identical txs distinct within a blockhash", async () => {
    const { er, s } = setup();
    const r = await Promise.all([s.send([memo(7)]), s.send([memo(7)]), s.send([memo(7)])]);
    expect(r.map((x) => x.status)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(new Set(er.sent.map((x) => x.sig)).size).toBe(3);
    const limits = er.sent.slice(1).map((x) => x.tx.instructions[0].data.readUInt32LE(1));
    expect(new Set(limits).size).toBe(2);
    // a new blockhash makes the plain tx valid again
    er.blockhash = Keypair.generate().publicKey.toBase58();
    s.invalidateBlockhash();
    await s.send([memo(7)]);
    expect(er.sent[3].tx.instructions).toHaveLength(1);
  });

  it("caches the blockhash", async () => {
    const { er, s } = setup();
    await Promise.all([s.send([memo(1)]), s.send([memo(2)]), s.send([memo(3)])]);
    await s.send([memo(4)]);
    expect(er.blockhashCalls).toBe(1);
  });

  it("times out, reports send errors, survives a builder throwing", async () => {
    const { er, s, errors } = setup();
    er.auto = () => "never";
    const t = await s.send([memo(1)], { timeoutMs: 20 });
    expect(t.status === "failed" && t.error.kind).toBe("timeout");

    er.sendError = new Error("Blockhash not found");
    const spy = vi.spyOn(s, "invalidateBlockhash");
    const f = await s.send([memo(2)], { key: "k" });
    expect(f.status === "failed" && f.error.kind).toBe("send");
    expect(spy).toHaveBeenCalled();
    expect(s.busy("k")).toBe(false);

    const b = await s.send(() => {
      throw new Error("no chunk");
    });
    expect(b.status === "failed" && b.error.message).toMatch(/no chunk/);
    expect(errors).toHaveLength(3);
  });
});
