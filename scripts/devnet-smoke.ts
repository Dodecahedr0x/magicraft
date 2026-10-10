// Devnet smoke test of the deployed program through the app's chain layer (`app/src/chain`).
// Re-checks the design doc's remaining risks on a real MagicBlock ER (Task 28):
// onboarding (init + deposit + delegate pinned to the ER validator) → 0-lamport session key
// (ER fees) → create_world + request_seed with the Player PDA as VRF payer → seed →
// chunk (0,0) create/grow/populate/set_spawn (CU) → join → moves (confirm latency) → day
// crank + chunk crank ticks → break/place → top-up (`lamportsDelegatedTransferIx`) →
// close an unedited chunk → withdraw (commit + undelegate) → withdraw_base (settlement).
//
// Run (from the repo root; the wallet is a throwaway keypair funded beforehand, e.g.
// `solana transfer -u devnet <addr> 0.2 --allow-unfunded-recipient`):
//
//   SMOKE_WALLET=/path/to/throwaway.json pnpm smoke:devnet   (= node scripts/run-smoke.mjs)
//
// Env (defaults = MagicBlock devnet EU): SMOKE_BASE_RPC, SMOKE_ER_RPC, SMOKE_ER_VALIDATOR,
// SMOKE_PROGRAM_ID, SMOKE_DEPOSIT_SOL (0.05), SMOKE_TOPUP_SOL (0.01), SMOKE_OUT (JSON
// results file), SMOKE_LATE_MOVES_AFTER_S (0 = off: wait, sampling the World clock, then walk
// again). A wallet whose Player is still delegated from an earlier run resumes after onboarding;
// one withdrawn by an earlier run is re-funded and re-delegated. Every step is recorded as works / fails (+ error); the script continues
// past failures where later steps do not depend on them.
import { readFileSync, writeFileSync } from "node:fs";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  type Transaction,
} from "@solana/web3.js";
import {
  breakBlockIx,
  closeChunkIx,
  createAndGrowIxs,
  createWorldIx,
  freshNonce,
  joinWorldIx,
  measureUsPerSlot,
  moveIx,
  placeBlockIx,
  populateChunkIx,
  requestSeedIx,
  sessionAuth,
  setSpawnIx,
  viewOf,
  type Auth,
} from "../app/src/chain/actions";
import { DEFAULT_EPHEMERAL_QUEUE, loadConfig } from "../app/src/chain/config";
import { makeConnections } from "../app/src/chain/connections";
import {
  blockIndex,
  chunkBlocks,
  chunkReady,
  decodeChunkHeader,
  decodePlayer,
  decodePlayerState,
  decodeWorld,
  DEFAULT_WORLD_PARAMS,
  FP,
  chainEstimate,
  liveMobs,
  nextClientMs,
  worldChainMs,
  type V3,
} from "../app/src/chain/layout";
import { chunkKey, chunkPda, presencePda, pstatePda, worldPda } from "../app/src/chain/pdas";
import {
  eSplRentPda,
  onboardingIxs,
  onboardingTx,
  playerStatus,
  topUpIx,
  walletTx,
  withdrawBaseIx,
  withdrawIx,
} from "../app/src/chain/player";
import { makeProgram } from "../app/src/chain/program";
import { ErSender, type IxSource, type SendOptions } from "../app/src/chain/sender";
import { createSessionTx, verifySession, type Session } from "../app/src/chain/session";

const env = process.env;
const cfg = loadConfig({
  VITE_BASE_RPC: env.SMOKE_BASE_RPC ?? "https://api.devnet.solana.com",
  VITE_ER_RPC: env.SMOKE_ER_RPC ?? "https://devnet-eu.magicblock.app",
  VITE_ER_VALIDATOR: env.SMOKE_ER_VALIDATOR ?? "MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e",
  VITE_PROGRAM_ID: env.SMOKE_PROGRAM_ID ?? "4GTybm3WD66wUnTgS8UcB9H947uAY7BAqivp8HfbSsW9",
  VITE_VRF_QUEUE: DEFAULT_EPHEMERAL_QUEUE.toBase58(),
});
if (!env.SMOKE_WALLET) throw new Error("set SMOKE_WALLET to a funded throwaway keypair file");
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(env.SMOKE_WALLET, "utf8"))));
const DEPOSIT = Math.round(Number(env.SMOKE_DEPOSIT_SOL ?? "0.05") * LAMPORTS_PER_SOL);
const TOPUP = Math.round(Number(env.SMOKE_TOPUP_SOL ?? "0.01") * LAMPORTS_PER_SOL);

const { base, er } = makeConnections(cfg);
const program = makeProgram(cfg, er);
const pid = cfg.programId;

// ---------------------------------------------------------------- results

type Step = { step: string; ok: boolean; ms?: number; detail?: unknown; error?: string };
const results: Step[] = [];
const sigs: Record<string, string> = {};
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);
async function step<T>(name: string, f: () => Promise<T>, critical = true): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const detail = await f();
    const r: Step = { step: name, ok: true, ms: Date.now() - t0, detail };
    results.push(r);
    log("OK  ", name, `${r.ms} ms`, detail === undefined ? "" : JSON.stringify(detail, big));
    return detail;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    results.push({ step: name, ok: false, ms: Date.now() - t0, error });
    log("FAIL", name, error);
    if (critical) throw e;
    return undefined;
  }
}
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => Promise<T | null | undefined | false>, ms: number, what: string, every = 100): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms: ${what}`);
    await sleep(every);
  }
}
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const stats = (a: number[]) => ({
  n: a.length,
  min: Math.min(...a),
  median: median(a),
  p90: [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.9)] ?? NaN,
  max: Math.max(...a),
});

// ---------------------------------------------------------------- tx helpers

async function sendBase(tx: Transaction, label: string) {
  tx.partialSign(wallet);
  const sig = await base.sendRawTransaction(tx.serialize());
  const bh = await base.getLatestBlockhash("confirmed");
  const r = await base.confirmTransaction({ signature: sig, ...bh, blockhash: tx.recentBlockhash! }, "confirmed");
  if (r.value.err) throw new Error(`base tx ${label} ${sig}: ${JSON.stringify(r.value.err)}`);
  sigs[label] = sig;
  return sig;
}

let sender: ErSender;
const failures: string[] = [];
/** Sends on the ER via the app sender; throws the mapped error + logs. Returns sig + ms. */
async function ok(label: string, src: IxSource, opts: SendOptions = {}, s: ErSender = sender) {
  const r = await s.send(src, { logs: true, ...opts });
  if (r.status !== "confirmed")
    throw new Error(
      `ER tx ${label} ${r.status}: ${r.status === "failed" ? `${r.error.message}\n${(r.error.logs ?? []).slice(-12).join("\n")}` : ""}`,
    );
  sigs[label] = r.sig;
  return r;
}
/** Compute units of a confirmed ER tx (retries: `getTransaction` can lag the status). */
async function cu(sig: string): Promise<number | null> {
  for (let i = 0; i < 20; i++) {
    const t = await er.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t) return t.meta?.computeUnitsConsumed ?? null;
    await sleep(150);
  }
  return null;
}
async function erLogs(sig: string): Promise<string[]> {
  for (let i = 0; i < 20; i++) {
    const t = await er.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t) return t.meta?.logMessages ?? [];
    await sleep(150);
  }
  return [];
}
const account = async (pk: PublicKey) => (await er.getAccountInfo(pk, "confirmed"))?.data ?? null;
const erLamports = async (pk: PublicKey) => (await er.getAccountInfo(pk, "confirmed"))?.lamports ?? 0;

// ---------------------------------------------------------------- chain clock

/** The program's chain-time reading, as the game client computes it (`chainEstimate`):
 *  the World anchor estimate, or — when the program falls back to coarse wall time —
 *  the validator's wall time (Clock sysvar) − 300 ms. `fine` reports which one applies;
 *  `errVsLocalMs` = estimate − local wall clock at the request midpoint. */
async function chainNow(world: PublicKey) {
  const t0 = Date.now();
  const [info, slot, clk] = await Promise.all([
    er.getAccountInfo(world, "confirmed"),
    er.getSlot("processed"),
    er.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "processed"),
  ]);
  const local = (t0 + Date.now()) / 2;
  const w = decodeWorld(info!.data);
  const wall = Number(Buffer.from(clk!.data).readBigInt64LE(32)) * 1000 + 500;
  const est = worldChainMs(w, slot);
  const ms = chainEstimate(w, slot, wall)!;
  return {
    ms,
    fine: est !== null && ms === est,
    estMinusWall: est === null ? null : est - wall,
    errVsLocalMs: est === null ? null : Math.round(est - local),
    usPerSlot: w.clock.usPerSlot,
    firstJoinMs: w.firstJoinMs,
    slot,
  };
}
/** Next `client_ms` (strictly after `lastMs` + `minDt`) the program accepts; waits while
 *  `lastMs` is ahead of chain time (e.g. stamped by a fine reading before a coarse one). */
async function clientMs(world: PublicKey, lastMs: number, minDt: number, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const c = await chainNow(world);
    const ms = nextClientMs(c.ms, lastMs, minDt);
    if (ms !== null) return { ms, fine: c.fine };
    if (Date.now() > end) throw new Error(`chain time ${c.ms} (fine ${c.fine}) stays behind last_ms ${lastMs}`);
    await sleep(100);
  }
}

// ---------------------------------------------------------------- walking (port of live.test.ts)

/** core::blocks::is_solid: everything but air, torch and water (23..=30). */
const isSolid = (b: number) => !(b === 0 || b === 17 || (b >= 23 && b <= 30));
function surface(blocks: Uint8Array, lx: number, lz: number): number | null {
  for (let y = 63; y >= 0; y--) {
    const b = blocks[blockIndex(lx, y, lz)];
    if (b !== 0) return isSolid(b) ? y + 1 : null;
  }
  return null;
}
function planWalk(blocks: Map<string, Uint8Array>, start: [number, number], target: [number, number]): V3[] | null {
  const h = (x: number, z: number) => {
    const [cx, cz] = [Math.floor(x / 16), Math.floor(z / 16)];
    const b = blocks.get(chunkKey(cx, cz));
    return b ? surface(b, x - cx * 16, z - cz * 16) : null;
  };
  const key = (x: number, z: number) => `${x},${z}`;
  const prev = new Map<string, string | null>([[key(...start), null]]);
  const queue: [number, number][] = [start];
  while (queue.length) {
    const [x, z] = queue.shift()!;
    const hy = h(x, z);
    if (hy === null) continue;
    if (Math.floor(x / 16) === target[0] && Math.floor(z / 16) === target[1]) {
      const path: V3[] = [];
      for (let k: string | null = key(x, z); k && k !== key(...start); k = prev.get(k)!) {
        const [px, pz] = k.split(",").map(Number);
        path.unshift([px, h(px, pz)!, pz]);
      }
      return path;
    }
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const [nx, nz] = [x + dx, z + dz];
      if (prev.has(key(nx, nz))) continue;
      const nh = h(nx, nz);
      if (nh === null || nh - hy > 1 || hy - nh > 3) continue;
      prev.set(key(nx, nz), key(x, z));
      queue.push([nx, nz]);
    }
  }
  return null;
}
const center = (x: number, y: number, z: number): V3 => [x * FP + FP / 2, y * FP, z * FP + FP / 2];
const HAND_DROPS = new Set([1, 2, 5, 7]);

// ---------------------------------------------------------------- the run

async function main() {
  log(`program ${pid.toBase58()}, base ${cfg.baseRpc}, ER ${cfg.erRpc} (validator ${cfg.erValidator.toBase58()})`);
  log(`wallet ${wallet.publicKey.toBase58()}`);
  const walletStart = await base.getBalance(wallet.publicKey, "confirmed");
  log(`wallet balance ${walletStart / LAMPORTS_PER_SOL} SOL`);
  if (walletStart < TOPUP + 0.02 * LAMPORTS_PER_SOL) throw new Error("fund the wallet first");

  // Plain RTT (keep-alive) for comparison with tx confirm latency.
  await step("ER RTT (getSlot)", async () => {
    const t: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      await er.getSlot("processed");
      t.push(Math.round(performance.now() - t0));
    }
    return stats(t);
  }, false);

  // 1. Onboarding
  let player!: PublicKey;
  await step("onboarding: init_player + deposit + delegate_player (pinned validator)", async () => {
    const t0 = Date.now();
    const pre = await playerStatus(pid, base, er, wallet.publicKey);
    if (pre.state === "delegated") {
      player = pre.player;
      return { resumed: "Player already delegated (earlier run)", erLamports: pre.erLamports, player: player.toBase58() };
    }
    if (pre.state === "base")
      // Withdrawn by an earlier run: deposit + delegate again (init_player would fail).
      await sendBase(await walletTx(base, wallet.publicKey, (await onboardingIxs(program, cfg, wallet.publicKey, DEPOSIT)).slice(1)), "onboarding");
    else await sendBase(await onboardingTx(program, cfg, base, wallet.publicKey, DEPOSIT), "onboarding");
    const baseMs = Date.now() - t0;
    const st = await until(
      async () => {
        const s = await playerStatus(pid, base, er, wallet.publicKey);
        return s.state === "delegated" && s.erLamports !== null ? s : null;
      },
      60_000,
      "ER clone of the Player",
      250,
    );
    player = st.player;
    if (st.state !== "delegated") throw new Error("not delegated");
    return { sig: sigs.onboarding, baseConfirmMs: baseMs, cloneAfterMs: Date.now() - t0 - baseMs, erLamports: st.erLamports, player: player.toBase58() };
  });

  // 2. Session (0-lamport key as ER fee payer)
  let session!: Session;
  let auth!: Auth;
  await step("session: create_session_v2 on base (no top-up)", async () => {
    const { tx, session: s } = await createSessionTx(base, pid, wallet.publicKey);
    await sendBase(tx, "session");
    session = s;
    if (!(await verifySession(base, s))) throw new Error("session token not valid");
    auth = sessionAuth(s, player);
    sender = new ErSender(er, s.kp, { programId: pid, onError: (f) => failures.push(f.message) });
    return { sig: sigs.session, sessionKeyBaseLamports: await base.getBalance(s.kp.publicKey) };
  });

  // 3. World + VRF seed (Player PDA pays the VRF request on DEFAULT_EPHEMERAL_QUEUE)
  const params = { ...DEFAULT_WORLD_PARAMS, zombieCapPerChunk: 0, dayLengthSecs: 120 };
  let nonce = 0n;
  let world = PublicKey.default;
  let hint = 0;
  await step("measure the ER slot rate (create_world hint)", async () => {
    hint = await measureUsPerSlot(er);
    if (!hint) throw new Error("slot did not advance");
    return { usPerSlot: hint };
  });
  // 4. Chunk helpers (per world)
  const existing = new Set<string>();
  const view = () => viewOf(existing);
  const generate = async (cx: number, cz: number) => {
    const a = await ok(`create+grow ${cx},${cz}`, () => createAndGrowIxs(program, auth, world, cx, cz, view()), { gen: true });
    const b = await ok(`populate ${cx},${cz}`, async () => [await populateChunkIx(program, world, cx, cz)], { gen: true });
    if (!chunkReady((await account(chunkPda(pid, world, cx, cz)))!)) throw new Error(`chunk ${cx},${cz} not ready`);
    existing.add(chunkKey(cx, cz));
    return { createGrow: { ms: a.ms, cu: await cu(a.sig) }, populate: { ms: b.ms, cu: await cu(b.sig) } };
  };
  const blocksOf = async (cx: number, cz: number) => chunkBlocks((await account(chunkPda(pid, world, cx, cz)))!)!;
  let spawn!: V3;
  let path: V3[] = [];
  let target: [number, number] | null = null;
  // Worlds whose spawn is boxed in (no walkable crossing into a neighbor) are replaced.
  for (let attempt = 1; attempt <= 3 && !path.length; attempt++) {
    nonce = freshNonce();
    world = worldPda(pid, wallet.publicKey, nonce);
    existing.clear();
    await step("create_world (session-signed, 0-lamport fee payer)", async () => {
      const before = await erLamports(player);
      const r = await ok("create_world", async () => [await createWorldIx(program, auth, nonce, "devnet smoke", params, hint)]);
      return {
        sig: r.sig,
        confirmMs: r.ms,
        cu: await cu(r.sig),
        world: world.toBase58(),
        playerErDelta: (await erLamports(player)) - before,
        sessionKeyErLamports: await erLamports(session.kp.publicKey),
      };
    });
    await step("request_seed (Player PDA payer, DEFAULT_EPHEMERAL_QUEUE) → seed arrives", async () => {
      const before = await erLamports(player);
      const queueBefore = await erLamports(DEFAULT_EPHEMERAL_QUEUE);
      const r = await ok("request_seed", async () => [await requestSeedIx(program, auth, world)]);
      const t0 = Date.now();
      const w = await until(
        async () => {
          const d = await account(world);
          return d && decodeWorld(d).seedSet ? decodeWorld(d) : null;
        },
        60_000,
        "VRF seed",
      );
      return {
        sig: r.sig,
        cu: await cu(r.sig),
        seedAfterMs: Date.now() - t0,
        playerErDelta: (await erLamports(player)) - before,
        queueErDelta: (await erLamports(DEFAULT_EPHEMERAL_QUEUE)) - queueBefore,
        seedPrefix: Buffer.from(w.seed.subarray(0, 4)).toString("hex"),
      };
    });

    await step("chunk (0,0): create_chunk + grow_chunk, populate_chunk (CU)", async () => {
      const before = await erLamports(player);
      const g = await generate(0, 0);
      return { ...g, playerErDelta: (await erLamports(player)) - before };
    });
    await step("set_spawn", async () => {
      const r = await ok("set_spawn", async () => [await setSpawnIx(program, world)]);
      spawn = decodeWorld((await account(world))!).spawn;
      return { cu: await cu(r.sig), spawn };
    });

    // Path from spawn into a neighbor ending on a hand-breakable block (like live.test.ts).
    await step(`neighbors: generate until a walkable border crossing exists (world ${attempt})`, async () => {
      const made: string[] = [];
      for (const t of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as [number, number][]) {
        await generate(t[0], t[1]);
        made.push(chunkKey(...t));
        const blocks = new Map([
          ["0,0", await blocksOf(0, 0)],
          [chunkKey(...t), await blocksOf(...t)],
        ]);
        const p = planWalk(blocks, [spawn[0], spawn[2]], t);
        if (!p || p.length < 2) continue;
        const [x, y, z] = p[p.length - 1];
        const under = blocks.get(chunkKey(...t))![blockIndex(x - t[0] * 16, y - 1, z - t[1] * 16)];
        if (HAND_DROPS.has(under)) {
          path = p;
          target = t;
          break;
        }
      }
      if (!path.length) throw new Error(`no walkable crossing from spawn (chunks ${made.join(" ")})`);
      return { chunks: made, pathLen: path.length, target };
    }, attempt === 3);
  }

  // A boxed-in spawn is a property of the terrain, not a failure: keep it as a note.
  for (const r of results)
    if (path.length && !r.ok && r.step.startsWith("neighbors")) {
      r.ok = true;
      r.detail = { replacedWorld: r.error };
      delete r.error;
    }

  // 5. Join + moves
  const pstate = () => pstatePda(pid, world, player);
  const state = async () => decodePlayerState((await account(pstate()))!);
  await step("join_world", async () => {
    const r = await ok("join_world", async () => [await joinWorldIx(program, auth, world)]);
    const s = await state();
    return { cu: await cu(r.sig), confirmMs: r.ms, health: s.health };
  });

  /** From the path end back to spawn and out again (ends at the path end). */
  const back: V3[] = [...[...path].reverse().slice(1), [spawn[0], spawn[1], spawn[2]], ...path];
  /** From spawn: out, back, out. */
  const route: V3[] = [...path, ...back];
  /** Walks `route` from the onchain position, one move in flight at a time (like the
   *  app's move lane); returns confirm latencies, CU samples and clock modes. */
  async function walk(label: string, legs: V3[] = route) {
    const moveMs: number[] = [];
    const moveCu: number[] = [];
    const modes = { fine: 0, coarse: 0 };
    let waitedMs = 0;
    let s = await state();
    let prev = s.move.pos;
    let lastMs = s.move.lastMs;
    const clk0 = await chainNow(world);
    for (const [x, y, z] of legs) {
      const pos = center(x, y, z);
      const w0 = Date.now();
      const c = await clientMs(world, lastMs, 120);
      waitedMs += Date.now() - w0;
      modes[c.fine ? "fine" : "coarse"]++;
      const r = await ok(label, async () => [await moveIx(program, auth, world, { prev, pos, onGround: true, clientMs: c.ms, view: view() })], { key: "move" });
      moveMs.push(r.ms);
      if (moveCu.length < 4) moveCu.push((await cu(r.sig)) ?? -1);
      prev = pos;
      lastMs = c.ms;
    }
    s = await state();
    if (s.move.pos.join() !== prev.join()) throw new Error(`onchain pos ${s.move.pos} != ${prev}`);
    return { moves: legs.length, confirm: stats(moveMs), cuSample: moveCu, clockModes: modes, waitedForClockMs: waitedMs, clockAtStart: clk0 };
  }
  await step("world clock right after creation (anchor vs validator wall time)", async () => {
    const w = decodeWorld((await account(world))!);
    return { ...(await chainNow(world)), clock: w.clock };
  }, false);
  await step("moves: walk to the neighbor and back (fresh world, one in flight at a time)", () => walk("move"), false);

  // 7. Chunk crank (mobs / fluid / fresh presence: right after the walk, before the
  //    player's presence goes stale and idle chunks cancel their crank)
  await step("chunk crank: tick_count advances on chunks with mobs / players", async () => {
    const keys = [...existing];
    const read = async () =>
      Promise.all(
        keys.map(async (k) => {
          const [cx, cz] = k.split(",").map(Number);
          const h = decodeChunkHeader((await account(chunkPda(pid, world, cx, cz)))!);
          return { k, armed: h.crankArmed, ticks: h.tickCount, mobs: liveMobs(h).map((m) => m.pos.join("/")) };
        }),
      );
    const a = await read();
    await sleep(6_000);
    const b = await read();
    const per = a.map((x, i) => ({
      chunk: x.k,
      armed: [x.armed, b[i].armed],
      ticks: [x.ticks, b[i].ticks],
      mobs: x.mobs.length,
      mobsMoved: x.mobs.filter((p, j) => b[i].mobs[j] !== undefined && b[i].mobs[j] !== p).length,
    }));
    if (!per.some((p) => p.ticks[1] > p.ticks[0])) throw new Error(`no chunk ticked: ${JSON.stringify(per)}`);
    return per;
  }, false);

  // 6. Day crank
  await step("day crank: World.day_ticks / last_tick_ms advance (Magic-program ScheduleTask)", async () => {
    const w0 = decodeWorld((await account(world))!);
    await sleep(6_000);
    const w1 = decodeWorld((await account(world))!);
    const d = { dayTicks: [w0.dayTicks, w1.dayTicks], timeOfDayMs: [w0.timeOfDayMs, w1.timeOfDayMs], lastTickMs: [w0.lastTickMs, w1.lastTickMs], taskId: w0.dayTaskId };
    if (w1.dayTicks <= w0.dayTicks) throw new Error(`day crank not ticking: ${JSON.stringify(d, big)}`);
    return d;
  }, false);

  await step("world clock: estimate vs local wall clock over 60 s (|error| < 1 s)", async () => {
    const samples: { t: number; err: number | null; fine: boolean; usPerSlot: number }[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      const c = await chainNow(world);
      samples.push({ t: Math.round((Date.now() - t0) / 1000), err: c.errVsLocalMs, fine: c.fine, usPerSlot: c.usPerSlot });
      await sleep(2_000);
    }
    const worst = Math.max(...samples.map((x) => Math.abs(x.err ?? Infinity)));
    const r = { worstAbsErrMs: worst, allFine: samples.every((x) => x.fine), first: samples[0], last: samples[samples.length - 1] };
    if (worst >= 1_000 || !r.allFine) throw new Error(`clock off: ${JSON.stringify(r)}`);
    return r;
  }, false);

  // 7b. Moves again once the World clock has had time to converge (optional wait).
  const lateS = Number(env.SMOKE_LATE_MOVES_AFTER_S ?? "0");
  if (lateS > 0) {
    log(`waiting ${lateS} s for the World clock to converge…`);
    const t0 = Date.now();
    const samples: unknown[] = [];
    while (Date.now() - t0 < lateS * 1000) {
      samples.push({ t: Math.round((Date.now() - t0) / 1000), ...(await chainNow(world)) });
      await sleep(30_000);
    }
    results.push({ step: "world clock convergence samples", ok: true, detail: samples });
    await step(`moves again after ${lateS} s`, () => walk("move late", back), false);
  }

  // 8. Break under the player + place on the border
  await step("break_block under the player + place_block across the border", async () => {
    const [x, y, z] = path[path.length - 1];
    // Walk back to the path end first (the route ended there).
    const below: V3 = [x, y - 1, z];
    const [cx, cz] = [Math.floor(x / 16), Math.floor(z / 16)];
    const idx = (b: V3) => blockIndex(b[0] - Math.floor(b[0] / 16) * 16, b[1], b[2] - Math.floor(b[2] / 16) * 16);
    const br = await ok("break_block", async () => [await breakBlockIx(program, auth, world, below, view())]);
    if ((await blocksOf(cx, cz))[idx(below)] !== 0) throw new Error("block not broken");
    const inv = (await state()).inventory;
    const slot = inv.findIndex((s) => s.count > 0 && s.item >= 1 && s.item <= 22);
    if (slot < 0) throw new Error("no placeable drop");
    const tgt = path[path.length - 2];
    const pl = await ok("place_block", async () => [await placeBlockIx(program, auth, world, tgt, slot, view())]);
    return { break: { ms: br.ms, cu: await cu(br.sig) }, place: { ms: pl.ms, cu: await cu(pl.sig) } };
  }, false);

  // 9. Top-up via e-SPL lamportsDelegatedTransferIx
  await step("top-up: lamportsDelegatedTransferIx (e-SPL rent PDA funded?)", async () => {
    const rentPda = await eSplRentPda();
    const rent = await base.getBalance(rentPda, "confirmed");
    const before = await erLamports(player);
    const t0 = Date.now();
    await sendBase(await walletTx(base, wallet.publicKey, [await topUpIx(wallet.publicKey, player, TOPUP)]), "topup");
    const baseMs = Date.now() - t0;
    const after = await until(
      async () => {
        const l = await erLamports(player);
        return l - before >= TOPUP ? l : null;
      },
      60_000,
      "ER credit of the top-up",
      200,
    );
    return { sig: sigs.topup, rentPda: rentPda.toBase58(), rentPdaLamports: rent, baseConfirmMs: baseMs, creditedAfterMs: Date.now() - t0 - baseMs, erDelta: after - before };
  }, false);

  // 10. Close an unedited chunk nobody stands in (refund on the ER)
  await step("close_chunk: an unedited neighbor (rent refund)", async () => {
    const t = target!;
    let cand = [...existing].filter((k) => k !== "0,0" && k !== chunkKey(...t));
    if (!cand.length) {
      // Generate a fresh neighbor of (0,0) nobody stands in, then reclaim it.
      const free = ["0,1", "0,-1", "-1,0", "1,0"].find((k) => !existing.has(k))!;
      const [fx, fz] = free.split(",").map(Number);
      await generate(fx, fz);
      cand = [free];
    }
    const [cx, cz] = cand[0].split(",").map(Number);
    const before = await erLamports(player);
    const r = await ok("close_chunk", async () => [await closeChunkIx(program, auth, world, cx, cz, view())]);
    existing.delete(cand[0]);
    return { chunk: cand[0], cu: await cu(r.sig), refund: (await erLamports(player)) - before };
  }, false);

  // 11. Withdraw: commit + undelegate (wallet-signed on the ER), then withdraw_base
  let erAtWithdraw = 0;
  await step("withdraw (ER, wallet-signed commit_and_undelegate) → Player back on base", async () => {
    const baseBefore = await base.getBalance(player, "confirmed");
    erAtWithdraw = await erLamports(player);
    const ws = new ErSender(er, wallet, { programId: pid });
    const r = await ok("withdraw", async () => [await withdrawIx(program, wallet.publicKey)], {}, ws);
    const t0 = Date.now();
    const info = await until(
      async () => {
        const i = await base.getAccountInfo(player, "confirmed");
        return i?.owner.equals(pid) ? i : null;
      },
      120_000,
      "Player owned by magicraft on base again",
      500,
    );
    const p = decodePlayer(info.data);
    return {
      sig: r.sig,
      logsTail: (await erLogs(r.sig)).slice(-4),
      undelegatedAfterMs: Date.now() - t0,
      baseBefore,
      baseAfter: info.lamports,
      erAtWithdraw,
      openChunks: p.openChunks,
    };
  });
  await step("withdraw_base (all but rent-exempt) → wallet", async () => {
    const info = (await base.getAccountInfo(player, "confirmed"))!;
    const min = await base.getMinimumBalanceForRentExemption(info.data.length);
    const amount = info.lamports - min;
    const w0 = await base.getBalance(wallet.publicKey, "confirmed");
    await sendBase(await walletTx(base, wallet.publicKey, [await withdrawBaseIx(program, wallet.publicKey, amount)]), "withdraw_base");
    const w1 = await base.getBalance(wallet.publicKey, "confirmed");
    return { sig: sigs.withdraw_base, amount, walletDelta: w1 - w0, playerLeft: min };
  });

  const walletEnd = await base.getBalance(wallet.publicKey, "confirmed");
  log(`wallet ${walletStart} → ${walletEnd} (spent ${(walletStart - walletEnd) / LAMPORTS_PER_SOL} SOL)`);
  results.push({ step: "summary", ok: true, detail: { walletStart, walletEnd, spent: walletStart - walletEnd, senderFailures: failures, sessionKeyErLamports: await erLamports(session.kp.publicKey) } });
}

try {
  await main();
} catch (e) {
  log("aborted:", e instanceof Error ? e.message : e);
} finally {
  const out = { at: new Date().toISOString(), programId: pid.toBase58(), erRpc: cfg.erRpc, validator: cfg.erValidator.toBase58(), wallet: wallet.publicKey.toBase58(), results, sigs };
  if (env.SMOKE_OUT) writeFileSync(env.SMOKE_OUT, JSON.stringify(out, big, 2));
  console.log(results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.step}${r.error ? `: ${r.error.split("\n")[0]}` : ""}`).join("\n"));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
