// Player creation: init + deposit + delegate in one base-layer tx, then the
// ER clones the delegated Player.
import { expect } from "chai";
import { web3 } from "@anchor-lang/core";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { airdrop, baseConn, programFor } from "./helpers/env";
import {
  initDepositDelegateIxs,
  LAMPORTS,
  playerPda,
  waitForEr,
} from "./helpers/player";

describe("player", () => {
  const authority = web3.Keypair.generate();
  const base = programFor(baseConn, authority);
  const player = playerPda(authority.publicKey, base.programId);
  const deposit = 0.05 * LAMPORTS;

  before(async () => {
    await airdrop(authority.publicKey, 2);
  });

  it("inits, funds and delegates the Player in one base-layer tx", async () => {
    const tx = new web3.Transaction().add(
      ...(await initDepositDelegateIxs(authority.publicKey, deposit))
    );
    await base.provider.sendAndConfirm!(tx, [], { skipPreflight: true });

    const info = await baseConn.getAccountInfo(player, "confirmed");
    expect(info?.owner.toBase58()).to.equal(DELEGATION_PROGRAM_ID.toBase58());
    const rentExempt = await baseConn.getMinimumBalanceForRentExemption(
      info!.data.length
    );
    expect(info!.lamports).to.equal(rentExempt + deposit);
  });

  it("is visible on the ER, owned by magicraft, with the same state", async () => {
    const info = await waitForEr(player);
    expect(info.owner.toBase58()).to.equal(base.programId.toBase58());
    const acc = base.coder.accounts.decode("player", info.data);
    expect(acc.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    const [, bump] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("player"), authority.publicKey.toBuffer()],
      base.programId
    );
    expect(acc.bump).to.equal(bump);
    const baseInfo = await baseConn.getAccountInfo(player, "confirmed");
    expect(info.lamports).to.equal(baseInfo!.lamports);
  });
});
