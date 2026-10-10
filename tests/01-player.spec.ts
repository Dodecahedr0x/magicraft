// Player creation: init + deposit + delegate in one base-layer tx, then the
// ER clones the delegated Player.
import { expect } from "chai";
import { BN, web3 } from "@anchor-lang/core";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
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
  topUp as sendTopUp,
  until,
  waitForEr,
} from "./helpers/player";
import {
  chunkPda,
  CHUNK_TOTAL_RENT,
  createAndGrow,
  SPONSOR_RESERVE_MARGIN,
} from "./helpers/chunk";
import { setupWorld } from "./helpers/world";

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
    await sendTopUp(p, topUp);
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
    // Settlement is delta-based: base moves by the ER change since delegation.
    const erBeforeWithdraw = await lamports(erConn, p.player);
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
    expect(info!.lamports).to.equal(baseAtSync + (erBeforeWithdraw - erAtSync));
    // No ER spend yet (chunks arrive in Task 17), so the delta is the top-up.
    expect(erBeforeWithdraw - erAtSync).to.equal(topUp);
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

describe("player sponsoring with chunks", () => {
  it("withdraw with an open chunk succeeds; base reflects the chunk rent spent on the ER", async () => {
    const { p, world } = await setupWorld({ depositSol: 0.05 });
    const baseAtSync = await lamports(baseConn, p.player);
    const erAtSync = baseAtSync; // nothing committed since delegation
    await createAndGrow(p, world, 0, 0);
    const erBefore = await lamports(erConn, p.player);
    expect((await p.er.account.player.fetch(p.player)).openChunks).to.equal(1);

    await sendEr(
      [
        await p.er.methods
          .withdraw()
          .accounts({ authority: p.authority.publicKey })
          .instruction(),
      ],
      [p.authority]
    );
    const info = await until(
      async () => {
        const i = await baseConn.getAccountInfo(p.player, "confirmed");
        return i?.owner.equals(p.base.programId) ? i : null;
      },
      30_000,
      200
    );
    expect(info, "Player owned by magicraft on base again").to.not.be.null;
    // ER spend = World rent + VRF request (if any) + chunk rent; base moves by it.
    expect(erAtSync - erBefore).to.be.at.least(CHUNK_TOTAL_RENT);
    expect(info!.lamports).to.equal(baseAtSync + (erBefore - erAtSync));
    const acc = p.base.coder.accounts.decode("player", info!.data);
    expect(acc.openChunks).to.equal(1); // UI warning only; withdraw not blocked
    // The open chunk survives the sponsor's undelegation on the ER.
    const chunk = await erConn.getAccountInfo(
      chunkPda(world, 0, 0),
      "confirmed"
    );
    expect(chunk?.data.length).to.equal(17_536);
  });

  it("sponsoring stops at rent_exempt(Player) + margin (InsufficientSponsorFunds)", async () => {
    // A rich player owns the seeded world; poor players create its first chunk
    // (any session-authed delegated Player may sponsor (0,0)). A Player starts
    // with rent_exempt + deposit, so the deposit is exactly its spendable excess.
    const { world } = await setupWorld({ depositSol: 0.05 });
    const need = CHUNK_TOTAL_RENT + SPONSOR_RESERVE_MARGIN;
    const short = await setupPlayer({ depositSol: (need - 1) / LAMPORTS });
    const err = await createAndGrow(short, world, 0, 0).then(
      () => null,
      (e: TxError) => e
    );
    expect(err?.code, String(err)).to.equal("InsufficientSponsorFunds");
    expect(err?.number).to.equal(6104);

    const exact = await setupPlayer({ depositSol: need / LAMPORTS });
    await createAndGrow(exact, world, 0, 0);
    const info = await erConn.getAccountInfo(exact.player, "confirmed");
    // (The ER's getMinimumBalanceForRentExemption returns 0; the program's Rent
    // sysvar matches base.)
    const rentMin = await baseConn.getMinimumBalanceForRentExemption(
      info!.data.length
    );
    expect(info!.lamports).to.equal(rentMin + SPONSOR_RESERVE_MARGIN);
  });
});
