// Wallets: Wallet Standard (injected Phantom / Backpack / Solflare / …) and, for local
// development only, a burner keypair kept in localStorage that airdrops itself SOL.
//
// Every tx the app sends with a wallet is signed with `solana:signTransaction` and then
// sent by the app to the RPC it chose (base or ER): ER txs (e.g. `withdraw`) must never go
// to the wallet's own RPC. `solana:signAndSendTransaction` is the fallback for base txs on
// wallets that cannot sign without sending.
import { Buffer } from "buffer";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  type Connection,
} from "@solana/web3.js";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount, IdentifierString } from "@wallet-standard/base";
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
} from "@wallet-standard/features";
import {
  SolanaSignAndSendTransaction,
  SolanaSignTransaction,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";
import type { KeyValueStore } from "./chain";

/** A connected wallet as the app uses it. */
export type AppWallet = {
  /** Display name ("Phantom", "Burner wallet"). */
  name: string;
  icon?: string;
  /** True for the dev burner (no approval popups). */
  burner: boolean;
  publicKey: PublicKey;
  /** Signs `tx` (fee payer + recent blockhash already set); never sends. Null if the
   *  wallet can only sign-and-send. */
  signTransaction: ((tx: Transaction) => Promise<Transaction>) | null;
  /** Signs and sends through the wallet's own RPC (base layer only). */
  signAndSend: ((tx: Transaction) => Promise<string>) | null;
  disconnect(): Promise<void>;
  /** Called when the wallet switches / drops its account. Returns an unsubscribe. */
  onChange(cb: () => void): () => void;
};

// ---------------------------------------------------------------- burner (dev only)

/** RPC URLs that point at this machine (the local stack). */
export function isLocalRpc(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** The burner is offered (in any build) when the base RPC is local, or when explicitly
 *  enabled (`VITE_BURNER=1`, e.g. a devnet test deployment); never against mainnet. */
export function burnerAllowed(baseRpc: string, explicit?: string | boolean): boolean {
  if (isLocalRpc(baseRpc)) return true;
  const on = explicit === true || explicit === "1" || explicit === "true";
  return on && chainFor(baseRpc) !== "solana:mainnet";
}

/** One burner per base RPC (a fresh local ledger keeps the same key; airdrops refill it). */
export const burnerKey = (baseRpc: string) => `magicraft.burner.${baseRpc}`;

/** The stored burner keypair, or null if absent / corrupt (a corrupt entry is removed). */
export function loadBurner(store: KeyValueStore | null, key: string): Keypair | null {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as { v?: number; secret?: unknown };
    if (v?.v !== 1 || typeof v.secret !== "string") throw new Error("bad burner entry");
    const bytes = Buffer.from(v.secret, "base64");
    if (bytes.length !== 64) throw new Error("bad burner key length");
    return Keypair.fromSecretKey(bytes);
  } catch {
    try {
      store.removeItem(key);
    } catch {
      /* storage unavailable */
    }
    return null;
  }
}

export function saveBurner(store: KeyValueStore | null, key: string, kp: Keypair): boolean {
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify({ v: 1, secret: Buffer.from(kp.secretKey).toString("base64") }));
    return true;
  } catch {
    return false;
  }
}

/** Loads or creates the burner (in memory only if storage is unavailable). */
export function burnerKeypair(store: KeyValueStore | null, baseRpc: string): Keypair {
  const key = burnerKey(baseRpc);
  const kp = loadBurner(store, key);
  if (kp) return kp;
  const fresh = Keypair.generate();
  saveBurner(store, key, fresh);
  return fresh;
}

/** Airdrops the burner up to ~2 SOL when it holds less than 1 SOL (local faucet). */
export async function fundBurner(base: Connection, pk: PublicKey): Promise<void> {
  if ((await base.getBalance(pk, "confirmed")) >= LAMPORTS_PER_SOL) return;
  const sig = await base.requestAirdrop(pk, 2 * LAMPORTS_PER_SOL);
  await confirmSig(base, sig, 30_000);
}

export function burnerWallet(kp: Keypair): AppWallet {
  return {
    name: "Burner wallet",
    burner: true,
    publicKey: kp.publicKey,
    signTransaction: async (tx) => {
      tx.partialSign(kp);
      return tx;
    },
    signAndSend: null,
    disconnect: async () => {},
    onChange: () => () => {},
  };
}

// ---------------------------------------------------------------- Wallet Standard

type SolWallet = Wallet & {
  features: StandardConnectFeature &
    Partial<StandardDisconnectFeature & StandardEventsFeature & SolanaSignTransactionFeature & SolanaSignAndSendTransactionFeature>;
};

/** Wallet Standard wallets that can connect and sign Solana txs. */
export function standardWallets(): SolWallet[] {
  return getWallets()
    .get()
    .filter(
      (w): w is SolWallet =>
        StandardConnect in w.features &&
        (SolanaSignTransaction in w.features || SolanaSignAndSendTransaction in w.features) &&
        w.chains.some((c) => c.startsWith("solana:")),
    );
}

/** Calls `cb` whenever a wallet registers / unregisters. */
export function onWalletsChanged(cb: () => void): () => void {
  const w = getWallets();
  const a = w.on("register", cb);
  const b = w.on("unregister", cb);
  return () => {
    a();
    b();
  };
}

/** Wallet Standard chain id for the configured base RPC (`VITE_WALLET_CHAIN` overrides). */
export function chainFor(baseRpc: string, override?: string): IdentifierString {
  if (override) return override as IdentifierString;
  if (/devnet/i.test(baseRpc)) return "solana:devnet";
  if (/testnet/i.test(baseRpc)) return "solana:testnet";
  if (isLocalRpc(baseRpc)) return "solana:localnet";
  return "solana:mainnet";
}

/** Network name shown in the UI ("Devnet", "Testnet", "Localnet"), or null on mainnet. */
export function networkLabel(baseRpc: string, override?: string): string | null {
  const c = chainFor(baseRpc, override);
  return c === "solana:mainnet" ? null : c.slice("solana:".length).replace(/^./, (x) => x.toUpperCase());
}

/** Connects a Wallet Standard wallet (`silent`: only if already authorized). */
export async function connectStandard(w: SolWallet, chain: IdentifierString, silent = false): Promise<AppWallet> {
  const { accounts } = await w.features[StandardConnect].connect(silent ? { silent: true } : undefined);
  const account: WalletAccount | undefined = accounts.find((a) => a.chains.some((c) => c.startsWith("solana:"))) ?? accounts[0];
  if (!account) throw new Error(`${w.name}: no account authorized`);
  const sign = w.features[SolanaSignTransaction];
  const sas = w.features[SolanaSignAndSendTransaction];
  const ser = (tx: Transaction) => new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  return {
    name: w.name,
    icon: w.icon,
    burner: false,
    publicKey: new PublicKey(account.publicKey),
    signTransaction: sign
      ? async (tx) => {
          const [out] = await sign.signTransaction({ account, transaction: ser(tx), chain });
          return Transaction.from(out.signedTransaction);
        }
      : null,
    signAndSend: sas
      ? async (tx) => {
          const [out] = await sas.signAndSendTransaction({ account, transaction: ser(tx), chain });
          return bs58(out.signature);
        }
      : null,
    disconnect: async () => {
      await w.features[StandardDisconnect]?.disconnect();
    },
    onChange: (cb) => w.features[StandardEvents]?.on("change", (p) => p.accounts && cb()) ?? (() => {}),
  };
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Base58 of a 64-byte signature. */
export function bs58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

// ---------------------------------------------------------------- sending

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `getSignatureStatuses` until `sig` is confirmed (throws on failure / timeout). */
export async function confirmSig(conn: Connection, sig: string, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new TxError(`transaction failed: ${JSON.stringify(st.err)}`, sig, st.err);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return;
    if (Date.now() > end) throw new TxError("transaction not confirmed in time (it may still land)", sig);
    await sleep(250);
  }
}

export class TxError extends Error {
  constructor(
    message: string,
    readonly sig?: string,
    readonly err?: unknown,
  ) {
    super(message);
    this.name = "TxError";
  }
}

/** Has the wallet sign `tx` (fee payer + blockhash set; other signers may have signed
 *  already), sends it to `conn` and waits for confirmation. `viaWallet` allows the
 *  sign-and-send fallback (base layer only). */
export async function sendWithWallet(
  wallet: AppWallet,
  conn: Connection,
  tx: Transaction,
  opts: { viaWallet?: boolean; timeoutMs?: number; skipPreflight?: boolean; onSent?: (sig: string) => void } = {},
): Promise<string> {
  let sig: string;
  if (wallet.signTransaction) {
    const signed = await wallet.signTransaction(tx);
    sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: opts.skipPreflight ?? false, preflightCommitment: "confirmed" });
  } else if (opts.viaWallet && wallet.signAndSend) {
    sig = await wallet.signAndSend(tx);
  } else {
    throw new Error(`${wallet.name} cannot sign transactions without sending them`);
  }
  opts.onSent?.(sig);
  await confirmSig(conn, sig, opts.timeoutMs);
  return sig;
}
