import { describe, expect, it } from "vitest";
import { CRACK_STAGES, crackOrder, crackPixels } from "./crack";

describe("crack stages", () => {
  const order = crackOrder();
  const covered = (s: number) => {
    const px = crackPixels(order, s);
    return [...Array(256).keys()].filter((i) => px[i * 4 + 3] > 0);
  };

  it("grow monotonically: each stage keeps the previous stage's pixels", () => {
    let prev = new Set<number>();
    for (let s = 0; s < CRACK_STAGES; s++) {
      const now = new Set(covered(s));
      for (const i of prev) expect(now.has(i)).toBe(true);
      expect(now.size).toBeGreaterThanOrEqual(prev.size);
      prev = now;
    }
    // Starts small, ends covering a good part of the face (but not all of it).
    expect(covered(0).length).toBeGreaterThan(0);
    expect(covered(0).length).toBeLessThan(covered(CRACK_STAGES - 1).length / 3);
    expect(covered(CRACK_STAGES - 1).length).toBeGreaterThan(40);
    expect(covered(CRACK_STAGES - 1).length).toBeLessThan(200);
  });

  it("is deterministic", () => {
    expect(crackOrder()).toEqual(order);
  });
});
