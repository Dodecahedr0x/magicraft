// Region-scoped UI state: the world list cache is keyed by ER endpoint (no list leaks across
// regions) and the picker's enabled state.
import { Buffer } from "buffer";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { DEFAULT_WORLD_PARAMS, WORLD_DISCRIMINATOR, WORLD_LEN } from "../chain";
import { pickerDisabledReason } from "./region";
import { cachedWorlds, fetchWorlds } from "./worldList";

const PID = new PublicKey("4GTybm3WD66wUnTgS8UcB9H947uAY7BAqivp8HfbSsW9");

function worldBytes(creator: PublicKey, name: string): Buffer {
  const d = Buffer.alloc(WORLD_LEN);
  d.set(WORLD_DISCRIMINATOR, 0);
  d.set(creator.toBytes(), 8);
  d.write(name, 49, "utf8");
  const p = DEFAULT_WORLD_PARAMS;
  [p.walkSpeed, p.sprintSpeed, p.swimSpeed, p.jumpVelocity, p.gravity, p.maxFallSpeed, p.reach, p.attackCooldownMs, p.dayLengthSecs, p.mobTickMs, p.fluidTickMs].forEach((v, i) => d.writeUInt32LE(v, 81 + 4 * i));
  d[161] = 1;
  d[174] = 1;
  return d;
}

/** A fake ER connection serving `names` as World accounts. */
const fakeEr = (rpcEndpoint: string, names: string[]) => {
  const calls: string[] = [];
  return {
    calls,
    rpcEndpoint,
    getProgramAccounts: (async (pid: PublicKey) => {
      calls.push(pid.toBase58());
      return names.map((n) => ({ pubkey: Keypair.generate().publicKey, account: { data: worldBytes(Keypair.generate().publicKey, n) } }));
    }) as never,
  };
};

describe("world list cache", () => {
  it("is keyed by the ER endpoint: each region only sees its own worlds", async () => {
    const me = Keypair.generate().publicKey;
    const eu = fakeEr("https://devnet-eu.magicblock.app", ["Smoke A", "Smoke B"]);
    const us = fakeEr("https://devnet-us.magicblock.app", []);
    expect(cachedWorlds(eu, PID, me)).toBeNull();
    const a = await fetchWorlds(eu, PID, me);
    expect(a.map((e) => e.world.name).sort()).toEqual(["Smoke A", "Smoke B"]);
    expect(eu.calls).toEqual([PID.toBase58()]);
    // Switching to US: nothing cached there, and its fetch hits the US endpoint only.
    expect(cachedWorlds(us, PID, me)).toBeNull();
    expect(await fetchWorlds(us, PID, me)).toEqual([]);
    expect(us.calls.length).toBe(1);
    expect(cachedWorlds(us, PID, me)).toEqual([]);
    expect(cachedWorlds(eu, PID, me)).toBe(a);
    // Other viewer / program: separate entries.
    expect(cachedWorlds(eu, PID, Keypair.generate().publicKey)).toBeNull();
    expect(cachedWorlds(eu, Keypair.generate().publicKey, me)).toBeNull();
  });
});

describe("region picker", () => {
  it("is disabled with one region, inside a world, or while locked", () => {
    expect(pickerDisabledReason({ regions: 1, inWorld: false, lock: null })).toMatch(/single/);
    expect(pickerDisabledReason({ regions: 3, inWorld: true, lock: null })).toMatch(/Leave the world/);
    expect(pickerDisabledReason({ regions: 3, inWorld: false, lock: "moving" })).toBe("moving");
    expect(pickerDisabledReason({ regions: 3, inWorld: false, lock: null })).toBeNull();
  });
});
