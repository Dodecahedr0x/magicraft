// Anchor client from the IDL (ix builders, account coder) bound to the configured cluster.
import {
  LangErrorCode,
  LangErrorMessage,
  Program,
  type Idl,
} from "@anchor-lang/core";
import type { Connection } from "@solana/web3.js";
import idlJson from "../idl/magicraft.json";
import type { Magicraft } from "../idl/magicraft";
import type { ClusterConfig } from "./config";
import { DEFAULT_EPHEMERAL_QUEUE, DEFAULT_EPHEMERAL_TEST_QUEUE } from "./config";

export type { Magicraft };
export type MagicraftProgram = Program<Magicraft>;

/** The raw IDL JSON as built (snake_case names; program id of the last `anchor build`).
 *  `Magicraft` (camelCase) is the type `Program` exposes after its own conversion. */
export const IDL = idlJson;

/** The IDL with cluster addresses from `cfg`: program id (also every account pinned to
 *  it, e.g. `delegate_player.owner_program`) and the VRF queue pinned in `request_seed`. */
export function idlFor(cfg: ClusterConfig): Magicraft {
  const built = IDL.address;
  const pid = cfg.programId.toBase58();
  const queues = [DEFAULT_EPHEMERAL_QUEUE.toBase58(), DEFAULT_EPHEMERAL_TEST_QUEUE.toBase58()];
  const idl = structuredClone(IDL) as unknown as Idl;
  (idl as { address: string }).address = pid;
  for (const ix of idl.instructions) {
    for (const acc of ix.accounts as { address?: string }[]) {
      if (acc.address === built) acc.address = pid;
      else if (acc.address && queues.includes(acc.address))
        acc.address = cfg.vrfQueue.toBase58();
    }
  }
  return idl as unknown as Magicraft;
}

/** Program client for building ixs and decoding accounts. It has no wallet: every
 *  builder passes its signer explicitly and txs are signed by the caller (session
 *  keypair via `sender.ts`, or the wallet adapter for base txs). */
export function makeProgram(cfg: ClusterConfig, connection: Connection): MagicraftProgram {
  return new Program<Magicraft>(idlFor(cfg), { connection });
}

/** gpl_session `SessionError` numbers as seen from our program (compiled in with the
 *  default offset, not in our IDL). */
export const SESSION_ERRORS: Record<number, string> = {
  6000: "ValidityTooLong",
  6001: "InvalidToken",
  6002: "NoToken",
  6003: "InvalidAuthority",
};

export type ErrorInfo = { name: string; msg: string };

/** Program error number → name/message: IDL errors (6100+), session errors (6000–6003)
 *  and Anchor framework errors (100–5000, e.g. 2006 `ConstraintSeeds`). */
export const PROGRAM_ERRORS: Map<number, ErrorInfo> = (() => {
  const m = new Map<number, ErrorInfo>();
  for (const [name, code] of Object.entries(LangErrorCode))
    m.set(code, { name, msg: LangErrorMessage.get(code) ?? name });
  for (const [code, name] of Object.entries(SESSION_ERRORS))
    m.set(Number(code), { name, msg: `session: ${name}` });
  for (const e of IDL.errors) m.set(e.code, { name: e.name, msg: e.msg });
  return m;
})();

/** Error number of a program error name (IDL or session), e.g. `"MoveTooFast"` → 6115. */
export function errorCode(name: string): number | undefined {
  for (const [code, e] of PROGRAM_ERRORS) if (e.name === name) return code;
  return undefined;
}
