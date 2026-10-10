import { Keypair, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { decodeMoveState, DEFAULT_WORLD_PARAMS, PSTATE_LEN, type V3 } from "../chain/layout";
import type { SendResult } from "../chain/sender";
import { checkMove, coreMoveWindow, quadUploads, spawnState } from "../wasm";
import { FP, PlayerPhysics, sampleOf } from "./physics";
import { chainEstimate, ChainClock, chooseFrame, encodeParams, MoveSync, PSTATE_MOVE_OFFSET, type Frame, type SyncDeps, type SyncSender } from "./sync";
import { ChunkWorld, PARAMS } from "./testkit";

const B = FP;
const HOME: V3 = [5 * B + 128, 10 * B, 5 * B + 128];
const params = encodeParams(DEFAULT_WORLD_PARAMS);

/** PlayerState account bytes with `move` state bytes and health. */
function pstate(move: Uint8Array, health = 20) {
  const d = new Uint8Array(PSTATE_LEN);
  d.set(move, PSTATE_MOVE_OFFSET);
  d[145] = health;
  return d;
}

type Call = { args: Parameters<SyncDeps["moveIx"]>[0]; key?: string; resolve: (r: SendResult) => void };

/** A sender whose sends stay pending until the test resolves them. */
function fakeSender() {
  const calls: Call[] = [];
  const other: string[] = [];
  let last: Parameters<SyncDeps["moveIx"]>[0] | null = null;
  const sender: SyncSender = {
    send: vi.fn(async (src, opts) => {
      if (opts?.key !== "move") {
        other.push(opts?.key ?? "");
        return { status: "confirmed", sig: "x", ms: 1 } as SendResult;
      }
      if (typeof src === "function") await src();
      const args = last!;
      return new Promise<SendResult>((resolve) => calls.push({ args, key: opts?.key, resolve }));
    }),
  };
  const moveIx = async (m: Parameters<SyncDeps["moveIx"]>[0]) => {
    last = m;
    return new TransactionInstruction({ keys: [], programId: Keypair.generate().publicKey, data: Buffer.alloc(0) });
  };
  return { sender, calls, other, moveIx };
}

const flush = () => new Promise((r) => setImmediate(r));

function setup(over: Partial<SyncDeps> = {}) {
  const w = new ChunkWorld();
  const f = fakeSender();
  let chain = 10_000;
  let perf = 0;
  let onchain: Uint8Array = pstate(spawnState(HOME, 9_000, true));
  const snaps: V3[] = [];
  const deps: SyncDeps = {
    params,
    sender: () => f.sender,
    moveIx: f.moveIx,
    blocks: (cx, cz) => w.chunk(cx, cz),
    fetchState: async () => onchain,
    clock: { now: () => chain },
    snap: (p) => snaps.push([...p]),
    perfNow: () => perf,
    ...over,
  };
  const sync = new MoveSync(deps);
  sync.onPlayerState(onchain);
  return {
    sync,
    f,
    w,
    snaps,
    setChain: (t: number) => (chain = t),
    setPerf: (t: number) => (perf = t),
    setOnchain: (d: Uint8Array) => (onchain = d),
    frame: (t: number, dx = 0, onGround = true): Frame => ({ t, pos: [HOME[0] + dx, HOME[1], HOME[2]], vel: [0, 0, 0], onGround }),
  };
}

describe("MoveSync", () => {
  it("adopts the first PlayerState and snaps the player there", () => {
    const s = setup();
    expect(s.snaps).toEqual([HOME]);
    expect(s.sync.prevState?.lastMs).toBe(9_000);
  });

  it("sends the newest frame from the confirmed state; prev advances only on confirm", async () => {
    const s = setup();
    s.sync.record(s.frame(9_900, 10));
    s.sync.record(s.frame(9_950, 20));
    const p = s.sync.tick();
    await flush();
    expect(s.f.calls).toHaveLength(1);
    const c = s.f.calls[0];
    expect(c.key).toBe("move");
    expect(c.args.prev).toEqual(HOME);
    expect(c.args.pos).toEqual([HOME[0] + 20, HOME[1], HOME[2]]);
    expect(c.args.clientMs).toBe(9_950);
    expect(s.sync.prevState?.lastMs).toBe(9_000);
    c.resolve({ status: "confirmed", sig: "a", ms: 30 });
    await p;
    expect(s.sync.prevState?.lastMs).toBe(9_950);
    expect(s.sync.prevState?.pos).toEqual([HOME[0] + 20, HOME[1], HOME[2]]);
    expect(s.sync.summary().confirmed).toBe(1);
  });

  it("a failed (non-snapback) send keeps prev; the next send starts from it again", async () => {
    const s = setup();
    s.sync.record(s.frame(9_900, 10));
    const p = s.sync.tick();
    await flush();
    s.f.calls[0].resolve({ status: "failed", error: { kind: "send", message: "net" } });
    await p;
    expect(s.sync.prevState?.lastMs).toBe(9_000);
    s.sync.record(s.frame(10_000, 30));
    const p2 = s.sync.tick();
    await flush();
    expect(s.f.calls[1].args.prev).toEqual(HOME);
    expect(s.f.calls[1].args.clientMs).toBe(10_000);
    s.f.calls[1].resolve({ status: "confirmed", sig: "b", ms: 1 });
    await p2;
  });

  it("client_ms strictly increases (frame stamps forced forward, never resent)", async () => {
    const s = setup();
    s.sync.record(s.frame(9_500.7, 5));
    s.sync.record(s.frame(9_500.2, 6)); // clock slewed back: stamped 9 501
    expect(s.sync.frames.map((f) => f.t)).toEqual([9_500, 9_501]);
    const p = s.sync.tick();
    await flush();
    s.f.calls[0].resolve({ status: "failed", error: { kind: "other", message: "?" } });
    await p;
    // No newer frame: nothing to send (the failed 9 501 is not re-sent).
    await s.sync.tick();
    expect(s.f.calls).toHaveLength(1);
    s.sync.record(s.frame(9_400, 7)); // older stamp → forced to 9 502
    const p2 = s.sync.tick();
    await flush();
    expect(s.f.calls[1].args.clientMs).toBe(9_502);
    s.f.calls[1].resolve({ status: "confirmed", sig: "c", ms: 1 });
    await p2;
  });

  it("coalesces ticks while a move is in flight into one send of the newest frame", async () => {
    const s = setup();
    s.sync.record(s.frame(9_100, 10));
    const p = s.sync.tick();
    await flush();
    for (let i = 1; i <= 5; i++) {
      s.sync.record(s.frame(9_100 + 50 * i, 10 + 10 * i));
      void s.sync.tick();
    }
    expect(s.f.calls).toHaveLength(1);
    s.f.calls[0].resolve({ status: "confirmed", sig: "a", ms: 1 });
    await p;
    await flush();
    expect(s.f.calls).toHaveLength(2);
    expect(s.f.calls[1].args.clientMs).toBe(9_350);
    expect(s.f.calls[1].args.prev).toEqual([HOME[0] + 10, HOME[1], HOME[2]]);
    s.f.calls[1].resolve({ status: "confirmed", sig: "b", ms: 1 });
    await flush();
    expect(s.sync.prevState?.lastMs).toBe(9_350);
  });

  it("an onchain snapback error re-reads the PlayerState and snaps to it", async () => {
    const s = setup();
    s.sync.record(s.frame(9_900, 40));
    const p = s.sync.tick();
    await flush();
    const chainState = spawnState([HOME[0] + 7, HOME[1], HOME[2]], 9_200, true);
    s.setOnchain(pstate(chainState));
    s.f.calls[0].resolve({ status: "failed", error: { kind: "snapback", name: "Collision", message: "Collision" } });
    await p;
    expect(s.snaps.at(-1)).toEqual([HOME[0] + 7, HOME[1], HOME[2]]);
    expect(s.sync.prevState?.lastMs).toBe(9_200);
    expect(s.sync.frames).toEqual([]);
    expect(s.sync.summary()).toMatchObject({ snapbacks: 1, rejected: { Collision: 1 } });
  });

  it("a timeout adopts the onchain state without snapping (the move may have landed)", async () => {
    const s = setup();
    s.sync.record(s.frame(9_900, 40));
    const p = s.sync.tick();
    await flush();
    const landed = checkMove(params, spawnState(HOME, 9_000, true), [HOME[0] + 40, HOME[1], HOME[2]], [0, 0, 0], true, 9_900, 9_900, s.w.quad(0, 0));
    expect(landed.ok).toBe(true);
    s.setOnchain(pstate(landed.ok ? landed.state : new Uint8Array(72)));
    s.f.calls[0].resolve({ status: "failed", error: { kind: "timeout", message: "t" } });
    await p;
    expect(s.snaps).toHaveLength(1);
    expect(s.sync.prevState?.lastMs).toBe(9_900);
    // A late notification of that same move is recognized as ours.
    s.sync.onPlayerState(pstate(landed.ok ? landed.state : new Uint8Array(72)));
    expect(s.sync.summary().resets).toBe(0);
  });

  it("holds when the window chunks are not ready; never sends", async () => {
    const s = setup({ blocks: () => null });
    s.sync.record(s.frame(9_900, 40));
    await s.sync.tick();
    expect(s.f.calls).toHaveLength(0);
    expect(s.snaps).toHaveLength(1);
    expect(s.sync.summary().notReadyHolds).toBe(1);
  });

  it("a frame the core would reject is not sent: an earlier one is, or the player snaps back locally", async () => {
    const s = setup();
    s.sync.record(s.frame(9_100, 30));
    s.sync.record(s.frame(9_150, 3_000)); // teleport
    const p = s.sync.tick();
    await flush();
    expect(s.f.calls[0].args.pos[0]).toBe(HOME[0] + 30);
    s.f.calls[0].resolve({ status: "confirmed", sig: "a", ms: 1 });
    await p;
    expect(s.sync.summary().fallbacks).toBe(1);
    // Only the teleport frame is left after the confirmed one: local snap-back, no send.
    s.sync.record(s.frame(9_200, 3_000));
    await s.sync.tick();
    expect(s.f.calls).toHaveLength(1);
    expect(s.snaps.at(-1)).toEqual([HOME[0] + 30, HOME[1], HOME[2]]);
    expect(s.sync.summary().localSnapbacks).toBe(1);
  });

  it("retries a ground claim the core rejects as airborne", async () => {
    const s = setup();
    // 0.5 block up in the air, claiming ground.
    s.sync.record({ t: 9_100, pos: [HOME[0], HOME[1] + 128, HOME[2]], vel: [0, 0, 0], onGround: true });
    void s.sync.tick();
    await flush();
    expect(s.f.calls[0].args.onGround).toBe(false);
  });

  it("dead: stops sending and reports once", async () => {
    const onDead = vi.fn();
    const s = setup({ onDead });
    s.sync.onPlayerState(pstate(spawnState(HOME, 9_000, true), 0));
    expect(onDead).toHaveBeenCalledTimes(1);
    s.sync.record(s.frame(9_900, 10));
    await s.sync.tick();
    expect(s.f.calls).toHaveLength(0);
  });

  it("PlayerState notifications: stale ignored, our move adopted, a foreign newer state snaps", () => {
    const s = setup();
    s.sync.onPlayerState(pstate(spawnState([HOME[0] + 99, HOME[1], HOME[2]], 8_000, true), 15));
    expect(s.sync.prevState?.lastMs).toBe(9_000);
    expect(s.snaps).toHaveLength(1);
    const respawn = spawnState([HOME[0] - 256, HOME[1], HOME[2]], 12_000, false);
    s.sync.onPlayerState(pstate(respawn));
    expect(s.snaps.at(-1)).toEqual([HOME[0] - 256, HOME[1], HOME[2]]);
    expect(s.sync.summary().resets).toBe(1);
  });

  it("same last_ms but different onchain bytes: the onchain state wins", () => {
    const s = setup();
    const other = spawnState([HOME[0] + 50, HOME[1], HOME[2]], 9_000, true);
    s.sync.onPlayerState(pstate(other));
    expect(s.sync.prevState?.pos[0]).toBe(HOME[0] + 50);
    expect(s.snaps.at(-1)).toEqual([HOME[0] + 50, HOME[1], HOME[2]]);
  });

  it("uploads each window's chunks to wasm once per decision, checks ≤ 25 candidates", async () => {
    const s = setup();
    for (let i = 1; i <= 60; i++) s.sync.record(s.frame(9_000 + i * 10, 3_000)); // all teleports
    const calls = { n: 0 };
    const check = s.sync.check.bind(s.sync);
    s.sync.check = (f, g, c) => (calls.n++, check(f, g, c));
    const before = quadUploads();
    await s.sync.tick();
    expect(calls.n).toBeLessThanOrEqual(25);
    expect(quadUploads() - before).toBeLessThanOrEqual(4);
    expect(s.sync.summary().localSnapbacks).toBe(1);
  });

  it("persistent TimeSkew (stamps outside the chain window): counted, then snap back + recalibrate", async () => {
    const onClockSuspect = vi.fn();
    const s = setup({ onClockSuspect });
    s.setChain(20_000); // frames stamped ≥ 2 s behind chain time
    for (let k = 0; k < 8; k++) {
      s.sync.record(s.frame(9_100 + k * 100, 10 + k));
      await s.sync.tick();
    }
    expect(s.f.calls).toHaveLength(0);
    expect(s.sync.summary().timeSkewHolds).toBe(8);
    expect(onClockSuspect).toHaveBeenCalledTimes(1);
    expect(s.snaps.at(-1)).toEqual(HOME);
  });

  it("idle: an unchanged position is only re-sent as a heartbeat", async () => {
    const s = setup();
    s.setChain(9_500);
    s.sync.record(s.frame(9_400, 0));
    await s.sync.tick();
    expect(s.f.calls).toHaveLength(0);
    s.setChain(10_100);
    s.sync.record(s.frame(10_050, 0));
    void s.sync.tick();
    await flush();
    expect(s.f.calls).toHaveLength(1);
  });

  it("day-crank watchdog: schedule_day_crank when stale, rate-limited", async () => {
    const s = setup({ dayCrankIx: async () => new TransactionInstruction({ keys: [], programId: Keypair.generate().publicKey, data: Buffer.alloc(0) }) });
    s.sync.onWorld({ lastTickMs: 9_000 }); // 1 s behind: fine
    expect(s.f.other).toEqual([]);
    s.sync.onWorld({ lastTickMs: 5_000 });
    s.sync.onWorld({ lastTickMs: 5_000 });
    expect(s.f.other).toEqual(["dayCrank"]);
    s.setPerf(6_000);
    await s.sync.tick();
    expect(s.f.other).toEqual(["dayCrank", "dayCrank"]);
  });
});

describe("chain clock", () => {
  const W = (anchorMs: number, anchorSlot = 0) => ({ clock: { anchorSlot, anchorMs, usPerSlot: 50_000, baseUsPerSlot: 50_000, syncSlot: 0, syncMs: 0 } });

  it("steps forward, slews backward, drops slow readings once calibrated", () => {
    let t = 1_000;
    const c = new ChainClock(() => t);
    expect(c.now()).toBeNull();
    // Fine anchor: chain = 50 000 + slot · 50; wall agrees (unix 50 s).
    expect(c.observe({ slot: 0, unixS: 50, t0: 990, t1: 1_010 }, W(50_000))).toBe(true);
    expect(c.now()).toBe(49_000 + 1_000);
    t = 2_000;
    c.observe({ slot: 22, unixS: 51, t0: 2_000, t1: 2_000 }, W(50_000)); // 100 ms ahead: step
    expect(c.now()).toBe(51_100);
    c.observe({ slot: 18, unixS: 51, t0: 2_000, t1: 2_000 }, W(50_000)); // 200 ms behind: slew 25
    expect(c.now()).toBe(51_075);
    expect(c.observe({ slot: 40, unixS: 52, t0: 1_000, t1: 2_000 }, W(50_000))).toBe(false); // RTT 1 s
    expect(c.now()).toBe(51_075);
    expect(c.stamp()).toBe(51_000);
  });

  it("uses the validator's wall time (Clock sysvar), not the local clock, when the anchor is stale", () => {
    const w = W(1_000_000, 100);
    expect(chainEstimate(w, 120, 1_001_000)).toBe(1_001_000);
    expect(chainEstimate(w, 1_000, 1_045_000)).toBe(1_045_000 - 300); // anchor 45 s old
    expect(chainEstimate({ clock: { ...w.clock, usPerSlot: 0 } }, 120, 7_000)).toBe(6_700);
    expect(chainEstimate(w, 120, null)).toBe(1_001_000);
    // A local clock 60 s off never enters: the wall offset comes from unix_timestamp.
    let t = 5_000;
    const c = new ChainClock(() => t);
    for (let i = 0; i < 20; i++, t += 1_000) c.observe({ slot: 1_000 + i * 20, unixS: 1_045 + i, t0: t, t1: t }, w);
    // Last reading at t = 24 000: wall 1 064 500, coarse estimate 300 ms behind; now t = 25 000.
    expect(c.now()).toBe(1_064_500 - 300 + 1_000);
  });
});

describe("chooseFrame", () => {
  const ok = { ok: true as const, fallDamage: 0, state: new Uint8Array(72) };
  it("tries the newest supported frame first when the newest is airborne", () => {
    const fr = (t: number, onGround: boolean): Frame => ({ t, pos: [t, 0, 0], vel: [0, 0, 0], onGround });
    const frames = [fr(1, false), fr(2, true), fr(3, false), fr(4, false)];
    const order: number[] = [];
    const r = chooseFrame(frames, 1, (f) => (order.push(f.t), { ok: false, error: "Flying" }));
    expect(order).toEqual([2, 4, 3]);
    expect(r).toMatchObject({ pick: null, rejected: "Flying" });
    expect(chooseFrame(frames, 0, () => ok).pick?.frame.t).toBe(2);
  });
});

/** Validator + program time model: wall time `T` (ms), slots every 50 ms; the World
 *  anchor is re-anchored every second (fine) or frozen 60 s in the past (coarse). Mirrors
 *  `TimeAnchor::read` + `move_player`'s coarse lead shift. */
function chainModel(coarse: boolean, T0: number) {
  const slotAt = (T: number) => 1_000 + Math.floor((T - T0) / 50);
  let anchor = { anchorSlot: slotAt(T0 - 60_000), anchorMs: T0 - 60_000 };
  return {
    slotAt,
    world: () => ({ clock: { ...anchor, usPerSlot: 50_000, baseUsPerSlot: 50_000, syncSlot: 0, syncMs: 0 } }),
    tick(T: number) {
      if (!coarse) anchor = { anchorSlot: slotAt(T), anchorMs: T0 + (slotAt(T) - 1_000) * 50 };
    },
    programMs(T: number) {
      const wall = Math.floor(T / 1000) * 1000;
      const est = anchor.anchorMs + (slotAt(T) - anchor.anchorSlot) * 50;
      if (est - anchor.anchorMs > 10_000 || Math.abs(est - wall) > 10_000) return wall + 750;
      return est;
    },
  };
}

describe("MoveSync + physics against a simulated chain (core check_move)", () => {
  /** 40 s of random play; local clock `skew` ms off the validator; readings every second
   *  (RTT 20–80 ms; `slowAt`: one reading with a 900 ms RTT and a value from its end). */
  async function simulate(o: { skew: number; coarse: boolean; slowAt?: number; seconds?: number }) {
    const w = new ChunkWorld();
    const T0 = 1_791_000_000_000;
    let T = T0; // validator wall time
    const perf = () => T + o.skew; // the client's clock: skewed
    const chain = chainModel(o.coarse, T0);
    const clock = new ChainClock(perf);
    // `join_world` stores the (uncorrected) chain reading: coarse = wall seconds.
    let onchain: Uint8Array = pstate(spawnState(HOME, (o.coarse ? T0 : chain.programMs(T0)) - 1_000, true));
    const phys = new PlayerPhysics(HOME, PARAMS, w.physWorld());
    const pending: { at: number; run: () => void }[] = [];
    let built: Parameters<SyncDeps["moveIx"]>[0] | null = null;
    const rejected: string[] = [];
    let rand = 7;
    const rnd = () => ((rand = (rand * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const sender: SyncSender = {
      async send(src) {
        if (typeof src === "function") await src();
        const m = built!;
        return new Promise<SendResult>((resolve) =>
          pending.push({
            at: T + 40 + rnd() * 220,
            run: () => {
              // The "program": check against the onchain state at processing time.
              const prev = onchain.slice(PSTATE_MOVE_OFFSET, PSTATE_MOVE_OFFSET + 72);
              const win = coreMoveWindow(decodeMoveState(prev).pos, m.pos)!;
              const r = checkMove(params, prev, m.pos, m.vel, m.onGround, m.clientMs, chain.programMs(T), w.quad(win[0], win[1]));
              if (r.ok) {
                onchain = pstate(r.state);
                resolve({ status: "confirmed", sig: "s", ms: 1 });
              } else {
                rejected.push(r.error);
                resolve({ status: "failed", error: { kind: "snapback", name: r.error, message: r.error } });
              }
            },
          }),
        );
      },
    };
    const sync = new MoveSync({
      params,
      sender: () => sender,
      moveIx: async (m) => {
        built = m;
        return new TransactionInstruction({ keys: [], programId: Keypair.generate().publicKey, data: Buffer.alloc(0) });
      },
      blocks: (cx, cz) => w.chunk(cx, cz),
      fetchState: async () => onchain,
      clock,
      snap: (p) => phys.teleport(p),
      onClockSuspect: () => clock.reset(),
      perfNow: perf,
      log: process.env.SYNC_LOG ? (m, d) => console.log(Math.round(T - T0), m, JSON.stringify(d)) : undefined,
    });
    sync.onPlayerState(onchain);
    let yaw = 0;
    let inp = {};
    const frames = 60 * (o.seconds ?? 40);
    for (let f = 1; f <= frames; f++) {
      T = T0 + (f * 1000) / 60;
      chain.tick(T);
      if (f % 60 === 1) {
        const k = Math.floor(f / 60);
        if (k === o.slowAt) {
          // Request sent 900 ms ago, value read at the end: looks 450 ms ahead.
          clock.observe({ slot: chain.slotAt(T), unixS: Math.floor(T / 1000), t0: perf() - 900, t1: perf() }, chain.world());
        } else {
          const rtt = 20 + rnd() * 60;
          clock.observe({ slot: chain.slotAt(T - rtt / 2), unixS: Math.floor((T - rtt / 2) / 1000), t0: perf() - rtt, t1: perf() }, chain.world());
        }
      }
      if (f % 20 === 1) {
        yaw += (rnd() - 0.5) * 2.5;
        inp = { forward: rnd() < 0.85, left: rnd() < 0.15, jump: rnd() < 0.5, sprint: rnd() < 0.6 };
      }
      const [x, , z] = phys.body.pos.map((v) => v / FP);
      if (Math.abs(x - 5) > 60 || Math.abs(z - 5) > 60) yaw = Math.atan2(x - 5, z - 5);
      phys.yaw = yaw;
      phys.input = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, ...inp };
      phys.update(1 / 60);
      const t = clock.stamp();
      if (t !== null) sync.record({ t, ...sampleOf(phys.body), inWater: phys.body.inWater });
      for (const p of pending.filter((p) => p.at <= T)) {
        pending.splice(pending.indexOf(p), 1);
        p.run();
      }
      await flush();
      if (f % 7 === 0) void sync.tick(); // ≈ 8.6 Hz
      await flush();
    }
    return { rejected, st: sync.summary(), clock };
  }

  it("random play with 40–260 ms round trips: no onchain rejection", async () => {
    const { rejected, st } = await simulate({ skew: 0, coarse: false, seconds: 60 });
    expect(rejected).toEqual([]);
    expect(st).toMatchObject({ snapbacks: 0, localSnapbacks: 0, timeSkewHolds: 0 });
    expect(st.confirmed).toBeGreaterThan(200);
  }, 60_000);

  for (const skew of [60_000, -60_000])
    for (const coarse of [false, true])
      it(`client clock ${skew > 0 ? "+" : "−"}60 s, ${coarse ? "stale anchor (coarse chain time)" : "fresh anchor"}: no TimeSkew`, async () => {
        const { rejected, st } = await simulate({ skew, coarse, seconds: 20 });
        expect(rejected).toEqual([]);
        expect(st).toMatchObject({ snapbacks: 0, localSnapbacks: 0, timeSkewHolds: 0 });
        expect(st.confirmed).toBeGreaterThan(100);
      }, 60_000);

  it("one slow clock reading is dropped and causes no rejection", async () => {
    const { rejected, st, clock } = await simulate({ skew: 0, coarse: false, slowAt: 5, seconds: 15 });
    expect(clock.dropped).toBe(1);
    expect(rejected).toEqual([]);
    expect(st).toMatchObject({ snapbacks: 0, localSnapbacks: 0, timeSkewHolds: 0 });
  }, 60_000);
});
