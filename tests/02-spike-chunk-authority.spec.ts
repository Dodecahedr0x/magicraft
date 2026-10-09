// TEMPORARY spike: the ephemeral, non-delegated chunk PDA itself as the
// ScheduleTask / CancelTask authority (account 0, signing via invoke_signed).
import { expect } from "chai";
import { BN, web3 } from "@anchor-lang/core";
import { erConn, sendEr } from "./helpers/env";
import { setupPlayer, sleep, TestPlayer, until } from "./helpers/player";

const randomTaskId = () => new BN(Math.floor(Math.random() * 2 ** 47) + 1);

async function counter(chunk: web3.PublicKey): Promise<number> {
  const info = await erConn.getAccountInfo(chunk, "confirmed");
  return Number(info!.data.readBigUInt64LE(0));
}

async function settle(chunk: web3.PublicKey, quietMs = 600) {
  let last = await counter(chunk);
  for (;;) {
    await sleep(quietMs);
    const now = await counter(chunk);
    if (now === last) return now;
    last = now;
  }
}

describe("spike: chunk PDA as crank authority", () => {
  let p: TestPlayer;
  let chunk: web3.PublicKey;
  const stranger = web3.Keypair.generate(); // 0 lamports anywhere

  async function schedule(
    caller: web3.Keypair,
    id: BN,
    intervalMs: number,
    iterations: number
  ) {
    const ix = await p.er.methods
      .spikeChunkSchedule(
        p.player,
        0,
        0,
        id,
        new BN(intervalMs),
        new BN(iterations)
      )
      .accounts({ caller: caller.publicKey })
      .instruction();
    return sendEr([ix], [caller]);
  }
  async function cancel(caller: web3.Keypair, id: BN) {
    const ix = await p.er.methods
      .spikeChunkCancel(p.player, 0, 0, id)
      .accounts({ caller: caller.publicKey })
      .instruction();
    return sendEr([ix], [caller]);
  }

  before(async () => {
    p = await setupPlayer({ depositSol: 0.05 });
    [chunk] = web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("chunk"),
        p.player.toBuffer(),
        Buffer.alloc(4),
        Buffer.alloc(4),
      ],
      p.base.programId
    );
    await sendEr(
      [
        await p.er.methods
          .spikeChunk(0, 0)
          .accounts({ authority: p.authority.publicKey })
          .instruction(),
      ],
      [p.authority]
    );
    const info = await erConn.getAccountInfo(chunk, "confirmed");
    console.log(
      `    chunk: ${info!.data.length} B, ${info!.lamports} lamports, owner ${
        info!.owner
      }`
    );
  });

  it("chunk PDA schedules 100 ms × 10 ticks (called by the owner)", async () => {
    const sig = await schedule(p.authority, randomTaskId(), 100, 10);
    const tx = await erConn.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    console.log("    logs:\n      " + tx!.meta!.logMessages!.join("\n      "));
    const reached = await until(
      async () => (await counter(chunk)) >= 10,
      5_000,
      25
    );
    expect(reached, "counter reached 10").to.equal(true);
    await sleep(800);
    expect(await counter(chunk)).to.equal(10);
  });

  it("a different (0-lamport) caller replaces the task with the same id", async () => {
    const id = randomTaskId();
    await schedule(p.authority, id, 100, 1000);
    await until(async () => (await counter(chunk)) >= 13, 3_000, 25);
    await schedule(stranger, id, 100, 2);
    const base = await counter(chunk);
    const end = await settle(chunk);
    console.log(`    after replace: ${end - base} more ticks`);
    expect(end - base).to.be.lessThanOrEqual(3); // 2 + at most one in flight
  });

  it("a different caller cancels the task", async () => {
    const id = randomTaskId();
    await schedule(p.authority, id, 100, 1000);
    await sleep(500);
    await cancel(stranger, id);
    const a = await settle(chunk);
    await sleep(1_000);
    expect(await counter(chunk)).to.equal(a);
  });
});
