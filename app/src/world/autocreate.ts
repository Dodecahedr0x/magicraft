// Auto-creation of missing chunks around the player.
//
// Targets: chunks within `radius` (default 2, circle `dx² + dz² ≤ r² + r`) of the focus
// that the store knows to be missing or not fully generated. Order: nearest first, but a
// missing chunk is only creatable next to a *ready* chunk (the program's adjacency rule),
// or when it is the player's own chunk (`create_chunk` with the PlayerState), or (0,0)
// when nothing exists — so creation spreads outward in adjacency order from what exists,
// like `creationChain`, and never leaves the radius.
//
// Each creation is two gen txs through the ER sender: `create_chunk + grow_chunk`, then
// `populate_chunk`. A chunk left at stage 0 / 1 (interrupted, or created by someone else)
// is resumed with `grow_chunk` / `populate_chunk` (both permissionless). At most
// `concurrency` (default 2) chunks are in flight and never two edge-adjacent ones: a
// `create_chunk` lists its neighbors writable iff they exist, so a neighbor appearing
// between build and execution would fail the tx.
//
// Spending guards (creations only; resuming grow / populate costs no new rent):
// - `consented`: nothing is created until the player opts in (the caller remembers it per
//   world); `waiting === "consent"` while a creation is blocked on it.
// - `capLamports` (default 0.01 SOL): a creation that would push this session's spend over
//   the cap waits (`waiting === "cap"`) until `raiseCap()`.
//
// Failures: `topup` (the Player can't sponsor the rent) and `renewSession` halt the creator
// until `resume()`; `notReady` / `timeout` retry soon, `superseded` after a short pause;
// anything else backs off exponentially per chunk.
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { CHUNK_PAYER_OFFSET, CHUNK_TOTAL_RENT, chunkKey, NBR_OFF, type ChunkView, type IxSource, type SendOptions, type SendResult, type TxFailure } from "../chain";
import { inRadius, type ChunkStore } from "./store";

export type AutoEvent =
  | { type: "start"; key: string; step: Step }
  | { type: "created"; key: string; lamports: number }
  | { type: "done"; key: string }
  | { type: "failed"; key: string; step: Step; failure: TxFailure }
  | { type: "halted"; reason: "topup" | "session"; failure: TxFailure }
  | { type: "state" };

export type Step = "create" | "grow" | "populate";

export const DEFAULT_CAP_LAMPORTS = 10_000_000;

export type AutoCreateDeps = {
  store: Pick<ChunkStore, "entry" | "ready" | "refresh" | "entries">;
  send: (src: IxSource, opts: SendOptions) => Promise<SendResult>;
  ixs: {
    /** `create_chunk + grow_chunk`; `own` = pass the PlayerState (player's own chunk). */
    createAndGrow(cx: number, cz: number, view: ChunkView, own: boolean): Promise<TransactionInstruction[]>;
    grow(cx: number, cz: number, payer: PublicKey): Promise<TransactionInstruction[]>;
    populate(cx: number, cz: number): Promise<TransactionInstruction[]>;
  };
  view: ChunkView;
  radius?: number;
  concurrency?: number;
  /** Session spend cap for creations (default 0.01 SOL). */
  capLamports?: number;
  /** Already opted in (default false). */
  consented?: boolean;
  onEvent?: (e: AutoEvent) => void;
  now?: () => number;
};

type Backoff = { until: number; fails: number };

export class AutoCreator {
  readonly radius: number;
  readonly concurrency: number;
  /** Session spend cap for creations, lamports. */
  capLamports: number;
  /** The player opted in to paying for chunks in this world. */
  consented: boolean;
  /** A creation is blocked on consent / the cap (resumes still run). */
  waiting: "consent" | "cap" | null = null;
  focus: [number, number] | null = null;
  own: [number, number] | null = null;
  paused = false;
  halted: "topup" | "session" | null = null;
  created = 0;
  spentLamports = 0;
  readonly inflight = new Map<string, Step>();
  private backoff = new Map<string, Backoff>();
  /** Chunks created moments ago (until the store sees them): not re-created. */
  private recent = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly now: () => number;

  constructor(readonly deps: AutoCreateDeps) {
    this.radius = deps.radius ?? 2;
    this.capLamports = deps.capLamports ?? DEFAULT_CAP_LAMPORTS;
    this.consented = deps.consented ?? false;
    this.concurrency = deps.concurrency ?? 2;
    this.now = deps.now ?? Date.now;
  }

  /** Starts a 1 s heartbeat (backoff expiry); `tick` is also called on store changes. */
  start() {
    this.timer ??= setInterval(() => this.tick(), 1000);
    this.tick();
  }

  setFocus(cx: number, cz: number) {
    if (this.focus?.[0] === cx && this.focus[1] === cz) return;
    this.focus = [cx, cz];
    this.tick();
  }
  setOwn(cx: number, cz: number) {
    this.own = [cx, cz];
  }
  setPaused(p: boolean) {
    this.paused = p;
    this.emit({ type: "state" });
    this.tick();
  }
  /** The player opted in to paying for chunks. */
  consent() {
    this.consented = true;
    this.waiting = null;
    this.emit({ type: "state" });
    this.tick();
  }
  /** Sets the session spend cap (lamports); creations continue while under it. */
  setCap(lamports: number) {
    this.capLamports = lamports;
    this.waiting = null;
    this.emit({ type: "state" });
    this.tick();
  }
  /** Allows `lamports` more spend this session (the "continue?" answer). */
  raiseCap(lamports = DEFAULT_CAP_LAMPORTS) {
    this.setCap(Math.max(this.capLamports, this.spentLamports) + lamports);
  }

  /** Clears a halt (after a top-up / session renewal). */
  resume() {
    this.halted = null;
    this.backoff.clear();
    this.emit({ type: "state" });
    this.tick();
  }

  /** Missing / unfinished chunks in the radius (whether creatable now or not). */
  pending(): number {
    if (!this.focus) return 0;
    let n = 0;
    for (const e of this.deps.store.entries()) {
      const [dx, dz] = [e.cx - this.focus[0], e.cz - this.focus[1]];
      if (!inRadius(dx, dz, this.radius)) continue;
      if (e.status === "missing" || (e.status === "present" && e.genStage < 2)) n++;
    }
    return n;
  }

  private emit(e: AutoEvent) {
    try {
      this.deps.onEvent?.(e);
    } catch (err) {
      console.error(err);
    }
  }

  tick() {
    if (this.disposed || this.paused || this.halted || !this.focus) return;
    while (this.inflight.size < this.concurrency) {
      const job = this.next();
      if (!job) break;
      void this.run(job.key, job.cx, job.cz, job.step);
    }
  }

  /** The next job: nearest creatable / resumable chunk not adjacent to one in flight. */
  next(): { key: string; cx: number; cz: number; step: Step } | null {
    if (!this.focus) return null;
    const [fx, fz] = this.focus;
    const { store, view } = this.deps;
    const r = this.radius;
    const cands: { key: string; cx: number; cz: number; d: number }[] = [];
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) if (inRadius(dx, dz, r)) cands.push({ key: chunkKey(fx + dx, fz + dz), cx: fx + dx, cz: fz + dz, d: dx * dx + dz * dz });
    cands.sort((a, b) => a.d - b.d);
    const t = this.now();
    for (const [k, until] of this.recent) if (until <= t) this.recent.delete(k);
    for (const [k, b] of this.backoff) if (b.until <= t && !this.deps.store.entry(k)) this.backoff.delete(k);
    let anyPresent = false;
    for (const e of store.entries()) if (e.status === "present") anyPresent = true;
    // Unfinished chunks first (already paid for), then creations; nearest first in each.
    let create: { key: string; cx: number; cz: number; step: Step } | null = null;
    for (const c of cands) {
      const e = store.entry(c.key);
      if (!e || e.status === "loading" || this.inflight.has(c.key)) continue;
      const b = this.backoff.get(c.key);
      if (b && b.until > t) continue;
      if ([...this.inflight.keys()].some((k) => adjacent(k, c.cx, c.cz))) continue;
      if (e.status === "present") {
        if (e.genStage === 0) return { ...c, step: "grow" };
        if (e.genStage === 1) return { ...c, step: "populate" };
        continue;
      }
      if (create || (this.recent.get(c.key) ?? 0) > t) continue;
      const own = this.own && this.own[0] === c.cx && this.own[1] === c.cz;
      const nextToReady = NBR_OFF.some(([ox, oz]) => view.ready(c.cx + ox, c.cz + oz));
      const origin = c.key === "0,0" && !anyPresent;
      if (own || nextToReady || origin) create = { ...c, step: "create" };
    }
    // Spending guards apply to creations only.
    const waiting = !create ? null : !this.consented ? "consent" : this.spentLamports + CHUNK_TOTAL_RENT > this.capLamports ? "cap" : null;
    if (waiting !== this.waiting) {
      this.waiting = waiting;
      this.emit({ type: "state" });
    }
    return waiting ? null : create;
  }

  private async run(key: string, cx: number, cz: number, first: Step) {
    const { send, ixs, store, view } = this.deps;
    let step = first;
    this.inflight.set(key, step);
    try {
      if (step === "create") {
        this.emit({ type: "start", key, step });
        const own = !!this.own && this.own[0] === cx && this.own[1] === cz;
        const r = await send(() => ixs.createAndGrow(cx, cz, view, own), { gen: true });
        if (!this.ok(r, key, step) || this.disposed) return;
        this.created++;
        this.recent.set(key, this.now() + 10_000);
        this.spentLamports += CHUNK_TOTAL_RENT;
        this.emit({ type: "created", key, lamports: CHUNK_TOTAL_RENT });
        step = "populate";
      } else if (step === "grow") {
        this.emit({ type: "start", key, step });
        const d = store.entry(key)?.data;
        if (!d) return;
        const payer = new PublicKey(d.subarray(CHUNK_PAYER_OFFSET, CHUNK_PAYER_OFFSET + 32));
        const r = await send(() => ixs.grow(cx, cz, payer), { gen: true });
        if (!this.ok(r, key, step) || this.disposed) return;
        step = "populate";
      }
      if (this.disposed) return;
      this.inflight.set(key, step);
      this.emit({ type: "start", key, step });
      const r = await send(() => ixs.populate(cx, cz), { gen: true });
      if (!this.ok(r, key, step)) return;
      this.backoff.delete(key);
      this.emit({ type: "done", key });
    } finally {
      if (!this.disposed) await store.refresh(key);
      this.inflight.delete(key);
      this.emit({ type: "state" });
      if (!this.disposed) setTimeout(() => this.tick(), 0);
    }
  }

  private ok(r: SendResult, key: string, step: Step): boolean {
    if (r.status === "confirmed") return true;
    if (r.status === "superseded") {
      this.backoff.set(key, { until: this.now() + 1000, fails: this.backoff.get(key)?.fails ?? 0 });
      return false;
    }
    const f = r.error;
    this.emit({ type: "failed", key, step, failure: f });
    if (f.kind === "topup" || f.kind === "renewSession") {
      this.halted = f.kind === "topup" ? "topup" : "session";
      this.emit({ type: "halted", reason: this.halted, failure: f });
      return false;
    }
    const prev = this.backoff.get(key);
    const fails = (prev?.fails ?? 0) + 1;
    const quick = f.kind === "notReady" || f.kind === "timeout";
    const ms = quick ? 1500 : Math.min(60_000, 2000 * 2 ** (fails - 1));
    this.backoff.set(key, { until: this.now() + ms, fails });
    return false;
  }

  dispose() {
    this.disposed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

const adjacent = (key: string, cx: number, cz: number) => {
  const [x, z] = key.split(",").map(Number);
  return Math.abs(x - cx) + Math.abs(z - cz) <= 1;
};
