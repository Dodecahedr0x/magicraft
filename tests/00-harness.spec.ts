import { expect } from "chai";
import { web3 } from "@anchor-lang/core";
import {
  erConn,
  parseTxError,
  payer,
  program,
  provider,
  sendEr,
  TxError,
} from "./helpers/env";

describe("local ER harness", () => {
  it("pings magicraft on the base layer", async () => {
    const sig = await program.methods.ping().rpc();
    const tx = await provider.connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    expect(tx?.meta?.err).to.equal(null);
    expect(tx?.meta?.logMessages?.some((l) => l.includes("pong v"))).to.equal(
      true
    );
  });

  it("reaches the ephemeral rollup RPC", async () => {
    expect(await erConn.getSlot()).to.be.greaterThan(0);
  });

  it("parses Anchor errors from logs", () => {
    const pid = program.programId.toBase58();
    const err = parseTxError([
      `Program ${pid} invoke [1]`,
      "Program log: AnchorError caused by account: foo. Error Code: ConstraintSeeds. Error Number: 2006. Error Message: A seeds constraint was violated.",
      `Program ${pid} failed: custom program error: 0x7d6`,
    ]);
    expect(err.code).to.equal("ConstraintSeeds");
    expect(err.number).to.equal(2006);
  });

  it("sendEr surfaces the program error of a failed ER transaction", async () => {
    // Unknown discriminator -> Anchor's InstructionFallbackNotFound (101).
    const ix = new web3.TransactionInstruction({
      programId: program.programId,
      keys: [],
      data: Buffer.alloc(8, 0xff),
    });
    const err = await sendEr([ix], [payer]).then(
      () => null,
      (e) => e
    );
    expect(err).to.be.instanceOf(TxError);
    expect(err.number, err.message).to.equal(101);
  });
});
