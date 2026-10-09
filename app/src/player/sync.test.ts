import { Keypair, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { decodeMoveState, DEFAULT_WORLD_PARAMS, PSTATE_LEN, type V3 } from "../chain/layout";
import type { SendResult } from "../chain/sender";
import { checkMove, coreMoveWindow, spawnState } from "../wasm";
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
  it("observes readings, slews small differences, jumps large ones", () => {
    let t = 1_000;
    const c = new ChainClock(() => t);
    expect(c.now()).toBeNull();
    c.observe(50_000, 990, 1_010);
    expect(c.now()).toBe(50_000);
    t = 2_000;
    c.observe(51_100, 2_000, 2_000); // 100 ms ahead: ¼ applied
    expect(c.now()).toBe(51_025);
    c.observe(60_000, 2_000, 2_000);
    expect(c.now()).toBe(60_000);
  });

  it("falls back to wall time when the anchor is stale", () => {
    const w = { clock: { anchorSlot: 100, anchorMs: 1_000_000, msPerSlot: 50, baseMsPerSlot: 50, syncSlot: 0, syncMs: 0 } };
    expect(chainEstimate(w, 120, 1_001_000)).toBe(1_001_000);
    expect(chainEstimate(w, 1_000, 1_045_000)).toBe(1_045_000 - 200); // anchor 45 s old
    expect(chainEstimate({ clock: { ...w.clock, msPerSlot: 0 } }, 120, 7_000)).toBe(6_800);
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

describe("MoveSync + physics against a simulated chain (core check_move)", () => {
  it("random play with 40–260 ms round trips: no onchain rejection", async () => {
    const w = new ChunkWorld();
    let now = 0; // ms, chain clock = local clock
    let onchain: Uint8Array = pstate(spawnState(HOME, 0, true));
    const phys = new PlayerPhysics(HOME, PARAMS, w.physWorld());
    const pending: { at: number; run: () => void }[] = [];
    let built: Parameters<SyncDeps["moveIx"]>[0] | null = null;
    let rejected = 0;
    let rand = 7;
    const rnd = () => ((rand = (rand * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const sender: SyncSender = {
      async send(src) {
        if (typeof src === "function") await src();
        const m = built!;
        return new Promise<SendResult>((resolve) =>
          pending.push({
            at: now + 40 + rnd() * 220,
            run: () => {
              // The "program": check against the onchain state at processing time.
              const prev = onchain.slice(PSTATE_MOVE_OFFSET, PSTATE_MOVE_OFFSET + 72);
              const win = coreMoveWindow(decodeMoveState(prev).pos, m.pos)!;
              const r = checkMove(params, prev, m.pos, m.vel, m.onGround, m.clientMs, now, w.quad(win[0], win[1]));
              if (r.ok) {
                onchain = pstate(r.state);
                resolve({ status: "confirmed", sig: "s", ms: 1 });
              } else {
                rejected++;
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
      clock: { now: () => now },
      snap: (p) => phys.teleport(p),
      perfNow: () => now,
    });
    sync.onPlayerState(onchain);
    let yaw = 0;
    let inp = {};
    for (let f = 1; f <= 60 * 60; f++) {
      now = (f * 1000) / 60;
      if (f % 20 === 1) {
        yaw += (rnd() - 0.5) * 2.5;
        inp = { forward: rnd() < 0.85, left: rnd() < 0.15, jump: rnd() < 0.5, sprint: rnd() < 0.6 };
      }
      const [x, , z] = phys.body.pos.map((v) => v / FP);
      if (Math.abs(x - 5) > 60 || Math.abs(z - 5) > 60) yaw = Math.atan2(x - 5, z - 5);
      phys.yaw = yaw;
      phys.input = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, ...inp };
      phys.update(1 / 60);
      sync.record({ t: now, ...sampleOf(phys.body), inWater: phys.body.inWater });
      for (const p of pending.filter((p) => p.at <= now)) {
        pending.splice(pending.indexOf(p), 1);
        p.run();
      }
      await flush();
      if (f % 7 === 0) void sync.tick(); // ≈ 8.6 Hz
      await flush();
    }
    const st = sync.summary();
    expect(rejected).toBe(0);
    expect(st.snapbacks).toBe(0);
    expect(st.localSnapbacks).toBe(0);
    expect(st.confirmed).toBeGreaterThan(200);
  }, 60_000);
});
