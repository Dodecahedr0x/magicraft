// ER regions: config parsing / validation, the persisted choice (storage guards), the
// delegation record decoding (validator of a delegated Player) and the placement of the
// Player relative to the selected region.
import { Buffer } from "buffer";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  DEVNET_REGIONS,
  LOCAL_ER_VALIDATOR,
  currentRegion,
  loadConfig,
  parseRegions,
  selectRegion,
} from "./config";
import {
  DELEGATION_PROGRAM,
  decodeDelegationRecord,
  delegationRecordPda,
  recordValidator,
} from "./delegation";
import { loadRegionChoice, playerPlacement, saveRegionChoice } from "./region";
import type { KeyValueStore } from "./session";

const EU = "MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e";
const US = "MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd";
const ASIA = "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57";
const DEVNET = { VITE_BASE_RPC: "https://api.devnet.solana.com" };

class MemStore implements KeyValueStore {
  m = new Map<string, string>();
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
  removeItem = (k: string) => void this.m.delete(k);
}
const throwing: KeyValueStore = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("quota");
  },
  removeItem: () => {
    throw new Error("denied");
  },
};

describe("region config", () => {
  it("localnet: a single Local region from the ER env", () => {
    const c = loadConfig();
    expect(c.regions.map((r) => [r.id, r.label])).toEqual([["local", "Local"]]);
    expect(c.region).toBe("local");
    expect(c.erRpc).toBe("http://127.0.0.1:7799");
    expect(c.erValidator.equals(LOCAL_ER_VALIDATOR)).toBe(true);
  });

  it("devnet base: the built-in Europe / US / Asia table, default from VITE_ER_RPC", () => {
    const c = loadConfig({ ...DEVNET, VITE_ER_RPC: "https://devnet-eu.magicblock.app", VITE_ER_WS: "wss://devnet-eu.magicblock.app", VITE_ER_VALIDATOR: EU });
    expect(c.regions.map((r) => r.label)).toEqual(["Europe", "US", "Asia"]);
    expect(c.region).toBe("eu");
    expect(c.erValidator.toBase58()).toBe(EU);
    expect(c.regions.map((r) => r.validator.toBase58())).toEqual([EU, US, ASIA]);
    expect(c.regions[1].erWs).toBe("wss://devnet-us.magicblock.app");
    // A trailing slash still matches the listed region.
    expect(loadConfig({ ...DEVNET, VITE_ER_RPC: "https://devnet-as.magicblock.app/" }).region).toBe("asia");
    // No ER env: the first region.
    expect(loadConfig(DEVNET).region).toBe(DEVNET_REGIONS[0].id);
  });

  it("an ER endpoint outside the table becomes its own region (with VITE_ER_VALIDATOR)", () => {
    const k = Keypair.generate().publicKey.toBase58();
    const c = loadConfig({ ...DEVNET, VITE_ER_RPC: "https://er.example:8899", VITE_ER_VALIDATOR: k });
    expect(c.regions.map((r) => r.id)).toEqual(["custom", "eu", "us", "asia"]);
    expect(c.region).toBe("custom");
    expect(c.regions[0].label).toBe("er.example:8899");
    expect(c.erWs).toBe("wss://er.example:8900");
    expect(c.erValidator.toBase58()).toBe(k);
  });

  it("selectRegion swaps endpoint + validator and rejects unknown ids", () => {
    const c = loadConfig({ ...DEVNET, VITE_ER_RPC: "https://devnet-eu.magicblock.app" });
    const us = selectRegion(c, "us");
    expect([us.region, us.erRpc, us.erWs, us.erValidator.toBase58()]).toEqual(["us", "https://devnet-us.magicblock.app", "wss://devnet-us.magicblock.app", US]);
    expect(currentRegion(us).label).toBe("US");
    expect(us.programId.equals(c.programId) && us.baseRpc === c.baseRpc).toBe(true);
    expect(c.region).toBe("eu"); // not mutated
    expect(() => selectRegion(c, "mars")).toThrow(/unknown ER region/);
  });

  it("VITE_ER_REGIONS: parsed and validated", () => {
    const k = Keypair.generate().publicKey.toBase58();
    const json = JSON.stringify([
      { id: "a", label: "Alpha", rpc: "https://a.example", validator: k },
      { id: "b", rpc: "http://127.0.0.1:7799", ws: "ws://127.0.0.1:9000", validator: EU },
    ]);
    const c = loadConfig({ VITE_ER_REGIONS: json, VITE_ER_RPC: "http://127.0.0.1:7799" });
    expect(c.regions.map((r) => [r.id, r.label, r.erWs])).toEqual([
      ["a", "Alpha", "wss://a.example"],
      ["b", "b", "ws://127.0.0.1:9000"],
    ]);
    expect(c.region).toBe("b");
    expect(loadConfig({ VITE_ER_REGIONS: json }).region).toBe("a");
    expect(() => parseRegions("nope")).toThrow(/not valid JSON/);
    expect(() => parseRegions("[]")).toThrow(/non-empty/);
    expect(() => parseRegions(JSON.stringify([{ id: "a", rpc: "https://a", validator: k }, { id: "a", rpc: "https://b", validator: k }]))).toThrow(/duplicate/);
    expect(() => parseRegions(JSON.stringify([{ id: "a b", rpc: "https://a", validator: k }]))).toThrow(/id/);
    expect(() => parseRegions(JSON.stringify([{ id: "a", rpc: "ftp://a", validator: k }]))).toThrow(/rpc/);
    expect(() => parseRegions(JSON.stringify([{ id: "a", rpc: "https://a", validator: "x" }]))).toThrow(/validator/);
  });

  it("production builds: VITE_ER_REGIONS replaces VITE_ER_RPC + VITE_ER_VALIDATOR", () => {
    const k = Keypair.generate().publicKey.toBase58();
    const base = { PROD: true, VITE_BASE_RPC: "https://b.example", VITE_PROGRAM_ID: k, VITE_VRF_QUEUE: k };
    expect(() => loadConfig(base)).toThrow(/missing VITE_ER_RPC, VITE_ER_VALIDATOR \(/);
    expect(() => loadConfig({ ...base, VITE_ER_RPC: "https://e.example" })).toThrow(/VITE_ER_VALIDATOR/);
    const c = loadConfig({ ...base, VITE_ER_REGIONS: JSON.stringify([{ id: "x", rpc: "https://e.example", validator: k }]) });
    expect(c.region).toBe("x");
  });
});

describe("region choice persistence", () => {
  const cfg = loadConfig({ ...DEVNET, VITE_ER_RPC: "https://devnet-eu.magicblock.app" });

  it("round-trips per base cluster and ignores ids that are no longer listed", () => {
    const s = new MemStore();
    expect(loadRegionChoice(s, cfg)).toBeNull();
    expect(saveRegionChoice(s, selectRegion(cfg, "asia"))).toBe(true);
    expect(loadRegionChoice(s, cfg)).toBe("asia");
    // Another base cluster does not see it.
    expect(loadRegionChoice(s, { ...cfg, baseRpc: "http://127.0.0.1:8799" })).toBeNull();
    s.m.set([...s.m.keys()][0], "gone");
    expect(loadRegionChoice(s, cfg)).toBeNull();
  });

  it("never throws without / with a failing storage", () => {
    expect(loadRegionChoice(null, cfg)).toBeNull();
    expect(saveRegionChoice(null, cfg)).toBe(false);
    expect(loadRegionChoice(throwing, cfg)).toBeNull();
    expect(saveRegionChoice(throwing, cfg)).toBe(false);
  });
});

/** A real devnet delegation record (2026-10-10): a magicraft account delegated to the EU
 *  validator (`getProgramAccounts` on the delegation program, `dataSize` 96, owner @40). */
const DEVNET_RECORD = Buffer.from(
  "ZAAAAAAAAAAFLtjJdehlvRW1nlw2T/pioVT/3FBQyFrf02FQeC7uzzCJRkyUSxBCaN7J4AEYg/VetaeNwyk7Vom78N0x8mnq0IRdHgAAAAAYAA0DAAAAAP////8AAAAA",
  "base64",
);

describe("delegation record", () => {
  it("decodes the validator, owner, slot, lamports and commit frequency", () => {
    const r = decodeDelegationRecord(DEVNET_RECORD)!;
    expect(r.validator!.toBase58()).toBe(EU);
    // Recorded under the first devnet program id (closed 2026-10-10).
    expect(r.owner.toBase58()).toBe("4GTybm3WD66wUnTgS8UcB9H947uAY7BAqivp8HfbSsW9");
    expect(r.delegationSlot).toBe(509_445_328n);
    expect(r.lamports).toBe(51_183_640n);
    expect(r.commitFrequencyMs).toBe(4_294_967_295n);
  });

  it("rejects other data and reads an unpinned validator as null", () => {
    expect(decodeDelegationRecord(DEVNET_RECORD.subarray(0, 95))).toBeNull();
    const other = Buffer.from(DEVNET_RECORD);
    other[0] = 102; // DelegationMetadata
    expect(decodeDelegationRecord(other)).toBeNull();
    const unpinned = Buffer.from(DEVNET_RECORD);
    unpinned.fill(0, 8, 40);
    expect(decodeDelegationRecord(unpinned)!.validator).toBeNull();
  });

  it("recordValidator checks the account owner and lamports", () => {
    const acc = { owner: DELEGATION_PROGRAM, lamports: 1_559_040, data: DEVNET_RECORD };
    expect(recordValidator(acc)!.toBase58()).toBe(EU);
    expect(recordValidator(null)).toBeNull();
    expect(recordValidator({ ...acc, lamports: 0 })).toBeNull();
    expect(recordValidator({ ...acc, owner: PublicKey.default })).toBeNull();
  });

  it("PDA: [\"delegation\", account] under the delegation program", () => {
    const a = Keypair.generate().publicKey;
    const [want] = PublicKey.findProgramAddressSync([Buffer.from("delegation"), a.toBuffer()], DELEGATION_PROGRAM);
    expect(delegationRecordPda(a).equals(want)).toBe(true);
  });
});

describe("player placement", () => {
  const cfg = loadConfig({ ...DEVNET, VITE_ER_RPC: "https://devnet-eu.magicblock.app" });

  it("here: delegated to the selected validator, or unknown", () => {
    expect(playerPlacement(cfg, new PublicKey(EU))).toEqual({ kind: "here" });
    expect(playerPlacement(cfg, null)).toEqual({ kind: "here" });
    expect(playerPlacement(selectRegion(cfg, "us"), new PublicKey(US))).toEqual({ kind: "here" });
  });

  it("elsewhere: names the region running the validator", () => {
    const p = playerPlacement(cfg, new PublicKey(ASIA));
    expect(p.kind).toBe("elsewhere");
    if (p.kind !== "elsewhere") return;
    expect(p.region?.id).toBe("asia");
    expect(p.validator.toBase58()).toBe(ASIA);
    const q = playerPlacement(selectRegion(cfg, "asia"), new PublicKey(EU));
    expect(q.kind === "elsewhere" && q.region?.label).toBe("Europe");
  });

  it("elsewhere with no region: a validator none of the regions runs", () => {
    const p = playerPlacement(cfg, Keypair.generate().publicKey);
    expect(p.kind === "elsewhere" && p.region).toBeNull();
  });
});
