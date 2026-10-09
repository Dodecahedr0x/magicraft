// Task 4 spike: Magic-program cranks (ScheduleTask / CancelTask) targeting an
// EPHEMERAL account, with the delegated Player PDA as task payer/authority.
// spike_* instructions are temporary (removed in Task 6).
import { expect } from "chai";
import { BN, web3 } from "@anchor-lang/core";
import { erConn, sendEr } from "./helpers/env";
import { setupPlayer, sleep, SpikePlayer, until } from "./helpers/spike";

const randomTaskId = () => new BN(Math.floor(Math.random() * 2 ** 47) + 1); // positive i64

async function counter(chunk: web3.PublicKey): Promise<number> {
  const info = await erConn.getAccountInfo(chunk, "confirmed");
  return Number(info!.data.readBigUInt64LE(0));
}

async function erLamports(pk: web3.PublicKey): Promise<number> {
  return (await erConn.getAccountInfo(pk, "confirmed"))?.lamports ?? 0;
}

async function erLogs(sig: string): Promise<string[]> {
  const tx = await erConn.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  return tx?.meta?.logMessages ?? [];
}

async function schedule(
  p: SpikePlayer,
  taskId: BN,
  intervalMs: number,
  iterations: number
): Promise<string> {
  const ix = await p.er.methods
    .spikeSchedule(0, 0, taskId, new BN(intervalMs), new BN(iterations))
    .accounts({ authority: p.authority.publicKey })
    .instruction();
  return sendEr([ix], [p.authority]);
}

async function cancel(p: SpikePlayer, taskId: BN): Promise<string> {
  const ix = await p.er.methods
    .spikeCancel(taskId)
    .accounts({ authority: p.authority.publicKey })
    .instruction();
  return sendEr([ix], [p.authority]);
}

/** spike_fill(mode 1): sets every block byte; 0xFF makes spike_tick fail. */
async function fillBlocks(p: SpikePlayer, value: number) {
  const ix = await p.er.methods
    .spikeFill(0, 0, value, 1)
    .accounts({ authority: p.authority.publicKey })
    .instruction();
  await sendEr([ix], [p.authority]);
}

/** Wait until `chunk`'s counter has not changed for `quietMs`. */
async function settle(chunk: web3.PublicKey, quietMs = 600) {
  let last = await counter(chunk);
  for (;;) {
    await sleep(quietMs);
    const now = await counter(chunk);
    if (now === last) return now;
    last = now;
  }
}

describe("spike: cranks on ephemeral accounts", () => {
  let a: SpikePlayer;
  let b: SpikePlayer;

  before(async () => {
    a = await setupPlayer({ depositSol: 0.05, chunk: true });
    b = await setupPlayer({ depositSol: 0.05, chunk: true });
  });

  it("Player PDA schedules 100 ms × 10 ticks on its ephemeral chunk; counter reaches 10", async () => {
    const playerBefore = await erLamports(a.player);
    const walletBefore = await erLamports(a.authority.publicKey);
    const id = randomTaskId();
    const t0 = Date.now();
    const sig = await schedule(a, id, 100, 10);
    const logs = await erLogs(sig);
    console.log("    schedule logs:\n      " + logs.join("\n      "));
    expect(logs.join("\n")).to.include(
      `Scheduled task request with ID: ${id.toString()}`
    );
    const playerAfterSchedule = await erLamports(a.player);

    const reached = await until(
      async () => (await counter(a.chunk)) >= 10,
      5_000,
      25
    );
    const elapsed = Date.now() - t0;
    expect(reached, "counter reached 10 within 5 s").to.equal(true);
    await sleep(1_000);
    expect(await counter(a.chunk)).to.equal(10);

    const playerAfter = await erLamports(a.player);
    const walletAfter = await erLamports(a.authority.publicKey);
    console.log(
      `    10 ticks in ${elapsed} ms; ER lamport deltas: player schedule ${
        playerAfterSchedule - playerBefore
      }, player total ${playerAfter - playerBefore}, wallet ${
        walletAfter - walletBefore
      }`
    );
    expect(playerAfter, "the Player (task payer) is not charged").to.equal(
      playerBefore
    );
  });

  it("cancel stops a 100 ms × 1000 task", async () => {
    const start = await counter(a.chunk);
    const id = randomTaskId();
    await schedule(a, id, 100, 1000);
    await sleep(500);
    const sig = await cancel(a, id);
    console.log(
      "    cancel logs:\n      " + (await erLogs(sig)).join("\n      ")
    );
    const atCancel = await counter(a.chunk);
    await sleep(1_500);
    const later = await counter(a.chunk);
    console.log(
      `    ticks before cancel: ${atCancel - start}, after: ${later - atCancel}`
    );
    expect(atCancel - start).to.be.greaterThanOrEqual(3);
    expect(
      later - atCancel,
      "at most one in-flight tick"
    ).to.be.lessThanOrEqual(1);
  });

  it("rescheduling the same task_id (same authority) replaces the task", async () => {
    const id = randomTaskId();
    await schedule(a, id, 100, 1000);
    await sleep(400);
    await schedule(a, id, 100, 2); // replace: 2 more iterations
    const atReplace = await counter(a.chunk);
    const final = await settle(a.chunk);
    console.log(`    ticks after replace: ${final - atReplace}`);
    expect(final - atReplace).to.be.within(1, 3); // 2 + at most one in flight
  });

  it("task_id is global per validator: another authority cannot take or cancel a live id", async () => {
    const id = randomTaskId();
    await schedule(b, id, 100, 1000);
    await sleep(400);
    const aStart = await counter(a.chunk);
    // Same id from Player A: the tx succeeds (the request is only validated
    // later by the scheduler service) but the task stays B's.
    const sig = await schedule(a, id, 100, 5);
    expect((await erLogs(sig)).join("\n")).to.include("Scheduled task request");
    // A cannot cancel B's task either.
    await cancel(a, id);
    const bAt = await counter(b.chunk);
    await sleep(1_000);
    const aEnd = await counter(a.chunk);
    const bEnd = await counter(b.chunk);
    console.log(`    A ticks: ${aEnd - aStart}, B ticks in 1 s: ${bEnd - bAt}`);
    expect(aEnd - aStart, "A's replacement never ran").to.equal(0);
    expect(bEnd - bAt, "B's task keeps running").to.be.greaterThanOrEqual(5);
    await cancel(b, id);
    await settle(b.chunk);
  });

  it("a failing target ix is retried (not consumed); the task resumes and catches up", async () => {
    const id = randomTaskId();
    await schedule(a, id, 100, 1000);
    await sleep(500);
    await fillBlocks(a, 0xff); // spike_tick now fails
    const failFrom = await erConn.getSlot("confirmed");
    const atFail = await counter(a.chunk);
    await sleep(3_000);
    const afterFail = await counter(a.chunk);
    const failedTicks = (
      await erConn.getSignaturesForAddress(a.chunk, { limit: 1000 })
    ).filter((s) => s.err && s.slot >= failFrom).length;
    await fillBlocks(a, 0); // spike_tick succeeds again
    await sleep(6_000); // > max retry backoff (5 s)
    const resumed = await counter(a.chunk);
    console.log(
      `    while failing (3 s): ${
        afterFail - atFail
      } ticks, ${failedTicks} failed crank txs on the ledger; after fix (6 s): ${
        resumed - afterFail
      } ticks`
    );
    expect(
      afterFail - atFail,
      "no ticks land while failing"
    ).to.be.lessThanOrEqual(1);
    // The ER RPC rejects the crank tx (-32003 transaction verification error);
    // the scheduler retries it with backoff 100 ms, 200 ms, ... capped at 5 s
    // without consuming an iteration, so the task survives a short outage and
    // then catches up on missed ticks (fixed-rate cadence).
    expect(resumed - afterFail).to.be.greaterThan(60);
    await cancel(a, id);
    await settle(a.chunk);
  });

  // ~41 s: run with SLOW_TESTS=1 (e.g. `SLOW_TESTS=1 pnpm test`).
  (process.env.SLOW_TESTS === "1" ? it : it.skip)(
    "a target ix that keeps failing gets the task dropped after 10 retries (~26 s)",
    async () => {
      const id = randomTaskId();
      await schedule(a, id, 100, 1000);
      await sleep(500);
      await fillBlocks(a, 0xff);
      const atFail = await counter(a.chunk);
      await sleep(35_000);
      await fillBlocks(a, 0);
      await sleep(6_000);
      const after = await counter(a.chunk);
      console.log(`    ticks after a 35 s outage + 6 s: ${after - atFail}`);
      expect(after - atFail, "task was dropped").to.be.lessThanOrEqual(1);
      await cancel(a, id); // no-op for a dropped task
    }
  );
});
