import { describe, expect, it } from "vitest";
import { FP, MOB, type V3 } from "../chain";
import { edgeDistance, KNOCKBACK_MS, MobTracker, Motion, angleDiff, type MobSnap } from "./mobs";

const snap = (id: number, x: number, z: number, o: Partial<MobSnap> = {}): MobSnap => ({ id, kind: MOB.PIG, hp: 10, dir: 8, burnMs: 0, pos: [x * FP, 30 * FP, z * FP] as V3, ...o });
const near = (a: V3 | null, b: number[]) => {
  expect(a).not.toBeNull();
  a!.forEach((v, i) => expect(v).toBeCloseTo(b[i], 5));
};

describe("Motion", () => {
  it("interpolates and continues from the shown position", () => {
    const m = new Motion([0, 0, 0]);
    m.retarget([1, 0, 0], 0, 100);
    near(m.at(50), [0.5, 0, 0]);
    expect(m.speed(50)).toBeCloseTo(10);
    m.retarget([1, 0, 1], 50, 100); // mid-segment: from the shown point
    near(m.at(50), [0.5, 0, 0]);
    near(m.at(150), [1, 0, 1]);
    expect(m.speed(200)).toBe(0);
  });
  it("snaps on teleports", () => {
    const m = new Motion([0, 0, 0]);
    m.retarget([10, 0, 0], 0, 100);
    near(m.at(0), [10, 0, 0]);
  });
});

describe("MobTracker", () => {
  it("tracks by id and interpolates between updates", () => {
    const t = new MobTracker(200);
    t.ingest("0,0", [snap(7, 5, 5)], 0);
    t.ingest("0,0", [snap(7, 6, 5)], 1000);
    near(t.pos(7, 1100), [5.5, 30, 5]);
    near(t.pos(7, 1300), [6, 30, 5]);
  });

  it("continues smoothly when a mob crosses into another chunk (new chunk notified first)", () => {
    const t = new MobTracker(200);
    t.ingest("0,0", [snap(7, 15.5, 5)], 0);
    expect(t.ingest("1,0", [snap(7, 16.2, 5)], 1000)).toEqual([]);
    expect(t.ingest("0,0", [], 1010)).toEqual([]);
    expect(t.expire(5000)).toEqual([]);
    expect(t.mobs.size).toBe(1);
    expect([...t.mobs.get(7)!.chunks]).toEqual(["1,0"]);
    near(t.pos(7, 1100), [15.5 + 0.35, 30, 5]); // mid-segment, no jump
  });

  it("continues smoothly when the old chunk is notified first (within the grace period)", () => {
    const t = new MobTracker(200, 450);
    t.ingest("0,0", [snap(7, 15.5, 5)], 0);
    t.ingest("0,0", [], 1000);
    expect(t.expire(1100)).toEqual([]);
    expect(t.ingest("1,0", [snap(7, 16.2, 5)], 1200).map((e) => e.type)).toEqual([]);
    expect(t.expire(3000)).toEqual([]);
    near(t.pos(7, 1300), [15.85, 30, 5]);
  });

  it("reports a death (poof) after the grace period, not on unload", () => {
    const t = new MobTracker(200, 450);
    t.ingest("0,0", [snap(1, 1, 1), snap(2, 2, 2)], 0);
    t.ingest("0,0", [snap(2, 2, 2)], 100);
    expect(t.expire(400)).toEqual([]);
    const ev = t.expire(600);
    expect(ev.map((e) => [e.type, e.id])).toEqual([["died", 1]]);
    t.unload("0,0");
    expect(t.mobs.size).toBe(0);
    expect(t.expire(10_000)).toEqual([]);
  });

  it("a mob vanishing away from the chunk edges dies at once (no crossing possible)", () => {
    const t = new MobTracker(200, 450);
    t.ingest("0,0", [snap(1, 8, 8), snap(2, 15, 8)], 0);
    t.ingest("0,0", [], 100);
    expect(t.expire(100).map((e) => [e.type, e.id])).toEqual([["died", 1]]);
    expect(t.expire(400)).toEqual([]); // the one near the edge waits
    expect(t.expire(600).map((e) => e.id)).toEqual([2]);
    expect(edgeDistance("-1,2", [-15.5, 30, 40])).toBeCloseTo(0.5);
    expect(edgeDistance("-1,2", [-8, 30, 40])).toBe(8);
  });

  it("keeps a mob listed by another loaded chunk when one chunk unloads", () => {
    const t = new MobTracker();
    t.ingest("0,0", [snap(3, 15.9, 1)], 0);
    t.ingest("1,0", [snap(3, 16.1, 1)], 10);
    t.unload("0,0");
    expect(t.mobs.has(3)).toBe(true);
    t.unload("1,0");
    expect(t.mobs.has(3)).toBe(false);
  });

  it("flags hurt on an hp drop and remembers burning", () => {
    const t = new MobTracker();
    t.ingest("0,0", [snap(9, 1, 1, { kind: MOB.ZOMBIE, hp: 20 })], 0);
    const ev = t.ingest("0,0", [snap(9, 1, 1, { kind: MOB.ZOMBIE, hp: 19, burnMs: 333 })], 500);
    expect(ev.map((e) => e.type)).toEqual(["hurt"]);
    expect(t.mobs.get(9)!.hurtAt).toBe(500);
    expect(t.mobs.get(9)!.burnAt).toBe(500);
  });

  it("a move that comes with a hit (knockback) slides fast; a normal step takes a tick", () => {
    const t = new MobTracker(1000);
    t.ingest("0,0", [snap(9, 1, 1, { hp: 10 })], 0);
    t.ingest("0,0", [snap(9, 2, 1, { hp: 9 })], 0);
    expect(t.pos(9, KNOCKBACK_MS)![0]).toBeCloseTo(2);
    t.ingest("0,0", [snap(9, 3, 1, { hp: 9 })], 1000);
    expect(t.pos(9, 1000 + KNOCKBACK_MS)![0]).toBeLessThan(2.5);
  });
});

describe("angleDiff", () => {
  it("wraps to (−π, π]", () => {
    expect(angleDiff(0.1, 2 * Math.PI - 0.1)).toBeCloseTo(0.2);
    expect(angleDiff(-3, 3)).toBeCloseTo(2 * Math.PI - 6);
  });
});
