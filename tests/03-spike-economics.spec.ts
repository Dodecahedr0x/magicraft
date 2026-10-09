// Task 4 spike: topping up a delegated Player, and how ER-side ephemeral rent
// settles to the base layer on commit / undelegate. spike_* ixs are temporary.
import { expect } from "chai";
import { BN, web3 } from "@anchor-lang/core";
import {
  DELEGATION_PROGRAM_ID,
  GetCommitmentSignature,
  deriveLamportsPda,
  deriveRentPda,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  lamportsDelegatedTransferIx,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { baseConn, erConn, sendEr, TxError } from "./helpers/env";
import {
  CHUNK_LEN,
  i32le,
  LAMPORTS,
  LOCAL_ER_VALIDATOR,
  setupPlayer,
  sleep,
  SpikePlayer,
  until,
} from "./helpers/spike";

const RENT = (CHUNK_LEN + 60) * 32; // 542 592: ephemeral rent of one chunk

async function lamports(conn: web3.Connection, pk: web3.PublicKey) {
  return (await conn.getAccountInfo(pk, "confirmed"))?.lamports ?? 0;
}

async function logBaseTxDeltas(label: string, sig: string) {
  const tx = await baseConn.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.meta) return console.log(`    ${label}: not found`);
  const named = new Map<string, string>([
    [LOCAL_ER_VALIDATOR.toBase58(), "validator identity"],
    [deriveRentPda()[0].toBase58(), "e-SPL rent PDA"],
  ]);
  const keys = tx.transaction.message.getAccountKeys().staticAccountKeys;
  console.log(`    ${label} lamport deltas:`);
  keys.forEach((k, i) => {
    const d = tx.meta!.postBalances[i] - tx.meta!.preBalances[i];
    if (d !== 0)
      console.log(`      ${named.get(k.toBase58()) ?? k.toBase58()}: ${d}`);
  });
}

async function sendBase(p: SpikePlayer, ixs: web3.TransactionInstruction[]) {
  return p.base.provider.sendAndConfirm!(
    new web3.Transaction().add(...ixs),
    [],
    { skipPreflight: true }
  );
}

describe("spike: Player top-up and settlement", () => {
  let p: SpikePlayer;
  let chunk2: web3.PublicKey; // left open across undelegation
  let lamportsPda: web3.PublicKey;
  // Last known balances of the Player on each layer.
  let erBal: number;
  let baseBal: number;
  let erAtSync: number; // ER balance when base and ER last agreed (delegation / commit)

  async function chunkIxs(cx: number) {
    return [
      await p.er.methods
        .spikeChunk(cx, 0, 10_240)
        .accounts({ authority: p.authority.publicKey })
        .instruction(),
      await p.er.methods
        .spikeResize(cx, 0, CHUNK_LEN)
        .accounts({ authority: p.authority.publicKey })
        .instruction(),
    ];
  }

  async function closeIx(cx: number) {
    return p.er.methods
      .spikeClose(cx, 0)
      .accounts({ authority: p.authority.publicKey })
      .instruction();
  }

  async function commit(undelegate: boolean) {
    const sig = await sendEr(
      [
        await p.er.methods
          .spikeCommit(undelegate)
          .accounts({ authority: p.authority.publicKey })
          .instruction(),
      ],
      [p.authority]
    );
    return GetCommitmentSignature(sig, erConn);
  }

  before(async () => {
    p = await setupPlayer({ depositSol: 0.05 });
    [chunk2] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("chunk"), p.player.toBuffer(), i32le(1), i32le(0)],
      p.base.programId
    );
    baseBal = await lamports(baseConn, p.player);
    erBal = await lamports(erConn, p.player);
    expect(erBal).to.equal(baseBal);
    erAtSync = erBal;
  });

  it("(ii) plain base-layer transfer to the delegated PDA: base grows, the ER never sees it", async () => {
    const amount = 0.01 * LAMPORTS;
    await sendBase(p, [
      web3.SystemProgram.transfer({
        fromPubkey: p.authority.publicKey,
        toPubkey: p.player,
        lamports: amount,
      }),
    ]);
    baseBal += amount;
    expect(await lamports(baseConn, p.player)).to.equal(baseBal);
    await sleep(3_000);
    expect(await lamports(erConn, p.player), "ER unchanged").to.equal(erBal);
  });

  it("(iii) lamportsDelegatedTransferIx (one base tx) credits the delegated Player on the ER", async () => {
    // The e-SPL program's global rent PDA sponsors the delegation of the
    // single-use lamports PDA (it paid a net 6 764 400 lamports per top-up in
    // our runs). It is pre-funded on devnet/mainnet; fund it locally.
    const [rentPda] = deriveRentPda();
    if ((await lamports(baseConn, rentPda)) < 0.1 * LAMPORTS) {
      await sendBase(p, [
        web3.SystemProgram.transfer({
          fromPubkey: p.authority.publicKey,
          toPubkey: rentPda,
          lamports: LAMPORTS,
        }),
      ]);
    }
    const rentBefore = await lamports(baseConn, rentPda);
    const walletBefore = await lamports(baseConn, p.authority.publicKey);
    const amount = 0.02 * LAMPORTS;
    const salt = crypto.getRandomValues(new Uint8Array(32));
    [lamportsPda] = deriveLamportsPda(p.authority.publicKey, p.player, salt);
    const topUpSig = await sendBase(p, [
      lamportsDelegatedTransferIx(
        p.authority.publicKey,
        p.player,
        BigInt(amount),
        salt
      ),
    ]);
    const walletCost =
      walletBefore - (await lamports(baseConn, p.authority.publicKey));
    // Full lamport accounting of the top-up tx.
    const tx = await baseConn.getTransaction(topUpSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const keys = tx!.transaction.message.getAccountKeys().staticAccountKeys;
    const names = new Map<string, string>([
      [p.authority.publicKey.toBase58(), "wallet"],
      [rentPda.toBase58(), "e-SPL rent PDA"],
      [lamportsPda.toBase58(), "lamports PDA"],
      [p.player.toBase58(), "Player"],
      [
        delegationRecordPdaFromDelegatedAccount(lamportsPda).toBase58(),
        "lamports PDA delegation record",
      ],
      [
        delegationMetadataPdaFromDelegatedAccount(lamportsPda).toBase58(),
        "lamports PDA delegation metadata",
      ],
    ]);
    console.log("    top-up tx lamport deltas:");
    keys.forEach((k, i) => {
      const d = tx!.meta!.postBalances[i] - tx!.meta!.preBalances[i];
      if (d !== 0)
        console.log(`      ${names.get(k.toBase58()) ?? k.toBase58()}: ${d}`);
    });
    const rentDelta = (await lamports(baseConn, rentPda)) - rentBefore;
    const t0 = Date.now();
    const credited = await until(
      async () => (await lamports(erConn, p.player)) !== erBal,
      20_000,
      50
    );
    const erNow = await lamports(erConn, p.player);
    console.log(
      `    ER Player +${erNow - erBal} after ${
        Date.now() - t0
      } ms; wallet paid ${walletCost} (amount + ${
        walletCost - amount
      }); rent PDA ${rentDelta}; lamports PDA on base ${await lamports(
        baseConn,
        lamportsPda
      )}`
    );
    expect(credited, "ER credited the top-up").to.equal(true);
    expect(erNow - erBal).to.equal(amount);
    erBal = erNow;
    expect(
      await lamports(baseConn, p.player),
      "base Player untouched"
    ).to.equal(baseBal);
  });

  it("ephemeral rent moves Player lamports into the vault on the ER (two chunks)", async () => {
    await sendEr(await chunkIxs(0), [p.authority]);
    await sendEr(await chunkIxs(1), [p.authority]);
    const erNow = await lamports(erConn, p.player);
    expect(erBal - erNow).to.equal(2 * RENT);
    erBal = erNow;
  });

  it("commit: base Player moves by the ER-side delta (top-up minus rent); base-only transfers survive", async () => {
    const lpBefore = await lamports(baseConn, lamportsPda);
    const [rentPda] = deriveRentPda();
    const watch = [rentPda, LOCAL_ER_VALIDATOR, p.authority.publicKey];
    const watchBefore = await Promise.all(
      watch.map((k) => lamports(baseConn, k))
    );
    const commitSig = await commit(false);
    await logBaseTxDeltas("base commit tx", commitSig);
    await until(
      async () => (await lamports(baseConn, p.player)) !== baseBal,
      15_000,
      200
    );
    const base = await lamports(baseConn, p.player);
    console.log(
      `    commit: base ${baseBal} -> ${base} (Δ ${
        base - baseBal
      }); ER ${erBal} (Δ since sync ${
        erBal - erAtSync
      }); lamports PDA on base ${lpBefore} -> ${await lamports(
        baseConn,
        lamportsPda
      )}`
    );
    await sleep(2_000); // let the lamports PDA's own undelegation land
    for (const { signature } of (
      await baseConn.getSignaturesForAddress(lamportsPda)
    ).reverse()) {
      await logBaseTxDeltas(
        `lamports PDA tx ${signature.slice(0, 8)}…`,
        signature
      );
    }
    const watchAfter = await Promise.all(
      watch.map((k) => lamports(baseConn, k))
    );
    console.log(
      `    across commit (base): e-SPL rent PDA Δ ${
        watchAfter[0] - watchBefore[0]
      }, validator identity Δ ${watchAfter[1] - watchBefore[1]}, wallet Δ ${
        watchAfter[2] - watchBefore[2]
      }`
    );
    console.log(
      `    after commit: lamports PDA delegation record ${await lamports(
        baseConn,
        delegationRecordPdaFromDelegatedAccount(lamportsPda)
      )}, metadata ${await lamports(
        baseConn,
        delegationMetadataPdaFromDelegatedAccount(lamportsPda)
      )}`
    );
    expect(base - baseBal).to.equal(erBal - erAtSync);
    expect(base - erBal, "the 0.01 SOL base transfer is kept").to.equal(
      0.01 * LAMPORTS
    );
    baseBal = base;
    erAtSync = erBal;
  });

  it("commit after rent only: base drops by exactly the rent", async () => {
    await sendEr(await chunkIxs(2), [p.authority]);
    erBal -= RENT;
    expect(await lamports(erConn, p.player)).to.equal(erBal);
    await commit(false);
    await until(
      async () => (await lamports(baseConn, p.player)) !== baseBal,
      15_000,
      200
    );
    const base = await lamports(baseConn, p.player);
    expect(baseBal - base).to.equal(RENT);
    baseBal = base;
    erAtSync = erBal;
  });

  it("closing a chunk refunds its rent on the ER; commit+undelegate carries it to base", async () => {
    await sendEr([await closeIx(0), await closeIx(2)], [p.authority]);
    const erNow = await lamports(erConn, p.player);
    expect(erNow - erBal).to.equal(2 * RENT);
    erBal = erNow;
    expect(await erConn.getAccountInfo(p.chunk, "confirmed")).to.equal(null);

    await commit(true);
    const owned = await until(
      async () =>
        (
          await baseConn.getAccountInfo(p.player, "confirmed")
        )?.owner.equals(p.base.programId),
      20_000,
      200
    );
    expect(owned, "Player owned by magicraft again on base").to.equal(true);
    const base = await lamports(baseConn, p.player);
    console.log(
      `    undelegate: base ${baseBal} -> ${base} (Δ ${base - baseBal})`
    );
    expect(base - baseBal).to.equal(erBal - erAtSync);
    baseBal = base;
  });

  it("an open chunk outlives its sponsor's undelegation; its rent is stranded until re-delegation", async () => {
    const c = await erConn.getAccountInfo(chunk2, "confirmed");
    console.log(
      `    chunk (1,0) after undelegate: ${
        c
          ? `${c.data.length} bytes, ${c.lamports} lamports, owner ${c.owner
              .toBase58()
              .slice(0, 8)}…`
          : "gone"
      }`
    );
    expect(c, "chunk still on the ER").to.not.equal(null);
    const err = await sendEr([await closeIx(1)], [p.authority]).then(
      () => null,
      (e: TxError) => e
    );
    console.log(
      `    close while Player undelegated: ${
        err ? err.message.split("\n")[0] : "ok"
      }`
    );
    expect(err, "cannot refund into an undelegated sponsor").to.not.equal(null);
  });

  it("(i) deposit + re-delegate after undelegating; then the stranded chunk can be closed", async () => {
    const amount = 0.01 * LAMPORTS;
    await sendBase(p, [
      await p.base.methods
        .deposit(new BN(amount))
        .accounts({ authority: p.authority.publicKey })
        .instruction(),
      await p.base.methods
        .delegatePlayer(LOCAL_ER_VALIDATOR)
        .accounts({ authority: p.authority.publicKey })
        .instruction(),
    ]);
    baseBal += amount;
    const info = await baseConn.getAccountInfo(p.player);
    expect(info!.owner.toBase58()).to.equal(DELEGATION_PROGRAM_ID.toBase58());
    expect(info!.lamports).to.equal(baseBal);
    const t0 = Date.now();
    const seen = await until(
      async () => (await lamports(erConn, p.player)) === baseBal,
      15_000,
      50
    );
    console.log(`    ER re-cloned the Player after ${Date.now() - t0} ms`);
    expect(seen, "ER re-cloned the Player with the base balance").to.equal(
      true
    );
    erBal = baseBal;

    await sendEr([await closeIx(1)], [p.authority]);
    const erNow = await lamports(erConn, p.player);
    console.log(`    close after re-delegate: ER Player Δ ${erNow - erBal}`);
    expect(erNow - erBal).to.equal(RENT);
  });
});
