// Player creation: init + deposit + delegate in one base-layer tx, then the
// ER clones the delegated Player.
import { expect } from "chai";
import { BN, web3 } from "@anchor-lang/core";
import {
  DELEGATION_PROGRAM_ID,
  deriveRentPda,
  lamportsDelegatedTransferIx,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  airdrop,
  baseConn,
  erConn,
  programFor,
  sendEr,
  TxError,
} from "./helpers/env";
import {
  initDepositDelegateIxs,
  LAMPORTS,
  playerPda,
  setupPlayer,
  TestPlayer,
  until,
  waitForEr,
} from "./helpers/player";

async function lamports(conn: web3.Connection, pk: web3.PublicKey) {
  return (await conn.getAccountInfo(pk, "confirmed"))?.lamports ?? 0;
}

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

  it("rejects deposit on a delegated Player (top-ups use lamportsDelegatedTransferIx)", async () => {
    const err = await base.methods
      .deposit(new BN(0.01 * LAMPORTS))
      .accounts({ authority: authority.publicKey })
      .rpc()
      .then(
        () => null,
        (e) => e
      );
    expect(err, "deposit should fail").to.not.equal(null);
    // The delegated Player is owned by the delegation program, so Anchor's
    // Account<Player> owner check fails.
    expect(err.error?.errorCode?.code, String(err)).to.equal(
      "AccountOwnedByWrongProgram"
    );
    const info = await baseConn.getAccountInfo(player, "confirmed");
    expect(info!.lamports).to.equal(
      (await baseConn.getMinimumBalanceForRentExemption(info!.data.length)) +
        deposit
    );
  });
});

describe("player lifecycle: top-up and withdraw", () => {
  const deposit = 0.05 * LAMPORTS;
  const topUp = 0.02 * LAMPORTS;
  let p: TestPlayer;
  let rentExempt: number;
  let baseAtSync: number; // base Player balance at delegation
  let erAtSync: number; // ER Player balance at delegation
  let erBal: number;

  before(async () => {
    p = await setupPlayer({ depositSol: deposit / LAMPORTS });
    const info = await baseConn.getAccountInfo(p.player, "confirmed");
    rentExempt = await baseConn.getMinimumBalanceForRentExemption(
      info!.data.length
    );
    baseAtSync = info!.lamports;
    expect(baseAtSync).to.equal(rentExempt + deposit);
    erAtSync = erBal = await lamports(erConn, p.player);
    expect(erAtSync).to.equal(baseAtSync);
  });

  it("starts with open_chunks = 0", async () => {
    const acc = await p.er.account.player.fetch(p.player);
    expect(acc.openChunks).to.equal(0);
  });

  it("tops up the delegated Player with lamportsDelegatedTransferIx (ER credited within ~1 s)", async () => {
    // The e-SPL global rent PDA sponsors the single-use lamports PDA's
    // delegation; it is pre-funded on MagicBlock clusters, fund it locally.
    const [rentPda] = deriveRentPda();
    if ((await lamports(baseConn, rentPda)) < 0.1 * LAMPORTS) {
      await p.base.provider.sendAndConfirm!(
        new web3.Transaction().add(
          web3.SystemProgram.transfer({
            fromPubkey: p.authority.publicKey,
            toPubkey: rentPda,
            lamports: LAMPORTS,
          })
        ),
        [],
        { skipPreflight: true }
      );
    }
    const salt = crypto.getRandomValues(new Uint8Array(32));
    await p.base.provider.sendAndConfirm!(
      new web3.Transaction().add(
        lamportsDelegatedTransferIx(
          p.authority.publicKey,
          p.player,
          BigInt(topUp),
          salt
        )
      ),
      [],
      { skipPreflight: true }
    );
    const t0 = Date.now();
    const credited = await until(
      async () => (await lamports(erConn, p.player)) === erBal + topUp,
      2_000,
      50
    );
    console.log(`    ER credited the top-up after ${Date.now() - t0} ms`);
    expect(credited, "ER Player +topUp").to.equal(true);
    erBal += topUp;
    expect(
      await lamports(baseConn, p.player),
      "base Player unchanged until commit"
    ).to.equal(baseAtSync);
  });

  it("withdraw by a non-authority signer is rejected", async () => {
    // The Player PDA is derived from the signer, so another wallet can only
    // address its own (non-existent) Player.
    const other = web3.Keypair.generate();
    const err = await sendEr(
      [
        await p.er.methods
          .withdraw()
          .accountsPartial({
            authority: other.publicKey,
            player: p.player,
          })
          .instruction(),
      ],
      [other]
    ).then(
      () => null,
      (e: TxError) => e
    );
    expect(err?.code, String(err)).to.equal("ConstraintSeeds");
  });

  it("rejects withdraw_base while the Player is delegated", async () => {
    const err = await p.base.methods
      .withdrawBase(new BN(1))
      .accounts({ authority: p.authority.publicKey })
      .rpc()
      .then(
        () => null,
        (e) => e
      );
    expect(err?.error?.errorCode?.code, String(err)).to.equal(
      "AccountOwnedByWrongProgram"
    );
  });

  it("withdraw (ER) commits and undelegates; base settles by the ER delta", async () => {
    const sig = await sendEr(
      [
        await p.er.methods
          .withdraw()
          .accounts({ authority: p.authority.publicKey })
          .instruction(),
      ],
      [p.authority]
    );
    // Poll base instead of GetCommitmentSignature: on a fresh local ER the
    // first intents take ~10 s, and the ER's signal tx for a bundle can fail
    // (seen once) even though the Player commit + undelegation lands on base.
    const t0 = Date.now();
    const info = await until(
      async () => {
        const i = await baseConn.getAccountInfo(p.player, "confirmed");
        return i?.owner.equals(p.base.programId) ? i : null;
      },
      30_000,
      200
    );
    expect(info, `Player owned by magicraft on base again (ER tx ${sig})`).to
      .not.be.null;
    console.log(`    base settled ${Date.now() - t0} ms after the withdraw tx`);
    const erSpend = erAtSync + topUp - erBal; // 0 until chunks exist (Task 17)
    expect(info!.lamports).to.equal(baseAtSync + topUp - erSpend);
    expect(info!.lamports).to.equal(rentExempt + deposit + topUp);
    const acc = p.base.coder.accounts.decode("player", info!.data);
    expect(acc.authority.toBase58()).to.equal(p.authority.publicKey.toBase58());
    expect(acc.openChunks).to.equal(0);
  });

  it("withdraw_base rejects more than the balance above rent-exempt", async () => {
    const available = (await lamports(baseConn, p.player)) - rentExempt;
    const err = await p.base.methods
      .withdrawBase(new BN(available + 1))
      .accounts({ authority: p.authority.publicKey })
      .rpc()
      .then(
        () => null,
        (e) => e
      );
    expect(err?.error?.errorCode?.code, String(err)).to.equal(
      "InsufficientFunds"
    );
  });

  it("withdraw_base pays everything above rent-exempt to the wallet", async () => {
    const available = (await lamports(baseConn, p.player)) - rentExempt;
    expect(available).to.equal(deposit + topUp);
    const walletBefore = await lamports(baseConn, p.authority.publicKey);
    await p.base.methods
      .withdrawBase(new BN(available))
      .accounts({ authority: p.authority.publicKey })
      .rpc();
    expect(await lamports(baseConn, p.player)).to.equal(rentExempt);
    expect(
      (await lamports(baseConn, p.authority.publicKey)) - walletBefore
    ).to.equal(available - 5_000); // minus the base tx fee
  });
});
