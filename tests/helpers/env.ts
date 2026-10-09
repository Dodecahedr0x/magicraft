// Shared connections/providers for tests against the local stack (scripts/local-er.sh).
// Endpoint env vars follow the MagicBlock local-dev docs.
import * as fs from "fs";
import * as os from "os";
import {
  AnchorError,
  AnchorProvider,
  Program,
  ProgramError,
  Wallet,
  web3,
} from "@anchor-lang/core";
import type { Magicraft } from "../../target/types/magicraft";
import idl from "../../target/idl/magicraft.json";

const BASE_RPC =
  process.env.PROVIDER_ENDPOINT ??
  process.env.ANCHOR_PROVIDER_URL ??
  "http://127.0.0.1:8899";
const BASE_WS = process.env.WS_ENDPOINT ?? "ws://127.0.0.1:8900";
const ER_RPC =
  process.env.EPHEMERAL_PROVIDER_ENDPOINT ?? "http://127.0.0.1:7799";
const ER_WS = process.env.EPHEMERAL_WS_ENDPOINT ?? "ws://127.0.0.1:7800";
const WALLET_PATH =
  process.env.ANCHOR_WALLET ?? `${os.homedir()}/.config/solana/id.json`;

export const payer = web3.Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_PATH, "utf8")))
);

export const baseConn = new web3.Connection(BASE_RPC, {
  commitment: "confirmed",
  wsEndpoint: BASE_WS,
});
export const erConn = new web3.Connection(ER_RPC, {
  commitment: "confirmed",
  wsEndpoint: ER_WS,
});

/** Program client that signs and pays with `kp` on the given connection. */
export function programFor(
  conn: web3.Connection,
  kp: web3.Keypair,
  opts: web3.ConfirmOptions = {}
): Program<Magicraft> {
  const p = new AnchorProvider(conn, new Wallet(kp), {
    commitment: "confirmed",
    ...opts,
  });
  return new Program<Magicraft>(idl as Magicraft, p);
}

/** ER program client for `kp`. The ER does not need preflight simulation
 *  (matches MagicBlock examples). */
export function erProgramFor(kp: web3.Keypair): Program<Magicraft> {
  return programFor(erConn, kp, { skipPreflight: true });
}

export const program = programFor(baseConn, payer);
export const erProgram = erProgramFor(payer);
export const provider = program.provider as AnchorProvider;
export const erProvider = erProgram.provider as AnchorProvider;

/** Failed transaction with its logs and, when recognisable, the program error. */
export class TxError extends Error {
  constructor(
    message: string,
    readonly logs: string[],
    readonly code?: string, // Anchor error name, e.g. "ConstraintSeeds"
    readonly number?: number
  ) {
    super(message);
  }
}

const idlErrors = new Map<number, string>(
  (
    (idl as { errors?: { code: number; msg?: string; name: string }[] })
      .errors ?? []
  ).map((e) => [e.code, e.msg ?? e.name])
);

/** Build a TxError from transaction logs (and the raw RPC error, if any). */
export function parseTxError(logs: string[], err?: unknown): TxError {
  const anchor = AnchorError.parse(logs);
  if (anchor) {
    const { code, number } = anchor.error.errorCode;
    return new TxError(
      `${code} (${number}): ${anchor.error.errorMessage}\n${logs.join("\n")}`,
      logs,
      code,
      number
    );
  }
  const raw = err === undefined ? "" : JSON.stringify(err);
  const prog = ProgramError.parse({ toString: () => raw, logs }, idlErrors);
  if (prog) {
    return new TxError(
      `program error ${prog.code}: ${prog.msg}\n${logs.join("\n")}`,
      logs,
      undefined,
      prog.code
    );
  }
  return new TxError(`transaction failed: ${raw}\n${logs.join("\n")}`, logs);
}

/** Send a transaction on the ER (first signer pays). Throws TxError on failure.
 *  Polls getSignatureStatuses instead of confirmTransaction: some failures
 *  (e.g. InvalidRealloc) otherwise confirm only at blockhash expiry (~30 s). */
export async function sendEr(
  txOrIxs: web3.Transaction | web3.TransactionInstruction[],
  signers: web3.Keypair[],
  timeoutMs = 30_000
): Promise<string> {
  const tx = Array.isArray(txOrIxs)
    ? new web3.Transaction().add(...txOrIxs)
    : txOrIxs;
  tx.feePayer ??= signers[0].publicKey;
  const bh = await erConn.getLatestBlockhash();
  tx.recentBlockhash = bh.blockhash;
  tx.sign(...signers);
  const sig = await erConn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
  });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = (await erConn.getSignatureStatuses([sig])).value[0];
    if (st?.err) {
      // The status can show the error before getTransaction serves the tx.
      let info: web3.VersionedTransactionResponse | null = null;
      for (let i = 0; i < 40 && !info; i++) {
        info = await erConn.getTransaction(sig, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (!info) await new Promise((r) => setTimeout(r, 50));
      }
      throw parseTxError(info?.meta?.logMessages ?? [], st.err);
    }
    if (
      st?.confirmationStatus === "confirmed" ||
      st?.confirmationStatus === "finalized"
    ) {
      return sig;
    }
    if (Date.now() > deadline) {
      throw new TxError(`ER tx ${sig} not confirmed in ${timeoutMs} ms`, []);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Poll until `pk` exists on `conn` and satisfies `predicate`. */
export async function waitForAccount(
  conn: web3.Connection,
  pk: web3.PublicKey,
  predicate: (info: web3.AccountInfo<Buffer>) => boolean = () => true,
  timeoutMs = 10_000
): Promise<web3.AccountInfo<Buffer>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await conn.getAccountInfo(pk, "confirmed");
    if (info && predicate(info)) return info;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for account ${pk.toBase58()}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Airdrop `sol` SOL on the base layer and wait for confirmation. */
export async function airdrop(pk: web3.PublicKey, sol: number): Promise<void> {
  const sig = await baseConn.requestAirdrop(pk, sol * web3.LAMPORTS_PER_SOL);
  const bh = await baseConn.getLatestBlockhash();
  await baseConn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}
