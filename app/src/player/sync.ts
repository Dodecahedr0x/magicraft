// Move sync: sends the local player's position as `move_player` (~8 Hz) and keeps the
// last **confirmed** onchain `MoveState` as the base of the next update.
//
// - Frames: the controller records every rendered physics state with its chain-time stamp
//   (`ChainClock`: World time anchor + the ER Clock sysvar's slot and unix_timestamp — the
//   validator's wall time, learned as an offset, never the local clock — stamped 75 ms
//   behind the estimate); stamps strictly increase.
// - Every `intervalMs` (125 ms) the newest frame newer than the last sent `client_ms` is
//   checked locally with the core's `check_move` (wasm) from the confirmed state against the
//   local 2×2 chunk window — exactly what the program will run (`chooseFrame`: a recent
//   landing / in-water frame goes first when the newest is airborne; if a frame would be
//   rejected, earlier ones are tried, newest first; a frame claiming ground that the core
//   doesn't see as ground is retried airborne); the first that passes is sent. If none passes, the
//   player snaps back locally to the confirmed state without sending anything. Frames whose
//   window chunks aren't ready locally are skipped; if no frame is sendable for that reason,
//   nothing is sent and the player holds (auto-create generates the chunk).
// - One move in flight (ErSender lane `move`); ticks while it is in flight coalesce into
//   one send right after it settles (newest frame wins). Pipelining is a Task 28 option.
// - Results: confirmed → the predicted state (wasm output) becomes `prev`; a snap-back
//   error (MoveTooFast/Collision/NotOnGround/Flying/TimeSkew/InvalidMoveState) → re-read the
//   PlayerState, snap the player to it (velocity 0); every candidate failing with TimeSkew →
//   counted, and after ~1 s snap back + recalibrate the clock; `timeout` (may still land) → re-read and
//   adopt the onchain state without snapping; `notReady` → hold; `dead` → stop (`onDead`);
//   `topup` / `renewSession` → `onIssue`, sends pause 5 s; `NotInWorld` (counted out of the
//   world: expired or left elsewhere) → stop, `onKicked` (back to the world list).
// - PlayerState notifications (health / food changes from damage, our own moves landing)
//   only move `prev` forward when they carry a newer `last_ms`; a newer state that is not
//   one of our moves (respawn, teleport) snaps the player to it.
// - Idle: an unchanged position is re-sent only every `heartbeatMs` (presence freshness).
//   While the page is hidden there are no render frames: the controller records
//   `idleFrame`s (standing still on the ground) from a worker-driven 1 s tick, so a player
//   who tabs away stays present (visible, attackable) until it leaves the world.
// - Day-crank watchdog: `schedule_day_crank` when `World.last_tick_ms` is > 3 s behind
//   chain time, at most every 5 s.
import type { TransactionInstruction } from "@solana/web3.js";
import { requiredSlots } from "../chain/actions";
import {
  dayCrankStale,
  decodeMoveState,
  MOVE_STATE_SIZE,
  PSTATE_HEALTH_OFFSET,
  PSTATE_MOVE_OFFSET,
  chainEstimate,
  type MoveState,
  type V3,
  type WorldAccount,
  type WorldParams,
} from "../chain/layout";
import type { SendOptions, SendResult, TxFailure, IxSource } from "../chain/sender";
import { checkMove, coreMoveWindow, invalidateQuad, type CheckResult } from "../wasm";

export { PSTATE_MOVE_OFFSET };
const moveBytes = (data: Uint8Array) => data.slice(PSTATE_MOVE_OFFSET, PSTATE_MOVE_OFFSET + MOVE_STATE_SIZE);

/** `WorldParams` → its 48-byte layout (`core::physics::WorldParams::to_bytes`). */
export function encodeParams(p: WorldParams): Uint8Array {
  const b = new Uint8Array(48);
  const v = new DataView(b.buffer);
  [p.walkSpeed, p.sprintSpeed, p.swimSpeed, p.jumpVelocity, p.gravity, p.maxFallSpeed, p.reach, p.attackCooldownMs, p.dayLengthSecs, p.mobTickMs, p.fluidTickMs].forEach((w, i) =>
    v.setUint32(4 * i, w, true),
  );
  b[44] = p.fallDamage;
  b[45] = p.hunger;
  b[46] = p.zombieCapPerChunk;
  b[47] = p.pad;
  return b;
}

// ---------------------------------------------------------------- chain clock

/** Frames are stamped this far behind the chain-time estimate (headroom under the
 *  program's `LEAD_MS` = 250 for estimate noise), ms. */
export const STAMP_BEHIND_MS = 75;
/** Readings with a longer round trip are dropped once the clock is calibrated, ms. */
export const MAX_READING_RTT_MS = 250;
/** Backward corrections are slewed at most this much per reading, ms. */
const SLEW_BACK_MS = 25;
/** Differences larger than this are taken at once (mode switch fine ↔ coarse), ms. */
const JUMP_MS = 2_000;

export { chainEstimate };

/** One ER reading: `slot` and the Clock sysvar's `unix_timestamp` (s; null if unavailable),
 *  requested at local time `t0` and answered at `t1` (perfNow clock). */
export type ChainReading = { slot: number; unixS: number | null; t0: number; t1: number };

/** Local estimate of chain time, `perfNow() + offset`, and of the validator's wall time,
 *  `perfNow() + wallOffset`, learned from readings (local `Date.now()` is never used, so a
 *  skewed client clock doesn't matter). Once calibrated, readings with a round trip over
 *  `MAX_READING_RTT_MS` are dropped; the chain offset steps forward at once but slews
 *  backward (≤ 25 ms per reading) unless off by more than 2 s. The wall offset is the
 *  running mean (last ~30) of `unix_timestamp · 1000 + 500 − t_mid` (1 s resolution). */
export class ChainClock {
  offset: number | null = null;
  wallOffset: number | null = null;
  private wallN = 0;
  dropped = 0;
  constructor(readonly perfNow: () => number = () => performance.now()) {}

  /** Feeds a reading with the current World; returns false if it was dropped. */
  observe(r: ChainReading, w: Pick<WorldAccount, "clock">): boolean {
    const rtt = r.t1 - r.t0;
    if (this.offset !== null && rtt > MAX_READING_RTT_MS) {
      this.dropped++;
      return false;
    }
    const mid = (r.t0 + r.t1) / 2;
    if (r.unixS !== null) {
      const ws = r.unixS * 1000 + 500 - mid;
      if (this.wallOffset === null || Math.abs(ws - this.wallOffset) > JUMP_MS) {
        this.wallOffset = ws;
        this.wallN = 1;
      } else {
        this.wallN = Math.min(this.wallN + 1, 30);
        this.wallOffset += (ws - this.wallOffset) / this.wallN;
      }
    }
    const chain = chainEstimate(w, r.slot, this.wallOffset === null ? null : mid + this.wallOffset);
    if (chain === null) return false;
    this.apply(chain - mid);
    return true;
  }

  private apply(sample: number) {
    const o = this.offset;
    if (o === null || sample >= o || o - sample > JUMP_MS) this.offset = sample;
    else this.offset = o - Math.min(o - sample, SLEW_BACK_MS);
  }

  /** Forget the calibration (after persistent `TimeSkew`). */
  reset() {
    this.offset = null;
    this.wallOffset = null;
    this.wallN = 0;
  }

  now(): number | null {
    return this.offset === null ? null : this.perfNow() + this.offset;
  }

  /** Stamp for a frame simulated `ageMs` ago. */
  stamp(ageMs = 0): number | null {
    const n = this.now();
    return n === null ? null : n - STAMP_BEHIND_MS - ageMs;
  }
}

// ---------------------------------------------------------------- sync

/** A recorded physics state: chain-time stamp `t` (ms), FP position, FP/s velocity. */
export type Frame = { t: number; pos: V3; vel: V3; onGround: boolean; inWater?: boolean };

export type SyncSender = { send(src: IxSource, opts?: SendOptions): Promise<SendResult> };

export type SyncDeps = {
  /** World params bytes (48 B). */
  params: Uint8Array;
  /** The ER sender (null: no session — nothing is sent). */
  sender: () => SyncSender | null;
  /** `move_player` from the confirmed `prev` position (actions.moveIx). */
  moveIx: (m: { prev: V3; pos: V3; vel: V3; onGround: boolean; clientMs: number }) => Promise<TransactionInstruction>;
  /** `schedule_day_crank` (watchdog); omit to disable. */
  dayCrankIx?: () => Promise<TransactionInstruction>;
  /** Block bytes of a **ready** chunk (gen_stage DONE), else null. */
  blocks: (cx: number, cz: number) => Uint8Array | null;
  /** Fresh PlayerState account data (after a rejection / timeout). */
  fetchState: () => Promise<Uint8Array | null>;
  clock: { now(): number | null };
  /** Snap the local player to `pos` (FP) at rest. */
  snap: (pos: V3) => void;
  /** Frames keep failing with `TimeSkew` (~1 s): the clock should recalibrate. */
  onClockSuspect?: () => void;
  onDead?: () => void;
  /** Top-up / session problems (sends pause for `issuePauseMs`). */
  onIssue?: (f: TxFailure) => void;
  /** A move failed `NotInWorld`: the player was counted out of the world (sends stop). */
  onKicked?: () => void;
  /** Local time, ms (stats, pauses, watchdog rate limit). */
  perfNow?: () => number;
  intervalMs?: number;
  heartbeatMs?: number;
  issuePauseMs?: number;
  log?: (msg: string, data?: unknown) => void;
};

export type SyncStats = {
  sent: number;
  confirmed: number;
  /** Onchain rejections by error name. */
  rejected: Record<string, number>;
  /** Snap-backs: after onchain rejections + local (no frame passed the local check). */
  snapbacks: number;
  localSnapbacks: number;
  /** Sends of an earlier frame because the newest failed the local check. */
  fallbacks: number;
  timeouts: number;
  /** Ticks with nothing sendable because window chunks aren't ready. */
  notReadyHolds: number;
  /** External resets (a newer onchain state that is not our move: respawn, teleport). */
  resets: number;
  dayCranks: number;
  /** Ticks where every candidate failed the local check with `TimeSkew` (clock off). */
  timeSkewHolds: number;
  /** Send → result latency of confirmed moves, ms. */
  latencyAvg: number;
  latencyMax: number;
  /** Confirmed moves per second over the last 5 s. */
  rateHz: number;
};

/** The newest frames checked one by one per decision (+ one supported + ≤ 8 sparse). */
export const MAX_CANDIDATES = 16;

export type Choice = { frame: Frame; onGround: boolean; res: Extract<CheckResult, { ok: true }> };

/** Which frame to send: candidates are the frames after `floor` (the last sent / confirmed
 *  `client_ms`). If the newest is airborne and out of water but a supported frame (on
 *  ground or in water) came after `floor`, the newest supported one is tried first: the
 *  program refreshes the jump ceiling only from updates that are on ground / in water, and
 *  a one-frame landing between two 8 Hz updates (bunny-hopping onto a bump) is otherwise
 *  invisible to it. Then newest → oldest: the newest `maxCandidates`, then every 4th
 *  older frame (≤ 8; for long gaps), so a decision costs ≤ ~25 core checks. A frame claiming ground that the core rejects
 *  with `NotOnGround` is retried airborne. First accepted frame wins; else `rejected` = the
 *  first error seen (or only `notReady`: a window chunk isn't ready locally). */
export function chooseFrame(
  frames: readonly Frame[],
  floor: number,
  check: (f: Frame, onGround: boolean) => CheckResult | "notReady",
  maxCandidates = MAX_CANDIDATES,
): { pick: Choice | null; notReady: boolean; rejected: string | null; timeSkew: boolean } {
  let notReady = false;
  let timeSkew = false;
  let rejected: string | null = null;
  let first = frames.length;
  while (first > 0 && frames[first - 1].t > floor) first--;
  const order: number[] = [];
  const last = frames.length - 1;
  if (last >= first && !frames[last].onGround && !frames[last].inWater)
    for (let i = last - 1; i >= first; i--)
      if (frames[i].onGround || frames[i].inWater) {
        order.push(i);
        break;
      }
  // The newest `maxCandidates`, then every 4th older frame (≤ 8 more: long gaps).
  for (let i = last, n = 0; i >= first && n < maxCandidates + 8; n++) {
    if (i !== order[0]) order.push(i);
    i -= n < maxCandidates ? 1 : 4;
  }
  for (const i of order) {
    const f = frames[i];
    for (const g of f.onGround ? [true, false] : [false]) {
      const r = check(f, g);
      if (r === "notReady") {
        notReady = true;
        break;
      }
      if (r.ok) return { pick: { frame: f, onGround: g, res: r }, notReady, rejected, timeSkew };
      if (r.error === "TimeSkew") {
        timeSkew = true;
        break;
      }
      rejected ??= r.error;
      if (r.error !== "NotOnGround") break;
    }
  }
  return { pick: null, notReady, rejected, timeSkew };
}

const same = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

export class MoveSync {
  /** Last confirmed `MoveState` bytes / decoded. */
  prev: Uint8Array | null = null;
  prevState: MoveState | null = null;
  dead = false;
  stopped = false;
  frames: Frame[] = [];
  inflight: { clientMs: number; state: Uint8Array; at: number } | null = null;
  lastSentMs = -Infinity;
  private missed = false;
  private pausedUntil = 0;
  private lastFrameT = -Infinity;
  /** client_ms of sends that timed out (may still land). */
  private maybeLanded = new Set<number>();
  private worldTickMs: number | null = null;
  private lastCrankAt = -Infinity;
  private latencies: number[] = [];
  private confirms: number[] = [];
  readonly stats: Omit<SyncStats, "latencyAvg" | "latencyMax" | "rateHz"> = {
    sent: 0,
    confirmed: 0,
    rejected: {},
    snapbacks: 0,
    localSnapbacks: 0,
    fallbacks: 0,
    timeouts: 0,
    notReadyHolds: 0,
    resets: 0,
    dayCranks: 0,
    timeSkewHolds: 0,
  };
  private skewStreak = 0;
  private readonly perfNow: () => number;

  constructor(readonly deps: SyncDeps) {
    this.perfNow = deps.perfNow ?? (() => performance.now());
  }

  get intervalMs() {
    return this.deps.intervalMs ?? 125;
  }

  private log(msg: string, data?: unknown) {
    this.deps.log?.(msg, data);
  }

  /** PlayerState account data (initial fetch or notification). */
  onPlayerState(data: Uint8Array) {
    const bytes = moveBytes(data);
    const st = decodeMoveState(bytes);
    const dead = data[PSTATE_HEALTH_OFFSET] === 0;
    if (dead && !this.dead) {
      this.dead = true;
      this.deps.onDead?.();
    } else if (!dead && this.dead) this.dead = false;
    if (!this.prevState) {
      this.adopt(bytes, st, true);
      return;
    }
    if (st.lastMs === this.prevState.lastMs) {
      // Same update, different bytes (our prediction differed from the program's): the
      // onchain state wins; snap only if the position differs.
      if (!bytes.every((b, i) => b === this.prev![i])) {
        this.log("onchain state differs from the predicted one; adopting it", st);
        const moved = st.pos.some((v, i) => v !== this.prevState!.pos[i]);
        this.adopt(bytes, st, moved);
      }
      return;
    }
    if (st.lastMs < this.prevState.lastMs) return;
    if (this.inflight?.clientMs === st.lastMs || this.maybeLanded.has(st.lastMs)) {
      this.adopt(bytes, st, false);
      return;
    }
    // Newer and not ours: respawn / teleport.
    this.stats.resets++;
    this.log("external move-state reset", st);
    this.adopt(bytes, st, true);
  }

  private adopt(bytes: Uint8Array, st: MoveState, snap: boolean) {
    this.prev = bytes;
    this.prevState = st;
    if (snap) {
      this.frames = [];
      this.deps.snap(st.pos);
    }
  }

  /** World account update (day-crank watchdog). */
  onWorld(w: Pick<WorldAccount, "lastTickMs">) {
    this.worldTickMs = w.lastTickMs;
    this.watchDayCrank();
  }

  /** Records a physics state; its stamp is forced strictly after the previous one. */
  record(f: Frame) {
    if (!this.prevState || this.dead || this.stopped) return;
    const t = Math.max(Math.floor(f.t), this.lastFrameT + 1);
    this.lastFrameT = t;
    this.frames.push({ ...f, t });
    const keep = t - 2500;
    let i = 0;
    while (i < this.frames.length - 1 && this.frames[i].t < keep) i++;
    if (i) this.frames.splice(0, i);
  }

  /** Records the player standing still at time `t` (the page is hidden: no render frames,
   *  so no physics). Only when the confirmed state stands on the ground and the newest frame
   *  is that same spot at rest, so the move is a pure presence heartbeat. */
  idleFrame(t: number) {
    const prev = this.prevState;
    const last = this.frames[this.frames.length - 1];
    if (!prev || !prev.onGround || (last && (!same(last.pos, prev.pos) || !last.onGround))) return;
    this.record({ t, pos: [...prev.pos] as V3, vel: [0, 0, 0], onGround: true });
  }

  /** Clears recorded frames (the player was moved by something other than physics). */
  resetFrames() {
    this.frames = [];
  }

  private quadFor(a: V3, b: V3): Parameters<typeof checkMove>[7] | "far" | "notReady" {
    const win = coreMoveWindow(a, b);
    if (!win) return "far";
    const [cx0, cz0] = win;
    const slots = [this.deps.blocks(cx0, cz0), this.deps.blocks(cx0 + 1, cz0), this.deps.blocks(cx0, cz0 + 1), this.deps.blocks(cx0 + 1, cz0 + 1)];
    const req = requiredSlots(a, b, cx0, cz0);
    if (req.some((r, i) => r && !slots[i])) return "notReady";
    return { cx0, cz0, slots };
  }

  /** Local `check_move` of frame `f` from the confirmed state. */
  check(f: Frame, onGround: boolean, chainMs: number): CheckResult | "notReady" {
    const prev = this.prevState!;
    const q = this.quadFor(prev.pos, f.pos);
    if (q === "far") return { ok: false, error: "MoveTooFast" };
    if (q === "notReady") return "notReady";
    return checkMove(this.deps.params, this.prev!, f.pos, f.vel, onGround, f.t, chainMs, q);
  }

  private choose(chainMs: number) {
    const floor = Math.max(this.prevState!.lastMs, this.lastSentMs);
    invalidateQuad(); // chunk bytes may have changed since the last decision
    return chooseFrame(this.frames, floor, (f, g) => this.check(f, g, chainMs));
  }

  /** One send opportunity (call every `intervalMs`). Resolves when its send settles. */
  async tick(): Promise<void> {
    this.watchDayCrank();
    if (this.stopped || this.dead || !this.prevState) return;
    if (this.inflight) {
      this.missed = true;
      return;
    }
    if (this.perfNow() < this.pausedUntil) return;
    const sender = this.deps.sender();
    const chainMs = this.deps.clock.now();
    if (!sender || chainMs === null || !this.frames.length) return;
    const prev = this.prevState;
    const latest = this.frames[this.frames.length - 1];
    if (latest.t <= Math.max(prev.lastMs, this.lastSentMs)) return;
    if (same(latest.pos, prev.pos) && latest.onGround === prev.onGround && chainMs - prev.lastMs < (this.deps.heartbeatMs ?? 1000)) return;

    const { pick, notReady, rejected, timeSkew } = this.choose(chainMs);
    if (!pick && !rejected && !notReady && timeSkew) {
      // Every candidate's stamp is outside the chain's time window: the clock is off.
      this.stats.timeSkewHolds++;
      if (++this.skewStreak * this.intervalMs >= 1000) {
        this.log("frames keep failing with TimeSkew: snap back, recalibrate the clock", { chainMs, lastMs: prev.lastMs });
        this.skewStreak = 0;
        this.frames = [];
        this.deps.snap(prev.pos);
        this.deps.onClockSuspect?.();
      }
      return;
    }
    this.skewStreak = 0;
    if (!pick) {
      if (rejected) {
        this.stats.localSnapbacks++;
        this.log(`local check rejected every frame (${rejected}): snap back`, { prev: prev.pos, lastMs: prev.lastMs, latest, n: this.frames.length, chainMs });
        this.frames = [];
        this.deps.snap(prev.pos);
      } else if (notReady) this.stats.notReadyHolds++;
      return;
    }
    if (pick.frame !== latest) this.stats.fallbacks++;
    await this.send(sender, pick);
  }

  private async send(sender: SyncSender, pick: Choice) {
    const prevPos = this.prevState!.pos;
    const f = pick.frame;
    const clientMs = f.t;
    const t0 = this.perfNow();
    this.inflight = { clientMs, state: pick.res.state, at: t0 };
    this.lastSentMs = clientMs;
    this.stats.sent++;
    let r: SendResult;
    try {
      r = await sender.send(async () => [await this.deps.moveIx({ prev: prevPos, pos: f.pos, vel: f.vel, onGround: pick.onGround, clientMs })], { key: "move" });
    } catch (e) {
      r = { status: "failed", error: { kind: "other", message: String(e) } };
    }
    try {
      await this.settle(r, clientMs, pick.res.state, t0);
    } finally {
      this.inflight = null;
      if (this.missed) {
        this.missed = false;
        void this.tick();
      }
    }
  }

  private async settle(r: SendResult, clientMs: number, predicted: Uint8Array, t0: number) {
    if (r.status === "superseded") return;
    if (r.status === "confirmed") {
      const now = this.perfNow();
      this.stats.confirmed++;
      this.latencies.push(now - t0);
      if (this.latencies.length > 200) this.latencies.shift();
      this.confirms.push(now);
      while (this.confirms.length && this.confirms[0] < now - 5000) this.confirms.shift();
      if (this.prevState && this.prevState.lastMs < clientMs) {
        this.prev = predicted;
        this.prevState = decodeMoveState(predicted);
      }
      return;
    }
    const e = r.error;
    if (e.kind === "snapback") {
      this.stats.rejected[e.name ?? "?"] = (this.stats.rejected[e.name ?? "?"] ?? 0) + 1;
      this.stats.snapbacks++;
      this.log(`move rejected onchain: ${e.name}`, e.message);
      await this.resync(true);
    } else if (e.kind === "timeout") {
      this.stats.timeouts++;
      this.maybeLanded.add(clientMs);
      if (this.maybeLanded.size > 16) this.maybeLanded.delete(this.maybeLanded.values().next().value!);
      await this.resync(false);
    } else if (e.kind === "dead") {
      if (!this.dead) {
        this.dead = true;
        this.deps.onDead?.();
      }
    } else if (e.kind === "notReady") {
      this.stats.notReadyHolds++;
    } else if (e.kind === "topup" || e.kind === "renewSession") {
      this.pausedUntil = this.perfNow() + (this.deps.issuePauseMs ?? 5000);
      this.deps.onIssue?.(e);
    } else if (e.name === "NotInWorld") {
      // Counted out of the world (expired after a minute of silence, or left from another
      // tab): kicked. Stop sending; the game returns to the world list.
      if (!this.stopped) {
        this.stopped = true;
        this.deps.onKicked?.();
      }
    } else {
      this.stats.rejected[e.name ?? e.kind] = (this.stats.rejected[e.name ?? e.kind] ?? 0) + 1;
      this.log(`move failed (${e.kind})`, e.message);
    }
  }

  /** Re-reads the PlayerState and adopts it (`snap`: also moves the player there). */
  async resync(snap: boolean) {
    let data: Uint8Array | null = null;
    try {
      data = await this.deps.fetchState();
    } catch {
      /* keep the current prev */
    }
    if (!data) return;
    const bytes = moveBytes(data);
    const st = decodeMoveState(bytes);
    if (data[PSTATE_HEALTH_OFFSET] === 0 && !this.dead) {
      this.dead = true;
      this.deps.onDead?.();
    }
    // A state older than ours is a stale read (notifications already moved us on).
    if (this.prevState && st.lastMs < this.prevState.lastMs && !snap) return;
    this.adopt(bytes, st, snap);
  }

  private watchDayCrank() {
    const ix = this.deps.dayCrankIx;
    const chainMs = this.deps.clock.now();
    if (!ix || this.worldTickMs === null || chainMs === null) return;
    if (!dayCrankStale({ lastTickMs: this.worldTickMs }, chainMs)) return;
    const now = this.perfNow();
    if (now - this.lastCrankAt < 5000) return;
    const sender = this.deps.sender();
    if (!sender) return;
    this.lastCrankAt = now;
    this.stats.dayCranks++;
    this.log("day crank stale: schedule_day_crank", { lastTickMs: this.worldTickMs, chainMs });
    void sender.send(async () => [await ix()], { key: "dayCrank" });
  }

  stop() {
    this.stopped = true;
  }

  summary(): SyncStats {
    const l = this.latencies;
    return {
      ...this.stats,
      rejected: { ...this.stats.rejected },
      latencyAvg: l.length ? +(l.reduce((s, v) => s + v, 0) / l.length).toFixed(1) : 0,
      latencyMax: l.length ? Math.round(Math.max(...l)) : 0,
      rateHz: +(this.confirms.filter((t) => t >= this.perfNow() - 5000).length / 5).toFixed(2),
    };
  }
}
