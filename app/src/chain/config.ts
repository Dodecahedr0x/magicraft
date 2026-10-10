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
// | `VITE_ER_REGIONS` | JSON list of selectable ERs `[{id, label, rpc, ws?, validator}]` | see below |
// | `VITE_WALLET_CHAIN` | Wallet Standard chain id (read by `wallet.ts`) | from `VITE_BASE_RPC` |
//
// ER regions: the player picks one in the top bar (persisted per base cluster, see
// `region.ts`). The list is `VITE_ER_REGIONS` if set, else the built-in `DEVNET_REGIONS`
// when the base RPC is Solana devnet, else the single ER of `VITE_ER_RPC` (localnet:
// "Local"). The default region is the one `VITE_ER_RPC` names (an endpoint not in the
// list is added as its own region, with `VITE_ER_VALIDATOR`), else the first.
// `erRpc` / `erWs` / `erValidator` always describe the selected region.
//
// Production builds (`import.meta.env.PROD`) have no defaults for the cluster-specific vars:
// `VITE_BASE_RPC`, `VITE_PROGRAM_ID`, `VITE_VRF_QUEUE` and either `VITE_ER_REGIONS` or
// `VITE_ER_RPC` + `VITE_ER_VALIDATOR` must be set (a localnet default there would silently
// target the wrong program / validator / VRF queue).
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

/** A selectable ephemeral rollup: endpoint + the validator identity it runs as. */
export type Region = {
  id: string;
  label: string;
  erRpc: string;
  erWs: string;
  validator: PublicKey;
};

export type ClusterConfig = {
  baseRpc: string;
  baseWs: string;
  /** Selected region's ER RPC / websocket / validator (pinned in `delegate_player`). */
  erRpc: string;
  erWs: string;
  programId: PublicKey;
  vrfQueue: PublicKey;
  erValidator: PublicKey;
  /** Selectable regions (at least one) and the selected one's id. */
  regions: Region[];
  region: string;
};

/** MagicBlock devnet ERs (`getIdentity` / devnet-router `getRoutes`, 2026-10-10). */
export const DEVNET_REGIONS: readonly { id: string; label: string; rpc: string; validator: string }[] = [
  { id: "eu", label: "Europe", rpc: "https://devnet-eu.magicblock.app", validator: "MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e" },
  { id: "us", label: "US", rpc: "https://devnet-us.magicblock.app", validator: "MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd" },
  { id: "asia", label: "Asia", rpc: "https://devnet-as.magicblock.app", validator: "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57" },
];

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

/** Vars a production build must set (`VITE_ER_RPC` + `VITE_ER_VALIDATOR` may be replaced
 *  by `VITE_ER_REGIONS`). */
export const PROD_REQUIRED = [
  "VITE_BASE_RPC",
  "VITE_ER_RPC",
  "VITE_PROGRAM_ID",
  "VITE_ER_VALIDATOR",
  "VITE_VRF_QUEUE",
] as const;
const ER_VARS: readonly string[] = ["VITE_ER_RPC", "VITE_ER_VALIDATOR"];

const isLocal = (url: string) => {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
  } catch {
    return false;
  }
};
const isDevnet = (url: string) => {
  try {
    return new URL(url).hostname === "api.devnet.solana.com";
  } catch {
    return false;
  }
};
/** Endpoint comparison: scheme + host + port + path, no trailing slash. */
const sameUrl = (a: string, b: string) => {
  try {
    const n = (u: string) => {
      const x = new URL(u);
      return `${x.protocol}//${x.host}${x.pathname.replace(/\/+$/, "")}`;
    };
    return n(a) === n(b);
  } catch {
    return a === b;
  }
};
const pubkey = (what: string, v: unknown): PublicKey => {
  try {
    if (typeof v !== "string" || !v.trim()) throw new Error();
    return new PublicKey(v.trim());
  } catch {
    throw new Error(`config: ${what} is not a valid public key: ${String(v)}`);
  }
};
const httpUrl = (what: string, v: unknown): string => {
  try {
    if (typeof v !== "string") throw new Error();
    const u = new URL(v.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    return v.trim();
  } catch {
    throw new Error(`config: ${what} is not an http(s) URL: ${String(v)}`);
  }
};

/** Parses `VITE_ER_REGIONS` (JSON `[{id, label?, rpc, ws?, validator}]`). */
export function parseRegions(json: string): Region[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("config: VITE_ER_REGIONS is not valid JSON");
  }
  if (!Array.isArray(raw) || !raw.length) throw new Error("config: VITE_ER_REGIONS must be a non-empty array");
  const out: Region[] = [];
  for (const [i, r] of raw.entries()) {
    const o = (r ?? {}) as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!/^[a-z0-9_-]{1,32}$/i.test(id)) throw new Error(`config: VITE_ER_REGIONS[${i}].id must be 1-32 letters, digits, - or _`);
    if (out.some((x) => x.id === id)) throw new Error(`config: VITE_ER_REGIONS has a duplicate id: ${id}`);
    const erRpc = httpUrl(`VITE_ER_REGIONS[${i}].rpc`, o.rpc);
    out.push({
      id,
      label: typeof o.label === "string" && o.label.trim() ? o.label.trim() : id,
      erRpc,
      erWs: o.ws === undefined ? wsFor(erRpc) : String(o.ws),
      validator: pubkey(`VITE_ER_REGIONS[${i}].validator`, o.validator),
    });
  }
  return out;
}

/** `cfg` with region `id` selected (throws on an unknown id). */
export function selectRegion(cfg: ClusterConfig, id: string): ClusterConfig {
  const r = cfg.regions.find((x) => x.id === id);
  if (!r) throw new Error(`config: unknown ER region ${id}`);
  return { ...cfg, region: r.id, erRpc: r.erRpc, erWs: r.erWs, erValidator: r.validator };
}

/** The selected region of `cfg`. */
export const currentRegion = (cfg: ClusterConfig): Region => cfg.regions.find((r) => r.id === cfg.region)!;

/** Reads the config from Vite env vars (pass `import.meta.env`); throws on bad keys /
 *  regions and, when `env.PROD` is true, on missing `PROD_REQUIRED` vars. */
export function loadConfig(env: Env = {}): ClusterConfig {
  const regionsJson = str(env, "VITE_ER_REGIONS");
  if (env.PROD === true) {
    const missing = PROD_REQUIRED.filter((k) => !str(env, k) && !(regionsJson && ER_VARS.includes(k)));
    if (missing.length)
      throw new Error(
        `config: production build is missing ${missing.join(", ")} (set them in app/.env.production or the build env)`,
      );
  }
  const key = (k: string, dflt: PublicKey) => {
    const v = str(env, k);
    return v ? pubkey(k, v) : dflt;
  };
  const baseRpc = str(env, "VITE_BASE_RPC") ?? "http://127.0.0.1:8799";
  const envRpc = str(env, "VITE_ER_RPC");
  const envWs = str(env, "VITE_ER_WS");
  const envValidator = str(env, "VITE_ER_VALIDATOR");
  let regions: Region[] = regionsJson
    ? parseRegions(regionsJson)
    : isDevnet(baseRpc)
      ? DEVNET_REGIONS.map((r) => ({ id: r.id, label: r.label, erRpc: r.rpc, erWs: wsFor(r.rpc), validator: new PublicKey(r.validator) }))
      : [];
  let region: Region | undefined;
  if (envRpc) {
    region = regions.find((r) => sameUrl(r.erRpc, envRpc));
    if (region) {
      // The env names a listed region: it may refine its websocket / validator.
      if (envWs) region.erWs = envWs;
      if (envValidator) region.validator = pubkey("VITE_ER_VALIDATOR", envValidator);
    }
  }
  if (!region && (envRpc || !regions.length)) {
    const erRpc = envRpc ?? "http://127.0.0.1:7799";
    const local = isLocal(erRpc);
    let label = "Local";
    if (!local) {
      try {
        label = new URL(erRpc).host;
      } catch {
        label = erRpc;
      }
    }
    region = {
      id: local ? "local" : "custom",
      label,
      erRpc,
      erWs: envWs ?? wsFor(erRpc),
      validator: key("VITE_ER_VALIDATOR", LOCAL_ER_VALIDATOR),
    };
    if (regions.some((r) => r.id === region!.id)) region.id = `${region.id}-env`;
    regions = [region, ...regions];
  }
  const sel = region ?? regions[0];
  return {
    baseRpc,
    baseWs: str(env, "VITE_BASE_WS") ?? wsFor(baseRpc),
    erRpc: sel.erRpc,
    erWs: sel.erWs,
    programId: key("VITE_PROGRAM_ID", new PublicKey(idl.address)),
    vrfQueue: key("VITE_VRF_QUEUE", DEFAULT_EPHEMERAL_TEST_QUEUE),
    erValidator: sel.validator,
    regions,
    region: sel.id,
  };
}
