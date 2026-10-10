import { describe, expect, it } from "vitest";
import { DAY_MAX_STEP_MS, estimateTimeOfDay, isDay, skyState, wrapDiff } from "./sky";

const world = (timeOfDayMs: number, lastTickMs: number, dayLengthSecs: number) => ({ timeOfDayMs, lastTickMs, params: { dayLengthSecs } as never });

describe("isDay (core::mobs::is_day)", () => {
  it("day is the first ceil(len/2) ms", () => {
    expect(isDay(0, 120_000)).toBe(true);
    expect(isDay(59_999, 120_000)).toBe(true);
    expect(isDay(60_000, 120_000)).toBe(false);
    expect(isDay(119_999, 120_000)).toBe(false);
    expect(isDay(120_000, 120_000)).toBe(true);
    // Odd length: div_ceil.
    expect(isDay(30_000, 60_001)).toBe(true);
    expect(isDay(30_001, 60_001)).toBe(false);
    expect(isDay(5, 0)).toBe(true);
  });
});

describe("skyState", () => {
  const len = 120_000;
  it("sun above the horizon exactly while is_day (away from the boundaries)", () => {
    for (let t = 0; t < len; t += 250) {
      const s = skyState(t, len);
      expect(s.day).toBe(isDay(t, len));
      if (t % (len / 2) > 500 && t % (len / 2) < len / 2 - 500) expect(s.elevation > 0).toBe(s.day);
    }
  });
  it("sunrise at 0, noon brightest, midnight darkest but playable", () => {
    expect(skyState(0, len).elevation).toBeCloseTo(0);
    expect(skyState(len / 2, len).elevation).toBeCloseTo(0);
    const noon = skyState(len / 4, len);
    const midnight = skyState((3 * len) / 4, len);
    expect(noon.daylight).toBe(1);
    expect(midnight.daylight).toBe(0);
    expect(noon.ambient + noon.light).toBeGreaterThan(midnight.ambient + midnight.light);
    expect(midnight.ambient + midnight.light).toBeGreaterThan(0.25); // playable
    expect(midnight.stars).toBe(1);
    expect(noon.stars).toBe(0);
    // Night light comes from the moon, opposite the sun.
    expect(midnight.lightDir[1]).toBeGreaterThan(0);
  });
});

describe("estimateTimeOfDay", () => {
  it("advances by chain time since the last tick, capped like advance_day, modulo the day", () => {
    expect(estimateTimeOfDay(world(1000, 50_000, 120), 50_500)).toBe(1500);
    expect(estimateTimeOfDay(world(1000, 50_000, 120), null)).toBe(1000);
    expect(estimateTimeOfDay(world(1000, 50_000, 120), 49_000)).toBe(1000);
    expect(estimateTimeOfDay(world(1000, 50_000, 120), 500_000)).toBe(1000 + DAY_MAX_STEP_MS);
    expect(estimateTimeOfDay(world(119_900, 50_000, 120), 50_200)).toBe(100);
  });
  it("wrapDiff", () => {
    expect(wrapDiff(100, 119_900, 120_000)).toBe(200);
    expect(wrapDiff(119_900, 100, 120_000)).toBe(-200);
  });
});
