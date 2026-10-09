// Task 3 spike: a delegated Player PDA sponsors a 16.8 KB ephemeral chunk.
// The spike_* instructions are temporary (removed in Task 6); init_player,
// deposit and delegate_player are kept.
import { expect } from "chai";
import { BN, web3 } from "@anchor-lang/core";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  airdrop,
  baseConn,
  erConn,
  erProgramFor,
  programFor,
  sendEr,
  TxError,
} from "./helpers/env";

const LOCAL_ER_VALIDATOR = new web3.PublicKey(
  "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev"
);
const CHUNK_LEN = 16_384 + 512; // blocks + header budget
const MAX_CPI_GROWTH = 10_240; // SVM MAX_PERMITTED_DATA_INCREASE
const ephemeralRent = (len: number) => (len + 60) * 32;

function i32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
}

/** "consumed X of Y compute units" for our program's top-level invocation. */
function computeUnits(logs: string[], programId: web3.PublicKey) {
  const re = new RegExp(
    `^Program ${programId.toBase58()} consumed (\\d+) of (\\d+) compute units$`
  );
  for (const l of logs) {
    const m = l.match(re);
    if (m) return { consumed: Number(m[1]), limit: Number(m[2]) };
  }
  throw new Error(`no CU line in logs:\n${logs.join("\n")}`);
}

function allComputeUnits(logs: string[], programId: web3.PublicKey) {
  const prefix = `Program ${programId.toBase58()} consumed `;
  return logs
    .filter((l) => l.startsWith(prefix))
    .map((l) => l.slice(prefix.length));
}

async function erLogs(sig: string): Promise<string[]> {
  const tx = await erConn.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  return tx?.meta?.logMessages ?? [];
}

describe("spike: ephemeral chunk sponsored by Player", () => {
  const authority = web3.Keypair.generate();
  const base = programFor(baseConn, authority);
  const er = erProgramFor(authority);
  const [player] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("player"), authority.publicKey.toBuffer()],
    base.programId
  );
  const [chunk] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("chunk"), player.toBuffer(), i32le(0), i32le(0)],
    base.programId
  );

  before(async () => {
    await airdrop(authority.publicKey, 2);
  });

  it("inits, funds and delegates the Player in one base-layer tx", async () => {
    const deposit = 0.05 * web3.LAMPORTS_PER_SOL;
    const tx = new web3.Transaction().add(
      await base.methods
        .initPlayer()
        .accounts({ authority: authority.publicKey })
        .instruction(),
      await base.methods
        .deposit(new BN(deposit))
        .accounts({ authority: authority.publicKey })
        .instruction(),
      await base.methods
        .delegatePlayer(LOCAL_ER_VALIDATOR)
        .accounts({ authority: authority.publicKey })
        .instruction()
    );
    await base.provider.sendAndConfirm!(tx, [], { skipPreflight: true });

    const info = await baseConn.getAccountInfo(player);
    expect(info?.owner.toBase58()).to.equal(DELEGATION_PROGRAM_ID.toBase58());
    const rentExempt = await baseConn.getMinimumBalanceForRentExemption(
      info!.data.length
    );
    expect(info!.lamports).to.equal(rentExempt + deposit);
  });

  it("cannot create > 10 KiB in one ix (CPI realloc cap)", async () => {
    await waitForEr(player); // the ER clones the delegated Player on first use
    const ix = await er.methods
      .spikeChunk(0, 0, CHUNK_LEN)
      .accounts({ authority: authority.publicKey })
      .instruction();
    // Slow (~30 s): the ER confirms this InvalidRealloc failure only once the
    // blockhash expires (see docs/notes/spikes.md).
    const err = await sendEr([ix], [authority]).then(
      () => null,
      (e: TxError) => e
    );
    expect(err, "single-ix 16 896-byte create should fail").to.not.equal(null);
    expect(err!.logs.join("\n")).to.include(
      "Account data size realloc limited to 10240 in inner instructions"
    );
    expect(await erConn.getAccountInfo(chunk)).to.equal(null);
  });

  it("creates 10 240 bytes then resizes to 16 896 (two ixs, one tx), paid by the Player", async () => {
    const before = await waitForEr(player);
    expect(before.owner.toBase58()).to.equal(base.programId.toBase58());

    const ixs = [
      await er.methods
        .spikeChunk(0, 0, MAX_CPI_GROWTH)
        .accounts({ authority: authority.publicKey })
        .instruction(),
      await er.methods
        .spikeResize(0, 0, CHUNK_LEN)
        .accounts({ authority: authority.publicKey })
        .instruction(),
    ];
    const sig = await sendEr(ixs, [authority]);
    const logs = await erLogs(sig);
    console.log("    create+resize CU:", allComputeUnits(logs, er.programId));

    const acc = await erConn.getAccountInfo(chunk, "confirmed");
    expect(acc, "chunk exists on ER").to.not.equal(null);
    expect(acc!.data.length).to.equal(16_896);
    expect(acc!.owner.toBase58()).to.equal(er.programId.toBase58());
    expect(await baseConn.getAccountInfo(chunk)).to.equal(null);

    const after = await erConn.getAccountInfo(player, "confirmed");
    const delta = before.lamports - after!.lamports;
    console.log("    player rent delta:", delta);
    expect(delta).to.equal(ephemeralRent(CHUNK_LEN));
    expect(delta).to.equal(542_592);
  });

  for (const [mode, name] of [
    [0, "byte loop"],
    [1, "slice fill"],
    [2, "copy_from_slice"],
    [3, "no-op baseline"],
    [4, "per-byte hash"],
  ] as const) {
    it(`fills all 16 384 block bytes in one ix (${name})`, async () => {
      const value = 1 + mode;
      const ix = await er.methods
        .spikeFill(0, 0, value, mode)
        .accounts({ authority: authority.publicKey })
        .instruction();
      const sig = await sendEr([ix], [authority]);
      const cu = computeUnits(await erLogs(sig), er.programId);
      console.log(`    spike_fill ${name} CU:`, cu);

      const acc = await erConn.getAccountInfo(chunk, "confirmed");
      const blocks = acc!.data.subarray(512, 512 + 16_384);
      const expected = (i: number) =>
        mode === 3
          ? 3 // untouched: still the mode-2 value
          : mode === 4
          ? Number(
              ((BigInt(Math.imul(i, 0x9e3779b1) >>> 0) ^ BigInt(value)) >>
                29n) &
                0xffn
            )
          : value;
      expect(blocks.every((b, i) => b === expected(i))).to.equal(true);
    });
  }

  it("reports the ER compute limit with and without a ComputeBudget ix", async () => {
    const fill = () =>
      er.methods
        .spikeFill(0, 0, 9, 1)
        .accounts({ authority: authority.publicKey })
        .instruction();
    const plain = computeUnits(
      await erLogs(await sendEr([await fill()], [authority])),
      er.programId
    );
    const raised = computeUnits(
      await erLogs(
        await sendEr(
          [
            web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
            await fill(),
          ],
          [authority]
        )
      ),
      er.programId
    );
    console.log(
      "    ER CU limit default:",
      plain.limit,
      "with 1.4M:",
      raised.limit
    );
    expect(plain.limit).to.be.greaterThan(0);
    expect(plain.limit).to.equal(200_000);
    // The ComputeBudget ix itself is charged 150 CU of the 1.4M.
    expect(raised.limit).to.equal(1_400_000 - 150);
  });
});

async function waitForEr(pk: web3.PublicKey) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const info = await erConn.getAccountInfo(pk, "confirmed");
    if (info) return info;
    if (Date.now() > deadline) throw new Error(`ER never cloned ${pk}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
