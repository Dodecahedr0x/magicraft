import { describe, expect, it, vi } from "vitest";
import { chunkKey, viewOf, type SendResult } from "../chain";
import { AutoCreator } from "./autocreate";
import type { ChunkEntry } from "./store";

/** A store stub: `ready` keys are DONE, `stage` maps key → gen stage, the rest missing. */
function stub(ready: string[], stage: Record<string, number> = {}, r = 4) {
  const entries = new Map<string, ChunkEntry>();
  for (let dz = -r; dz <= r; dz++)
    for (let dx = -r; dx <= r; dx++) {
      const key = chunkKey(dx, dz);
      const gs = ready.includes(key) ? 2 : stage[key];
      entries.set(key, { cx: dx, cz: dz, key, status: gs === undefined ? "missing" : "present", genStage: gs ?? -1, data: new Uint8Array(64), blocks: null, sub: null, version: 0, pda: null as never });
    }
  const readySet = () => new Set([...entries.values()].filter((e) => e.genStage === 2).map((e) => e.key));
  const existing = () => new Set([...entries.values()].filter((e) => e.status === "present").map((e) => e.key));
  return {
    entries,
    store: { entry: (k: string) => entries.get(k), entries: () => entries.values(), ready: (cx: number, cz: number) => readySet().has(chunkKey(cx, cz)), refresh: async (k: string) => { const e = entries.get(k)!; if (e.status === "missing") { e.status = "present"; e.genStage = 2; } } },
    view: { exists: (cx: number, cz: number) => viewOf(existing(), readySet()).exists(cx, cz), ready: (cx: number, cz: number) => readySet().has(chunkKey(cx, cz)) },
  };
}
const ok: SendResult = { status: "confirmed", sig: "s", ms: 1 };
const ixs = { createAndGrow: vi.fn(async () => []), grow: vi.fn(async () => []), populate: vi.fn(async () => []) };

describe("AutoCreator", () => {
  it("creates outward from ready chunks, nearest first, never two adjacent at once", () => {
    const s = stub(["0,0"]);
    const a = new AutoCreator({ store: s.store, view: s.view, send: async () => ok, ixs, radius: 3 });
    a.focus = [0, 0];
    const first = a.next()!;
    expect(first.step).toBe("create");
    expect(Math.abs(first.cx) + Math.abs(first.cz)).toBe(1);
    a.inflight.set(first.key, "create");
    const second = a.next()!;
    expect(Math.abs(second.cx - first.cx) + Math.abs(second.cz - first.cz)).toBeGreaterThan(1);
    expect(Math.abs(second.cx) + Math.abs(second.cz)).toBe(1);
  });

  it("does not create chunks detached from anything ready, except the player's own", () => {
    const s = stub(["0,0"]);
    const a = new AutoCreator({ store: s.store, view: s.view, send: async () => ok, ixs, radius: 1 });
    a.focus = [3, 3];
    // Radius-1 circle around (3,3) is not adjacent to (0,0).
    expect(a.next()).toBeNull();
    a.setOwn(3, 3);
    expect(a.next()).toMatchObject({ key: "3,3", step: "create" });
  });

  it("resumes stage 0 / 1 chunks with grow / populate", () => {
    const s = stub(["0,0"], { "1,0": 1, "0,1": 0 });
    const a = new AutoCreator({ store: s.store, view: s.view, send: async () => ok, ixs, radius: 1 });
    a.focus = [0, 0];
    const steps = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const j = a.next()!;
      steps.add(`${j.key}:${j.step}`);
      a.inflight.set(j.key, j.step);
    }
    expect(steps).toEqual(new Set(["1,0:populate", "0,1:grow"]));
  });

  it("creates (0,0) in an empty world and halts on topup", async () => {
    const s = stub([]);
    const events: string[] = [];
    const send = vi.fn(async (): Promise<SendResult> => ({ status: "failed", error: { kind: "topup", name: "InsufficientSponsorFunds", message: "x" } }));
    const a = new AutoCreator({ store: s.store, view: s.view, send, ixs, radius: 2, onEvent: (e) => events.push(e.type) });
    a.setFocus(0, 0);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(a.halted).toBe("topup"));
    expect(events).toContain("halted");
    a.tick();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("runs create + populate and counts the rent", async () => {
    const s = stub(["0,0"]);
    const send = vi.fn(async () => ok);
    const a = new AutoCreator({ store: s.store, view: s.view, send, ixs, radius: 1, concurrency: 1 });
    a.setFocus(0, 0);
    // Radius 1 = the 3×3 square: 8 missing chunks, two gen txs each, then idle.
    await vi.waitFor(() => expect(a.created).toBe(8));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(16));
    expect(a.spentLamports).toBe(8 * 554_240);
    expect(a.next()).toBeNull();
    a.dispose();
  });
});
