import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { FP, PRESENCE_STALE_MS, type V3 } from "../chain";
import { FADE_MS, PlayerTracker, shortKey, visiblePlayers, type PresenceLike } from "./players";

const keys = [0, 1, 2].map(() => Keypair.generate().publicKey);
const entry = (k: number, x: number, lastSeenMs: number): PresenceLike => ({ player: keys[k], pos: [x * FP, 30 * FP, 0] as V3, lastSeenMs });

describe("visiblePlayers", () => {
  it("keeps fresh entries, excludes self, dedupes by player (newest wins)", () => {
    const now = 100_000;
    const lists = [
      [entry(0, 1, now - 100), entry(1, 2, now - PRESENCE_STALE_MS - 1)],
      [entry(0, 5, now - 50), entry(2, 3, now - PRESENCE_STALE_MS)],
    ];
    const v = visiblePlayers(lists, null, now);
    expect([...v.keys()].sort()).toEqual([keys[0], keys[2]].map((k) => k.toBase58()).sort());
    expect(v.get(keys[0].toBase58())!.pos[0]).toBe(5 * FP);
    const noSelf = visiblePlayers(lists, keys[0].toBase58(), now);
    expect([...noSelf.keys()]).toEqual([keys[2].toBase58()]);
    expect(visiblePlayers(lists, null, null).size).toBe(0);
  });
});

describe("PlayerTracker", () => {
  it("interpolates, fades out when stale and drops after the fade", () => {
    const t = new PlayerTracker();
    const k = keys[1].toBase58();
    const vis = (x: number) => new Map([[k, entry(1, x, 0)]]);
    t.update(vis(0), 0);
    t.update(vis(1), 1000);
    const p = t.players.get(k)!;
    expect(p.motion.at(1075)[0]).toBeCloseTo(0.5);
    expect(t.alpha(p, 1000)).toBe(1);
    t.update(new Map(), 2000);
    expect(t.alpha(p, 2000 + FADE_MS / 2)).toBeCloseTo(0.5);
    t.update(new Map(), 2000 + FADE_MS);
    expect(t.players.has(k)).toBe(false);
  });
  it("short keys", () => {
    expect(shortKey("ABCDEFGHIJKLMNOP")).toBe("ABCD…MNOP");
  });
});
