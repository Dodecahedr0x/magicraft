// ER transaction sender: signs with the session keypair (which is also the fee payer; it
// needs 0 lamports on the ER), sends without preflight, and confirms by polling
// `getSignatureStatuses` in one shared loop (not `confirmTransaction`: some failures, e.g.
// InvalidRealloc, otherwise surface only at blockhash expiry, ~30 s).
//
// - Fire-and-forget: `send` never rejects; it resolves to a `SendResult`.
// - Latest-wins coalescing per `key` (e.g. "move"): at most one tx per key is in flight
//   (sent, not yet confirmed/failed); while it is, only the newest request waits and older
//   waiting ones resolve `superseded`. Ordering per key is therefore preserved.
// - Program errors are mapped to names (IDL 6100+, session 6000–6003, Anchor framework)
//   and a coarse `kind` the UI acts on (snap back, top-up prompt, silent retry, renew
//   session). `onError` sees every failure.
// - Generation txs (`gen: true`) prepend `setComputeUnitLimit(1_400_000)`.
// - The ER rejects byte-identical txs within one blockhash: a tx whose signature was
//   already sent under the same blockhash gets a distinct compute-unit limit and is re-signed.
import { utils } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Transaction,
  type Connection,
  type Keypair,
  type TransactionInstruction,
  type TransactionError,
} from "@solana/web3.js";
import { PROGRAM_ERRORS } from "./program";

export const GEN_COMPUTE_UNITS = 1_400_000;

export type SenderConnection = Pick<
  Connection,
  "getLatestBlockhash" | "sendRawTransaction" | "getSignatureStatuses" | "getTransaction"
>;

/** What the client should do about a failure. */
export type ErrorKind =
  | "snapback" // rejected move: snap to the onchain PlayerState
  | "topup" // the Player can't sponsor rent: prompt a top-up
  | "retry" // cooldown: retry silently later
  | "renewSession" // session token missing/invalid: create a new session
  | "notReady" // chunk not generated yet
  | "timeout" // not confirmed in time (may still land)
  | "send" // the RPC refused the tx (network, blockhash, …)
  | "other";

export type TxFailure = {
  kind: ErrorKind;
  /** Program error number, if the failure is a custom program error. */
  code?: number;
  /** Error name (`MoveTooFast`, `InvalidToken`, `ConstraintSeeds`, `InvalidRealloc`, …). */
  name?: string;
  message: string;
  /** Index of the failing ix in the sent tx (compute-budget ixs included). */
  ixIndex?: number;
  raw?: unknown;
  logs?: string[];
};

export type SendResult =
  | { status: "confirmed"; sig: string; ms: number }
  | { status: "failed"; sig?: string; error: TxFailure }
  | { status: "superseded" };

export type SendOptions = {
  /** Coalescing key (latest wins); omit for independent txs. */
  key?: string;
  /** Prepend `setComputeUnitLimit(1_400_000)` (generation txs). */
  gen?: boolean;
  /** Prepend `setComputeUnitLimit(units)` (overrides `gen`). */
  computeUnits?: number;
  /** Extra signers after the session key. */
  signers?: Keypair[];
  /** Fetch the failing tx's logs into `TxFailure.logs` (one extra RPC round trip or more). */
  logs?: boolean;
  timeoutMs?: number;
};

export type Ixs = TransactionInstruction[];
/** Ixs, or a builder called right before sending (so a coalesced move uses fresh data). */
export type IxSource = Ixs | (() => Ixs | Promise<Ixs>);

const SNAPBACK = new Set(["MoveTooFast", "Collision", "NotOnGround", "Flying", "InvalidMoveState", "TimeSkew"]);
const TOPUP = new Set(["InsufficientSponsorFunds", "InsufficientFunds"]);
const RETRY = new Set(["Cooldown"]);
const RENEW = new Set(["InvalidToken", "NoToken"]);
const NOT_READY = new Set(["ChunkNotReady"]);

export function errorKind(name: string | undefined): ErrorKind {
  if (!name) return "other";
  if (SNAPBACK.has(name)) return "snapback";
  if (TOPUP.has(name)) return "topup";
  if (RETRY.has(name)) return "retry";
  if (RENEW.has(name)) return "renewSession";
  if (NOT_READY.has(name)) return "notReady";
  return "other";
}

/** Maps a `TransactionError` from `getSignatureStatuses` to a `TxFailure`. */
export function mapTxError(err: TransactionError | unknown): TxFailure {
  const ie = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  if (Array.isArray(ie)) {
    const [ixIndex, inner] = ie;
    const custom = (inner as { Custom?: number } | null)?.Custom;
    if (typeof custom === "number") {
      const info = PROGRAM_ERRORS.get(custom);
      const name = info?.name;
      return {
        kind: errorKind(name),
        code: custom,
        name,
        message: info ? `${info.name} (${custom}): ${info.msg}` : `custom program error ${custom}`,
        ixIndex,
        raw: err,
      };
    }
    const name = typeof inner === "string" ? inner : Object.keys(inner ?? {})[0];
    return { kind: "other", name, message: `ix ${ixIndex}: ${JSON.stringify(inner)}`, ixIndex, raw: err };
  }
  const name = typeof err === "string" ? err : Object.keys((err as object) ?? {})[0];
  return { kind: "other", name, message: `transaction failed: ${JSON.stringify(err)}`, raw: err };
}

type Waiter = {
  resolve: (r: { err: TransactionError | null } | null) => void;
  deadline: number;
};

type Lane = {
  busy: boolean;
  queued?: { src: IxSource; opts: SendOptions; resolve: (r: SendResult) => void };
};

export type SenderOptions = {
  /** Called on every failure (not on `superseded`). */
  onError?: (f: TxFailure, key: string | undefined, sig?: string) => void;
  /** Status poll period, ms (default 50). */
  pollMs?: number;
  /** Default confirmation timeout, ms (default 30 000). */
  timeoutMs?: number;
  /** Reuse a fetched blockhash for this long, ms (default 5 000). */
  blockhashTtlMs?: number;
  /** Clock (tests). */
  now?: () => number;
};

export class ErSender {
  private lanes = new Map<string, Lane>();
  private waiters = new Map<string, Waiter>();
  private polling = false;
  private bh: { blockhash: string; lastValidBlockHeight: number; at: number } | null = null;
  private bhPending: Promise<{ blockhash: string; lastValidBlockHeight: number }> | null = null;
  /** Signatures sent per blockhash (last few blockhashes). */
  private seen = new Map<string, Set<string>>();
  private uniq = 0;
  private readonly now: () => number;

  constructor(
    readonly conn: SenderConnection,
    public payer: Keypair,
    readonly opts: SenderOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** Is a tx with this key in flight? */
  busy(key: string): boolean {
    return !!this.lanes.get(key)?.busy;
  }

  /** Sends `src` (see the module docs). Never rejects. */
  send(src: IxSource, opts: SendOptions = {}): Promise<SendResult> {
    const key = opts.key;
    if (key === undefined) return this.exec(src, opts);
    let lane = this.lanes.get(key);
    if (!lane) this.lanes.set(key, (lane = { busy: false }));
    if (!lane.busy) {
      lane.busy = true;
      return this.runLane(key, lane, src, opts);
    }
    return new Promise((resolve) => {
      lane.queued?.resolve({ status: "superseded" });
      lane.queued = { src, opts, resolve };
    });
  }

  private async runLane(key: string, lane: Lane, src: IxSource, opts: SendOptions): Promise<SendResult> {
    try {
      return await this.exec(src, opts);
    } finally {
      const next = lane.queued;
      lane.queued = undefined;
      if (next) void this.runLane(key, lane, next.src, next.opts).then(next.resolve);
      else lane.busy = false;
    }
  }

  private fail(error: TxFailure, key: string | undefined, sig?: string): SendResult {
    try {
      this.opts.onError?.(error, key, sig);
    } catch {
      /* a throwing handler must not break the sender */
    }
    return { status: "failed", sig, error };
  }

  private async blockhash() {
    const ttl = this.opts.blockhashTtlMs ?? 5_000;
    if (this.bh && this.now() - this.bh.at < ttl) return this.bh;
    this.bhPending ??= this.conn.getLatestBlockhash("confirmed").finally(() => (this.bhPending = null));
    const b = await this.bhPending;
    if (!this.bh || this.bh.blockhash !== b.blockhash) this.bh = { ...b, at: this.now() };
    else this.bh.at = this.now();
    return this.bh;
  }

  /** Drops the cached blockhash (e.g. after "Blockhash not found"). */
  invalidateBlockhash() {
    this.bh = null;
  }

  private markSeen(blockhash: string, sig: string): boolean {
    let set = this.seen.get(blockhash);
    if (!set) {
      set = new Set();
      this.seen.set(blockhash, set);
      while (this.seen.size > 8) this.seen.delete(this.seen.keys().next().value!);
    }
    if (set.has(sig)) return false;
    set.add(sig);
    return true;
  }

  private build(ixs: Ixs, units: number | undefined, blockhash: string, lastValidBlockHeight: number, signers: Keypair[]) {
    const tx = new Transaction({ feePayer: this.payer.publicKey, blockhash, lastValidBlockHeight });
    if (units !== undefined) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units }));
    tx.add(...ixs);
    tx.sign(this.payer, ...signers);
    return tx;
  }

  private async exec(src: IxSource, opts: SendOptions): Promise<SendResult> {
    const key = opts.key;
    let ixs: Ixs;
    try {
      ixs = typeof src === "function" ? await src() : src;
    } catch (e) {
      return this.fail({ kind: "other", message: `building the tx failed: ${errMsg(e)}`, raw: e }, key);
    }
    const signers = opts.signers ?? [];
    let units = opts.computeUnits ?? (opts.gen ? GEN_COMPUTE_UNITS : undefined);
    let tx: Transaction;
    let sig: string;
    try {
      const { blockhash, lastValidBlockHeight } = await this.blockhash();
      tx = this.build(ixs, units, blockhash, lastValidBlockHeight, signers);
      sig = utils.bytes.bs58.encode(tx.signature!);
      // Byte-identical tx under the same blockhash: vary the compute-unit limit.
      while (!this.markSeen(blockhash, sig)) {
        units = (units ?? GEN_COMPUTE_UNITS) - 1 - (this.uniq++ % 100_000);
        tx = this.build(ixs, units, blockhash, lastValidBlockHeight, signers);
        sig = utils.bytes.bs58.encode(tx.signature!);
      }
    } catch (e) {
      return this.fail({ kind: "send", message: `signing failed: ${errMsg(e)}`, raw: e }, key);
    }
    const t0 = this.now();
    try {
      await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    } catch (e) {
      if (/blockhash/i.test(errMsg(e))) this.invalidateBlockhash();
      return this.fail({ kind: "send", message: `send failed: ${errMsg(e)}`, raw: e }, key, sig);
    }
    const st = await this.wait(sig, opts.timeoutMs ?? this.opts.timeoutMs ?? 30_000);
    if (!st) return this.fail({ kind: "timeout", message: `tx ${sig} not confirmed in time` }, key, sig);
    if (st.err) {
      const f = mapTxError(st.err);
      if (opts.logs) f.logs = await this.fetchLogs(sig);
      return this.fail(f, key, sig);
    }
    return { status: "confirmed", sig, ms: this.now() - t0 };
  }

  /** Logs of a processed tx (retries briefly: the status can precede `getTransaction`). */
  async fetchLogs(sig: string, tries = 20): Promise<string[]> {
    for (let i = 0; i < tries; i++) {
      try {
        const info = await this.conn.getTransaction(sig, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (info) return info.meta?.logMessages ?? [];
      } catch {
        /* retry */
      }
      await sleep(this.opts.pollMs ?? 50);
    }
    return [];
  }

  private wait(sig: string, timeoutMs: number) {
    return new Promise<{ err: TransactionError | null } | null>((resolve) => {
      this.waiters.set(sig, { resolve, deadline: this.now() + timeoutMs });
      if (!this.polling) void this.poll();
    });
  }

  private async poll() {
    this.polling = true;
    try {
      while (this.waiters.size) {
        await sleep(this.opts.pollMs ?? 50);
        const sigs = [...this.waiters.keys()];
        for (let i = 0; i < sigs.length; i += 256) {
          const batch = sigs.slice(i, i + 256);
          let values: Awaited<ReturnType<SenderConnection["getSignatureStatuses"]>>["value"] = [];
          try {
            values = (await this.conn.getSignatureStatuses(batch)).value;
          } catch {
            /* transient RPC error: retry next round */
          }
          batch.forEach((sig, j) => {
            const w = this.waiters.get(sig);
            if (!w) return;
            const st = values[j];
            if (st?.err) {
              this.waiters.delete(sig);
              w.resolve({ err: st.err });
            } else if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
              this.waiters.delete(sig);
              w.resolve({ err: null });
            } else if (this.now() > w.deadline) {
              this.waiters.delete(sig);
              w.resolve(null);
            }
          });
        }
      }
    } finally {
      this.polling = false;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
