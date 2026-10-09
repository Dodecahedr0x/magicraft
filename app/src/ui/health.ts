// Health and food bars (Task 26): 10 hearts / 10 drumsticks, each worth 2 points (full,
// half or empty), drawn as inline pixel SVGs; a red flash when health drops; and the death
// screen ("You died" + Respawn → `respawn`; the move sync picks up the reset onchain state).
import { h } from "./dom";

export type Pip = "full" | "half" | "empty";

/** 10 pips for a 0..20 value (2 points each), left to right. */
export function pips(value: number): Pip[] {
  const v = Math.max(0, Math.min(20, Math.floor(value)));
  return Array.from({ length: 10 }, (_, i) => (v >= 2 * i + 2 ? "full" : v === 2 * i + 1 ? "half" : "empty"));
}

const SVG = "http://www.w3.org/2000/svg";
// 9×9 pixel shapes ("#" filled).
const HEART = [".##...##.", "#########", "#########", "#########", ".#######.", "..#####..", "...###...", "....#....", "........."];
const DRUM = ["......##.", ".....####", "....#####", "...#####.", "..#####..", ".####....", "#.##.....", "##.......", ".#......."];

function pixelIcon(shape: string[], fill: string, back: string, half: "left" | "none" | "all"): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 9 9");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("shape-rendering", "crispEdges");
  shape.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c !== "#") return;
      const r = document.createElementNS(SVG, "rect");
      r.setAttribute("x", String(x));
      r.setAttribute("y", String(y));
      r.setAttribute("width", "1");
      r.setAttribute("height", "1");
      r.setAttribute("fill", half === "all" || (half === "left" && x < 5) ? fill : back);
      svg.append(r);
    }),
  );
  return svg;
}

class PipBar {
  readonly el: HTMLElement;
  private last = "";
  constructor(
    private readonly label: string,
    private readonly shape: string[],
    private readonly fill: string,
    cls: string,
  ) {
    this.el = h("div", { class: `pips ${cls}`, role: "img" });
  }
  paint(value: number) {
    const ps = pips(value);
    const key = ps.join();
    if (key === this.last) return;
    this.last = key;
    this.el.setAttribute("aria-label", `${this.label} ${value} of 20`);
    this.el.replaceChildren(...ps.map((p) => pixelIcon(this.shape, this.fill, "rgb(0 0 0 / 0.45)", p === "full" ? "all" : p === "half" ? "left" : "none")));
  }
}

export class HealthBars {
  readonly el: HTMLElement;
  readonly flash: HTMLElement;
  private hearts = new PipBar("Health", HEART, "#e8413c", "hearts");
  private food = new PipBar("Food", DRUM, "#c98a4b", "food");
  private health: number | null = null;

  constructor() {
    this.el = h("div", { class: "bars" }, this.hearts.el, this.food.el);
    this.flash = h("div", { class: "hurt-flash", "aria-hidden": "true" });
  }

  paint(health: number, food: number) {
    if (this.health !== null && health < this.health && health > 0) {
      this.flash.classList.remove("on");
      void this.flash.offsetWidth; // restart the animation
      this.flash.classList.add("on");
      this.hearts.el.classList.remove("shake");
      void this.hearts.el.offsetWidth;
      this.hearts.el.classList.add("shake");
    }
    this.health = health;
    this.hearts.paint(health);
    this.food.paint(food);
  }
}

/** "You died" overlay with a Respawn button. */
export class DeathScreen {
  readonly el: HTMLElement;
  private btn: HTMLButtonElement;
  private note: HTMLElement;

  constructor(onRespawn: () => Promise<boolean>) {
    this.btn = h("button", { class: "btn", type: "button" }, "Respawn");
    this.note = h("p", { class: "death-note", role: "status" });
    this.el = h(
      "div",
      { class: "game-dead", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "death-title", hidden: true },
      h("h2", { id: "death-title" }, "You died"),
      h("p", {}, "Respawning puts you back at the world spawn with an empty inventory."),
      this.btn,
      this.note,
    );
    this.btn.addEventListener("click", async () => {
      this.btn.disabled = true;
      this.btn.setAttribute("aria-busy", "true");
      this.note.textContent = "Respawning…";
      try {
        const ok = await onRespawn();
        this.note.textContent = ok ? "" : "Respawn failed. Try again.";
      } finally {
        this.btn.disabled = false;
        this.btn.removeAttribute("aria-busy");
      }
    });
  }

  get shown() {
    return !this.el.hidden;
  }

  show(on: boolean) {
    if (on === this.shown) return;
    this.el.hidden = !on;
    if (on) {
      this.note.textContent = "";
      if (document.pointerLockElement) document.exitPointerLock();
      this.btn.focus();
    }
  }
}
