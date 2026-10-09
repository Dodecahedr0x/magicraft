// Shared connections/providers for tests against the local stack (scripts/local-er.sh).
// Endpoint env vars follow the MagicBlock local-dev docs.
import * as fs from "fs";
import * as os from "os";
import { AnchorProvider, Program, Wallet, web3 } from "@anchor-lang/core";
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

const payer = web3.Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_PATH, "utf8")))
);
const wallet = new Wallet(payer);

export const baseConn = new web3.Connection(BASE_RPC, {
  commitment: "confirmed",
  wsEndpoint: BASE_WS,
});
export const erConn = new web3.Connection(ER_RPC, {
  commitment: "confirmed",
  wsEndpoint: ER_WS,
});

export const provider = new AnchorProvider(baseConn, wallet, {
  commitment: "confirmed",
});
// The ER does not need preflight simulation; skipping it matches MagicBlock examples.
export const erProvider = new AnchorProvider(erConn, wallet, {
  commitment: "confirmed",
  skipPreflight: true,
});

export const program = new Program<Magicraft>(idl as Magicraft, provider);
export const erProgram = new Program<Magicraft>(idl as Magicraft, erProvider);

/** Airdrop `sol` SOL on the base layer and wait for confirmation. */
export async function airdrop(pk: web3.PublicKey, sol: number): Promise<void> {
  const sig = await baseConn.requestAirdrop(pk, sol * web3.LAMPORTS_PER_SOL);
  const bh = await baseConn.getLatestBlockhash();
  await baseConn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}
