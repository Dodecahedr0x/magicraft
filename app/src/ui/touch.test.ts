import { describe, expect, it } from "vitest";
import { STICK_R, stickInput } from "./touch";

describe("touch joystick", () => {
  it("dead zone: no input near the center", () => {
    expect(stickInput(5, -5)).toEqual({});
  });
  it("cardinal and diagonal directions (screen +y is down)", () => {
    expect(stickInput(0, -40)).toMatchObject({ forward: true, back: false, left: false, right: false });
    expect(stickInput(40, 0)).toMatchObject({ forward: false, right: true });
    expect(stickInput(-30, 30)).toMatchObject({ back: true, left: true, forward: false, right: false });
  });
  it("sprints only when pushed forward to the rim", () => {
    expect(stickInput(0, -STICK_R).sprint).toBe(true);
    expect(stickInput(0, -STICK_R * 0.6).sprint).toBe(false);
    expect(stickInput(0, STICK_R).sprint).toBe(false);
  });
});
