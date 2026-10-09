import { expect } from "chai";
import { erConn, program, provider } from "./helpers/env";

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
});
