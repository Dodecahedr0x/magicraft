// Pure parts of the onboarding / world UI: WorldParams form conversion + validation, world
// list decoding / filtering, withdraw planning, burner storage guards, SOL parsing.
import { Buffer } from "buffer";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  CHUNK_DISCRIMINATOR,
  CHUNK_TOTAL_RENT,
  DEFAULT_WORLD_PARAMS,
  WORLD_DISCRIMINATOR,
  WORLD_LEN,
  chunkPda,
  decodeWorld,
  type KeyValueStore,
} from "../chain";
import { bs58, burnerAllowed, burnerKey, burnerKeypair, chainFor, isLocalRpc, loadBurner, saveBurner } from "../wallet";
import { chunksFor, parseSol } from "./onboarding";
import { PARAM_FIELDS, fromForm, jumpHeight, toForm, validateForm, validateName } from "./params";
import { decodeWorldList, silentPlayers, visibleWorlds, worldClosable, worldCloseRefund, worldFilters, worldStatus } from "./worldList";
import { CHUNK_PREFIX_LEN, parseChunkPrefix, planWithdraw, prefixMatches, withdrawPhase, type SponsoredChunk } from "./withdrawPlan";

const PID = new PublicKey("4y2JKsSfShA6tL5K9Vk3NZPPev1bq29AqqNK9iYF9euz");

class MemStore implements KeyValueStore {
  m = new Map<string, string>();
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
  removeItem = (k: string) => void this.m.delete(k);
}
class ThrowingStore implements KeyValueStore {
  getItem(): string | null {
    throw new Error("SecurityError");
  }
  setItem() {
    throw new Error("QuotaExceeded");
  }
  removeItem() {
    throw new Error("SecurityError");
  }
}

describe("WorldParams form", () => {
  it("defaults round-trip through display units", () => {
    const f = toForm(DEFAULT_WORLD_PARAMS);
    expect(f.walkSpeed).toBe(4.301);
    expect(f.gravity).toBe(32);
    expect(f.attackCooldownMs).toBe(0.6);
    expect(f.dayLengthSecs).toBe(1200);
    expect(fromForm(f)).toEqual({ ...DEFAULT_WORLD_PARAMS });
    expect(validateForm(f)).toEqual({});
  });

  it("converts human units to onchain integers", () => {
    const f = { ...toForm(DEFAULT_WORLD_PARAMS), walkSpeed: 5, sprintSpeed: 7.5, mobTickMs: 0.5, fallDamage: 0 };
    const p = fromForm(f);
    expect(p.walkSpeed).toBe(1280);
    expect(p.sprintSpeed).toBe(1920);
    expect(p.mobTickMs).toBe(500);
    expect(p.fallDamage).toBe(0);
    expect(p.pad).toBe(0);
  });

  it("flags out-of-range, non-numeric and non-integer fields", () => {
    const base = toForm(DEFAULT_WORLD_PARAMS);
    expect(validateForm({ ...base, walkSpeed: 0.5 }).walkSpeed).toMatch(/Between 1 and 50/);
    expect(validateForm({ ...base, reach: 17 }).reach).toMatch(/16 blocks/);
    expect(validateForm({ ...base, dayLengthSecs: 59 }).dayLengthSecs).toBeDefined();
    expect(validateForm({ ...base, dayLengthSecs: 600.5 }).dayLengthSecs).toBe("Whole numbers only.");
    expect(validateForm({ ...base, zombieCapPerChunk: 9 }).zombieCapPerChunk).toBeDefined();
    expect(validateForm({ ...base, fluidTickMs: 0.05 }).fluidTickMs).toBeDefined();
    expect(validateForm({ ...base, gravity: NaN }).gravity).toBe("Enter a number.");
  });

  it("mirrors the cross-field rules: sprint ≥ walk, jump height ≤ 8 blocks", () => {
    const base = toForm(DEFAULT_WORLD_PARAMS);
    expect(validateForm({ ...base, walkSpeed: 6, sprintSpeed: 5 }).sprintSpeed).toMatch(/walk speed/);
    const high = { ...base, jumpVelocity: 30, gravity: 32 }; // 30²/64 ≈ 14 blocks
    expect(jumpHeight(high)).toBeGreaterThan(8);
    expect(validateForm(high).jumpVelocity).toMatch(/at most 8/);
    expect(validateForm({ ...base, jumpVelocity: 22, gravity: 32 })).toEqual({}); // 7.56 blocks
  });

  it("every field's range is accepted at its bounds by the core validator", () => {
    for (const d of PARAM_FIELDS) {
      if (d.key === "sprintSpeed" || d.kind === "bool") continue;
      for (const v of [d.min, d.max]) {
        const f = { ...toForm(DEFAULT_WORLD_PARAMS), [d.key]: v };
        if (d.key === "walkSpeed") f.sprintSpeed = Math.max(f.sprintSpeed, v);
        if (d.key === "jumpVelocity" || d.key === "gravity") {
          f.jumpVelocity = d.key === "jumpVelocity" ? v : 1;
          f.gravity = d.key === "gravity" ? v : 100;
        }
        // 50 b/s can't jump ≤ 8 blocks even at max gravity: only the cross-field rule trips.
        if (d.key === "jumpVelocity" && v === d.max) expect(validateForm(f).jumpVelocity).toMatch(/at most 8/);
        else expect(validateForm(f), `${d.key} = ${v}`).toEqual({});
      }
    }
  });

  it("validates world names (32 UTF-8 bytes)", () => {
    expect(validateName("  ")).toMatch(/name/);
    expect(validateName("Pine Hollow")).toBeNull();
    expect(validateName("é".repeat(17))).toMatch(/32 bytes/);
  });
});

function worldBytes(o: { creator: PublicKey; name: string; seedSet: boolean; spawnSet: boolean; chunks: number }): Buffer {
  const d = Buffer.alloc(WORLD_LEN);
  d.set(WORLD_DISCRIMINATOR, 0);
  d.set(o.creator.toBytes(), 8);
  d.write(o.name, 49, "utf8");
  // params @81: defaults
  const p = DEFAULT_WORLD_PARAMS;
  [p.walkSpeed, p.sprintSpeed, p.swimSpeed, p.jumpVelocity, p.gravity, p.maxFallSpeed, p.reach, p.attackCooldownMs, p.dayLengthSecs, p.mobTickMs, p.fluidTickMs].forEach((v, i) => d.writeUInt32LE(v, 81 + 4 * i));
  d[125] = p.fallDamage;
  d[126] = p.hunger;
  d[127] = p.zombieCapPerChunk;
  d[161] = o.seedSet ? 1 : 0;
  d[174] = o.spawnSet ? 1 : 0;
  d.writeUInt32LE(o.chunks, 199);
  return d;
}

describe("world list", () => {
  const me = Keypair.generate().publicKey;
  const other = Keypair.generate().publicKey;
  const acc = (data: Uint8Array) => ({ pubkey: Keypair.generate().publicKey, account: { data } });

  it("filters by discriminator and data size", () => {
    const [size, mc] = worldFilters() as [{ dataSize: number }, { memcmp: { offset: number; bytes: string } }];
    expect(size.dataSize).toBe(WORLD_LEN);
    expect(mc.memcmp.offset).toBe(0);
    expect(Buffer.from(bs58Decode(mc.memcmp.bytes))).toEqual(Buffer.from(WORLD_DISCRIMINATOR));
  });

  it("decodes, skips garbage and sorts ready → mine → busiest → name", () => {
    const list = decodeWorldList(
      [
        acc(worldBytes({ creator: other, name: "Zeta", seedSet: true, spawnSet: true, chunks: 3 })),
        acc(worldBytes({ creator: other, name: "Alpha", seedSet: true, spawnSet: true, chunks: 3 })),
        acc(worldBytes({ creator: me, name: "Mine", seedSet: true, spawnSet: true, chunks: 1 })),
        acc(worldBytes({ creator: other, name: "Big", seedSet: true, spawnSet: true, chunks: 40 })),
        acc(worldBytes({ creator: me, name: "Half", seedSet: true, spawnSet: false, chunks: 0 })),
        acc(worldBytes({ creator: other, name: "Pending", seedSet: false, spawnSet: false, chunks: 0 })),
        acc(Buffer.alloc(WORLD_LEN)), // wrong discriminator
        acc(Buffer.alloc(12)),
      ],
      me,
    );
    expect(list.map((e) => e.world.name)).toEqual(["Mine", "Big", "Alpha", "Zeta", "Half", "Pending"]);
    expect(list[0].mine).toBe(true);
    expect(list.map((e) => e.status)).toEqual(["ready", "ready", "ready", "ready", "setup", "seeding"]);
    expect(decodeWorld(worldBytes({ creator: me, name: "x", seedSet: true, spawnSet: true, chunks: 0 })).params).toEqual({ ...DEFAULT_WORLD_PARAMS });
  });

  it("hides others' unfinished worlds and searches name / creator", () => {
    const list = decodeWorldList(
      [
        acc(worldBytes({ creator: other, name: "Pine Hollow", seedSet: true, spawnSet: true, chunks: 2 })),
        acc(worldBytes({ creator: me, name: "My draft", seedSet: false, spawnSet: false, chunks: 0 })),
        acc(worldBytes({ creator: other, name: "Their draft", seedSet: true, spawnSet: false, chunks: 0 })),
      ],
      me,
    );
    expect(visibleWorlds(list).map((e) => e.world.name)).toEqual(["Pine Hollow", "My draft"]);
    expect(visibleWorlds(list, "pine").map((e) => e.world.name)).toEqual(["Pine Hollow"]);
    expect(visibleWorlds(list, other.toBase58().slice(0, 6)).map((e) => e.world.name)).toEqual(["Pine Hollow"]);
    expect(visibleWorlds(list, "nothing")).toEqual([]);
    expect(worldStatus({ seedSet: false, spawnSet: false })).toBe("seeding");
  });
});

function bs58Decode(s: string): Uint8Array {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

describe("silent players (expire_players candidates)", () => {
  const k = () => Keypair.generate().publicKey;
  const [w1, w2, s1, s2, s3, s4] = [k(), k(), k(), k(), k(), k()];
  it("by world: last move older than 1 min (+1 s margin) at that world's chain time; worlds without a clock skipped", () => {
    const now = 100_000;
    const silent = silentPlayers(
      [
        { pubkey: s1, world: w1.toBase58(), lastMs: now - 61_001 },
        { pubkey: s2, world: w1.toBase58(), lastMs: now - 61_000 }, // within the margin
        { pubkey: s3, world: w1.toBase58(), lastMs: now - 500 },
        { pubkey: s4, world: w2.toBase58(), lastMs: 0 }, // w2: no clock reading
      ],
      new Map([[w1.toBase58(), now]]),
    );
    expect([...silent.keys()]).toEqual([w1.toBase58()]);
    expect(silent.get(w1.toBase58())!.map((p) => p.toBase58())).toEqual([s1.toBase58()]);
  });
});

describe("close world", () => {
  it("only untouched worlds: nobody joined, at most the spawn chunk", () => {
    expect(worldClosable({ firstJoinMs: 0, chunkCount: 0 })).toBe(true);
    expect(worldClosable({ firstJoinMs: 0, chunkCount: 1 })).toBe(true);
    expect(worldClosable({ firstJoinMs: 0, chunkCount: 2 })).toBe(false);
    expect(worldClosable({ firstJoinMs: 1, chunkCount: 1 })).toBe(false);
  });
  it("refunds the World rent, plus the spawn chunk's when it exists", () => {
    expect(worldCloseRefund({ chunkCount: 0 })).toBe((265 + 60) * 32);
    expect(worldCloseRefund({ chunkCount: 1 }) - worldCloseRefund({ chunkCount: 0 })).toBe(CHUNK_TOTAL_RENT);
  });
});

describe("withdraw plan", () => {
  const player = Keypair.generate().publicKey;
  const world = Keypair.generate().publicKey;
  const prefix = (o: { payer?: PublicKey; cx: number; cz: number; edited?: boolean; disc?: Uint8Array }) => {
    const d = Buffer.alloc(CHUNK_PREFIX_LEN);
    d.set(o.disc ?? CHUNK_DISCRIMINATOR, 0);
    d.set((o.payer ?? player).toBytes(), 8);
    d.set(world.toBytes(), 40);
    d.writeInt32LE(o.cx, 72);
    d.writeInt32LE(o.cz, 76);
    d[81] = o.edited ? 1 : 0;
    d[82] = 2;
    return d;
  };

  it("parses the header prefix of the player's chunks only", () => {
    const pk = chunkPda(PID, world, -3, 7);
    const c = parseChunkPrefix(pk, prefix({ cx: -3, cz: 7, edited: true }), player)!;
    expect(c).toMatchObject({ cx: -3, cz: 7, edited: true, genStage: 2 });
    expect(c.world.equals(world)).toBe(true);
    expect(prefixMatches(PID, c)).toBe(true);
    expect(prefixMatches(PID, { ...c, cx: 0 })).toBe(false);
    expect(parseChunkPrefix(pk, prefix({ cx: 0, cz: 0, payer: Keypair.generate().publicKey }), player)).toBeNull();
    expect(parseChunkPrefix(pk, prefix({ cx: 0, cz: 0, disc: new Uint8Array(8) }), player)).toBeNull();
    expect(parseChunkPrefix(pk, new Uint8Array(40), player)).toBeNull();
  });

  it("splits closable / edited / occupied and closes the farthest first", () => {
    const mk = (cx: number, cz: number, edited = false): SponsoredChunk => ({ pubkey: chunkPda(PID, world, cx, cz), world, cx, cz, edited, genStage: 2 });
    const chunks = [mk(0, 0), mk(1, 0), mk(2, 0), mk(0, 1), mk(-1, 0), mk(3, 3, true)];
    const counts = new Map([
      [chunks[0].pubkey.toBase58(), 0], // (0,0): empty but never closable
      [chunks[1].pubkey.toBase58(), 0],
      [chunks[2].pubkey.toBase58(), 0],
      [chunks[3].pubkey.toBase58(), 1], // someone inside
      // chunks[4]: presence unknown → not closable
    ]);
    const plan = planWithdraw(chunks, counts);
    expect(plan.spawn.map((c) => [c.cx, c.cz])).toEqual([[0, 0]]);
    expect(plan.edited.map((c) => [c.cx, c.cz])).toEqual([[3, 3]]);
    expect(plan.closable.map((c) => [c.cx, c.cz])).toEqual([
      [2, 0],
      [1, 0],
    ]);
    expect(plan.occupied.map((c) => [c.cx, c.cz]).sort()).toEqual([
      [-1, 0],
      [0, 1],
    ]);
    expect(plan.refund).toBe(2 * CHUNK_TOTAL_RENT);
    expect(planWithdraw([], new Map())).toEqual({ closable: [], edited: [], spawn: [], occupied: [], refund: 0 });
  });

  it("derives the withdraw phase from chain state", () => {
    const delegation = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
    const st = { programId: PID, baseOwner: delegation as PublicKey | null, spendable: 0, onEr: true, withdrawLanded: false };
    expect(withdrawPhase(st)).toBe("withdraw");
    expect(withdrawPhase({ ...st, withdrawLanded: true })).toBe("settling");
    expect(withdrawPhase({ ...st, onEr: false })).toBe("settling");
    expect(withdrawPhase({ ...st, baseOwner: PID, spendable: 5 })).toBe("withdrawBase");
    expect(withdrawPhase({ ...st, baseOwner: PID, spendable: 0, withdrawLanded: true })).toBe("done");
    expect(withdrawPhase({ ...st, baseOwner: null })).toBe("none");
  });
});

describe("burner wallet", () => {
  it("is offered only against a local RPC or when explicitly enabled, never on mainnet", () => {
    expect(burnerAllowed("http://127.0.0.1:8799")).toBe(true);
    expect(burnerAllowed("http://localhost:8799")).toBe(true);
    expect(burnerAllowed("https://api.devnet.solana.com")).toBe(false);
    expect(burnerAllowed("https://api.devnet.solana.com", "1")).toBe(true);
    expect(burnerAllowed("https://api.devnet.solana.com", "0")).toBe(false);
    expect(burnerAllowed("https://api.mainnet-beta.solana.com", "1")).toBe(false);
    expect(burnerAllowed("https://rpc.example.com", true)).toBe(false); // unknown → mainnet
    expect(burnerAllowed("https://127.0.0.1.evil.example")).toBe(false);
    expect(isLocalRpc("not a url")).toBe(false);
  });

  it("persists and restores the keypair", () => {
    const s = new MemStore();
    const kp = burnerKeypair(s, "http://127.0.0.1:8799");
    expect(s.m.has(burnerKey("http://127.0.0.1:8799"))).toBe(true);
    expect(burnerKeypair(s, "http://127.0.0.1:8799").publicKey.equals(kp.publicKey)).toBe(true);
    expect(burnerKeypair(s, "http://127.0.0.1:9999").publicKey.equals(kp.publicKey)).toBe(false);
  });

  it("drops corrupt entries and survives unavailable storage", () => {
    const s = new MemStore();
    for (const bad of ["{", "null", JSON.stringify({ v: 2, secret: "" }), JSON.stringify({ v: 1, secret: Buffer.alloc(10).toString("base64") }), JSON.stringify({ v: 1, secret: 5 })]) {
      s.m.set("k", bad);
      expect(loadBurner(s, "k"), bad).toBeNull();
      expect(s.m.has("k")).toBe(false);
    }
    expect(loadBurner(null, "k")).toBeNull();
    expect(saveBurner(null, "k", Keypair.generate())).toBe(false);
    const t = new ThrowingStore();
    expect(loadBurner(t, "k")).toBeNull();
    expect(saveBurner(t, "k", Keypair.generate())).toBe(false);
    expect(burnerKeypair(t, "x")).toBeInstanceOf(Keypair); // in-memory fallback
  });
});

describe("helpers", () => {
  it("parses SOL amounts", () => {
    expect(parseSol("0.05")).toEqual({ lamports: 50_000_000 });
    expect(parseSol("1,5")).toEqual({ lamports: 1_500_000_000 });
    expect(parseSol(".25")).toEqual({ lamports: 250_000_000 });
    expect(parseSol("abc")).toHaveProperty("error");
    expect(parseSol("-1")).toHaveProperty("error");
    expect(parseSol("0", 0.001)).toHaveProperty("error");
    expect(parseSol("5000")).toHaveProperty("error");
  });

  it("estimates chunks per balance", () => {
    expect(chunksFor(50_000_000)).toBe(Math.floor(50_000_000 / CHUNK_TOTAL_RENT));
    expect(chunksFor(-5)).toBe(0);
  });

  it("maps RPCs to wallet chains and encodes signatures", () => {
    expect(chainFor("https://api.devnet.solana.com")).toBe("solana:devnet");
    expect(chainFor("http://127.0.0.1:8799")).toBe("solana:localnet");
    expect(chainFor("https://rpc.example.com")).toBe("solana:mainnet");
    expect(chainFor("http://127.0.0.1:8799", "solana:devnet")).toBe("solana:devnet");
    const pk = Keypair.generate().publicKey;
    expect(bs58(pk.toBytes())).toBe(pk.toBase58());
    expect(bs58(new Uint8Array([0, 0, 1]))).toBe("112");
  });
});
