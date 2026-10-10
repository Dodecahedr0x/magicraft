// Delegation record of a delegated account (base layer, owned by the delegation program):
// which ER validator the account is delegated to. Layout from
// magicblock-delegation-program-api 3.1.0 `state/delegation_record.rs` (and the TS SDK's
// `parseDelegationRecordAccount`, which reads the validator at bytes 8..40):
//   [0..8)   discriminator: u64 LE 100 (`AccountDiscriminator::DelegationRecord`)
//   [8..40)  authority: the validator the account is delegated to
//   [40..72) owner: the account's original owner program
//   [72..80) delegation_slot: u64 LE
//   [80..88) lamports: u64 LE
//   [88..96) commit_frequency_ms: u64 LE
import { PublicKey } from "@solana/web3.js";

/** The delegation program (owner of a delegated account on the base layer). */
export const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const DELEGATION_RECORD_DISCRIMINATOR = 100n;
export const DELEGATION_RECORD_LEN = 96;

export type DelegationRecord = {
  /** The ER validator (null: delegated without a pinned validator, i.e. the default key). */
  validator: PublicKey | null;
  owner: PublicKey;
  delegationSlot: bigint;
  lamports: bigint;
  commitFrequencyMs: bigint;
};

/** `["delegation", account]` under the delegation program. */
export const delegationRecordPda = (account: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([new TextEncoder().encode("delegation"), account.toBytes()], DELEGATION_PROGRAM)[0];

/** Decodes a delegation record's data; null if it is not one (wrong size / discriminator). */
export function decodeDelegationRecord(data: Uint8Array): DelegationRecord | null {
  if (data.length < DELEGATION_RECORD_LEN) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getBigUint64(0, true) !== DELEGATION_RECORD_DISCRIMINATOR) return null;
  const v = data.subarray(8, 40);
  return {
    validator: v.some((b) => b !== 0) ? new PublicKey(v) : null,
    owner: new PublicKey(data.subarray(40, 72)),
    delegationSlot: dv.getBigUint64(72, true),
    lamports: dv.getBigUint64(80, true),
    commitFrequencyMs: dv.getBigUint64(88, true),
  };
}

/** The validator from a delegation record account (null: missing / not a record / not
 *  owned by the delegation program / no validator pinned). */
export function recordValidator(info: { owner: PublicKey; lamports: number; data: Uint8Array } | null): PublicKey | null {
  if (!info || !info.owner.equals(DELEGATION_PROGRAM) || info.lamports === 0) return null;
  return decodeDelegationRecord(info.data)?.validator ?? null;
}
