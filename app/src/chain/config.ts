// Cluster configuration: endpoints and addresses the client must not take from the IDL.
// The committed IDL comes from whatever `anchor build` ran last (`pnpm test` leaves a
// `localnet` build: debug ixs, test VRF queue), so cluster-specific addresses live here.
//
// Vite env vars (all optional; defaults = the local stack of `scripts/local-er.sh`):
// | var | meaning | default |
// |---|---|---|
// | `VITE_BASE_RPC` | base-layer RPC (HTTP) | `http://127.0.0.1:8799` |
// | `VITE_BASE_WS` | base-layer websocket | RPC port + 1, `ws(s)://` |
// | `VITE_ER_RPC` | ephemeral rollup RPC (HTTP) | `http://127.0.0.1:7799` |
// | `VITE_ER_WS` | ephemeral rollup websocket | RPC port + 1, `ws(s)://` |
// | `VITE_PROGRAM_ID` | magicraft program id | the IDL `address` |
// | `VITE_VRF_QUEUE` | VRF oracle queue for `request_seed` | local `DEFAULT_EPHEMERAL_TEST_QUEUE` |
// | `VITE_ER_VALIDATOR` | ER validator identity pinned in `delegate_player` | local ER identity |
//
// Production builds (`import.meta.env.PROD`) have no defaults for the cluster-specific vars:
// `VITE_BASE_RPC`, `VITE_ER_RPC`, `VITE_PROGRAM_ID`, `VITE_ER_VALIDATOR` and
// `VITE_VRF_QUEUE` must be set (a localnet default there would silently target the wrong
// program / validator / VRF queue).
import { PublicKey } from "@solana/web3.js";
import idl from "../idl/magicraft.json";

/** `ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE` (devnet / mainnet ERs). */
export const DEFAULT_EPHEMERAL_QUEUE = new PublicKey(
  "5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc",
);
/** `DEFAULT_EPHEMERAL_TEST_QUEUE` (the local stack's VRF queue). */
export const DEFAULT_EPHEMERAL_TEST_QUEUE = new PublicKey(
  "Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT",
);
/** Identity of the local ephemeral validator (`scripts/local-er.sh`). */
export const LOCAL_ER_VALIDATOR = new PublicKey(
  "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev",
);

export type ClusterConfig = {
  baseRpc: string;
  baseWs: string;
  erRpc: string;
  erWs: string;
  programId: PublicKey;
  vrfQueue: PublicKey;
  erValidator: PublicKey;
};

export type Env = Record<string, string | boolean | undefined>;

/** `http(s)://host:port` → `ws(s)://host:(port+1)` (Solana RPC convention). */
export function wsFor(rpc: string): string {
  const u = new URL(rpc);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  if (u.port) u.port = String(Number(u.port) + 1);
  return u.toString().replace(/\/$/, "");
}

const str = (env: Env, k: string): string | undefined => {
  const v = env[k];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

/** Vars a production build must set. */
export const PROD_REQUIRED = [
  "VITE_BASE_RPC",
  "VITE_ER_RPC",
  "VITE_PROGRAM_ID",
  "VITE_ER_VALIDATOR",
  "VITE_VRF_QUEUE",
] as const;

/** Reads the config from Vite env vars (pass `import.meta.env`); throws on bad keys and,
 *  when `env.PROD` is true, on missing `PROD_REQUIRED` vars. */
export function loadConfig(env: Env = {}): ClusterConfig {
  if (env.PROD === true) {
    const missing = PROD_REQUIRED.filter((k) => !str(env, k));
    if (missing.length)
      throw new Error(
        `config: production build is missing ${missing.join(", ")} (set them in app/.env.production or the build env)`,
      );
  }
  const key = (k: string, dflt: PublicKey) => {
    const v = str(env, k);
    if (!v) return dflt;
    try {
      return new PublicKey(v);
    } catch {
      throw new Error(`config: ${k} is not a valid public key: ${v}`);
    }
  };
  const baseRpc = str(env, "VITE_BASE_RPC") ?? "http://127.0.0.1:8799";
  const erRpc = str(env, "VITE_ER_RPC") ?? "http://127.0.0.1:7799";
  return {
    baseRpc,
    baseWs: str(env, "VITE_BASE_WS") ?? wsFor(baseRpc),
    erRpc,
    erWs: str(env, "VITE_ER_WS") ?? wsFor(erRpc),
    programId: key("VITE_PROGRAM_ID", new PublicKey(idl.address)),
    vrfQueue: key("VITE_VRF_QUEUE", DEFAULT_EPHEMERAL_TEST_QUEUE),
    erValidator: key("VITE_ER_VALIDATOR", LOCAL_ER_VALIDATOR),
  };
}
