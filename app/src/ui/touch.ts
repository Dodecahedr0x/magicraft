// Touch controls (phones / tablets): shown when the primary pointer is coarse or a touch
// lands on the game screen.
//
// - Left half: a floating joystick (appears under the thumb) → forward / back / left /
//   right (8 directions, dead zone), sprint when pushed to the rim.
// - Anywhere else on the screen: drag to look (the crosshair stays the aim, as on desktop).
// - Buttons: Mine / attack (hold), Use / place (tap; repeats while held like the right
//   mouse button), Jump (hold), and small Inventory / Menu buttons (the E / Esc keys).
//
// Pure mapping helpers (`stickInput`) are unit-tested; the DOM part only wires pointer
// events (multi-touch: each pointer id owns one role).
import type { Input } from "../player/physics";
import { h } from "./dom";

/** Joystick radius, px (the knob travels this far). */
export const STICK_R = 56;
const DEAD = 0.28;
const SPRINT = 0.92;
/** Look sensitivity, radians per px (a bit higher than the mouse: thumbs travel less). */
const LOOK_SENS = 0.0055;

/** Joystick offset (px, screen axes: +y down) → movement input. */
export function stickInput(dx: number, dy: number, r = STICK_R): Partial<Input> {
  const m = Math.hypot(dx, dy) / r;
  if (m < DEAD) return {};
  const [x, y] = [dx / Math.hypot(dx, dy), dy / Math.hypot(dx, dy)];
  // 8 sectors: an axis is on when the direction is within 67.5° of it.
  const on = 0.38; // sin(22.5°)
  return { forward: y < -on, back: y > on, left: x < -on, right: x > on, sprint: m >= SPRINT && y < -on };
}

export const isTouchDevice = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export type TouchDeps = {
  /** Movement input from the stick (merged into the controller's keys). */
  move(input: Partial<Input>): void;
  /** Look delta in radians (yaw, pitch). */
  look(dyaw: number, dpitch: number): void;
  /** Virtual mouse buttons: left = mine / attack, right = use / place. */
  button(b: "left" | "right", down: boolean): void;
  jump(down: boolean): void;
  inventory(): void;
  menu(): void;
  /** Input currently ignored (menu / inventory open, dead). */
  blocked(): boolean;
};

export class TouchControls {
  readonly el: HTMLElement;
  private stick: { id: number; x: number; y: number } | null = null;
  private lookers = new Map<number, { x: number; y: number }>();
  private knob: HTMLElement;
  private base: HTMLElement;
  private off: (() => void)[] = [];

  constructor(
    private readonly screen: HTMLElement,
    private readonly d: TouchDeps,
  ) {
    this.knob = h("div", { class: "stick-knob" });
    this.base = h("div", { class: "stick", hidden: true }, this.knob);
    const hold = (label: string, cls: string, down: (on: boolean) => void) => {
      const b = h("button", { class: `touch-btn ${cls}`, type: "button", "aria-label": label }, label);
      const set = (on: boolean) => (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (on)
          try {
            b.setPointerCapture(e.pointerId); // keep the press while the thumb slides off
          } catch {
            /* pointer not active (synthetic events): fine without capture */
          }
        b.classList.toggle("on", on);
        down(on);
      };
      b.addEventListener("pointerdown", set(true));
      b.addEventListener("pointerup", set(false));
      b.addEventListener("pointercancel", set(false));
      b.addEventListener("contextmenu", (e) => e.preventDefault());
      return b;
    };
    const tap = (label: string, cls: string, f: () => void) => {
      const b = h("button", { class: `touch-btn ${cls}`, type: "button", "aria-label": label }, label);
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      b.addEventListener("click", f);
      return b;
    };
    this.el = h(
      "div",
      { class: "touch-ui", hidden: true },
      this.base,
      h(
        "div",
        { class: "touch-actions" },
        hold("Use", "use", (on) => d.button("right", on)),
        hold("Mine", "mine", (on) => d.button("left", on)),
        hold("Jump", "jump", (on) => d.jump(on)),
      ),
      h("div", { class: "touch-top" }, tap("Inventory", "small", () => d.inventory()), tap("Menu", "small", () => d.menu())),
    );

    const on = <K extends keyof HTMLElementEventMap>(t: EventTarget, type: K, f: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, f as EventListener, opts);
      this.off.push(() => t.removeEventListener(type, f as EventListener));
    };
    // Touch on the game screen (not on a panel / button): stick on the left, look elsewhere.
    on(screen, "pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      this.show(true);
      if (d.blocked() || !(e.target instanceof HTMLCanvasElement)) return;
      e.preventDefault();
      const r = screen.getBoundingClientRect();
      if (!this.stick && e.clientX - r.left < r.width * 0.45) {
        this.stick = { id: e.pointerId, x: e.clientX, y: e.clientY };
        this.base.hidden = false;
        this.base.style.left = `${e.clientX - r.left}px`;
        this.base.style.top = `${e.clientY - r.top}px`;
        this.knob.style.transform = "";
      } else this.lookers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    on(window as unknown as HTMLElement, "pointermove", (e) => {
      if (e.pointerType !== "touch") return;
      if (this.stick?.id === e.pointerId) {
        let [dx, dy] = [e.clientX - this.stick.x, e.clientY - this.stick.y];
        const m = Math.hypot(dx, dy);
        if (m > STICK_R) [dx, dy] = [(dx / m) * STICK_R, (dy / m) * STICK_R];
        this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
        d.move(d.blocked() ? {} : stickInput(dx, dy));
        return;
      }
      const l = this.lookers.get(e.pointerId);
      if (!l) return;
      if (!d.blocked()) d.look(-(e.clientX - l.x) * LOOK_SENS, -(e.clientY - l.y) * LOOK_SENS);
      this.lookers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    const end = (e: PointerEvent) => {
      if (this.stick?.id === e.pointerId) {
        this.stick = null;
        this.base.hidden = true;
        d.move({});
      }
      this.lookers.delete(e.pointerId);
    };
    on(window as unknown as HTMLElement, "pointerup", end);
    on(window as unknown as HTMLElement, "pointercancel", end);
    if (isTouchDevice()) this.show(true);
  }

  /** Releases everything (a panel opened, the page lost focus). */
  reset() {
    this.stick = null;
    this.lookers.clear();
    this.base.hidden = true;
    this.d.move({});
    this.d.button("left", false);
    this.d.button("right", false);
    this.d.jump(false);
    for (const b of this.el.querySelectorAll(".touch-btn.on")) b.classList.remove("on");
  }

  private show(on: boolean) {
    this.el.hidden = !on;
    this.screen.classList.toggle("touch", on);
  }

  dispose() {
    for (const f of this.off) f();
    this.off = [];
    this.el.remove();
  }
}
