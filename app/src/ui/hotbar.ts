// Hotbar (Task 26): inventory slots 0..8 with icons, counts and durability bars, the held
// item's name, and slot selection with number keys 1–9 and the mouse wheel (the selection
// is sent as `select_slot`, debounced, by `SlotSelect`).
import type { InvSlot } from "../chain";
import { h } from "./dom";
import { HOTBAR, paintSlot, slotEl, slotView } from "./inventory";

export class Hotbar {
  readonly el: HTMLElement;
  private slots: HTMLButtonElement[] = [];
  private label: HTMLElement;
  private labelTimer: ReturnType<typeof setTimeout> | null = null;
  private lastName = "";
  private off: (() => void)[] = [];

  constructor(
    private readonly select: (i: number) => void,
    private readonly selected: () => number,
    /** Keys / wheel are ignored while this is false (panel open, dead). */
    private readonly active: () => boolean,
  ) {
    for (let i = 0; i < HOTBAR; i++) this.slots.push(slotEl(slotView(undefined, i), (k) => this.select(k)));
    this.label = h("div", { class: "held-name", "aria-live": "polite" });
    this.el = h("div", { class: "hotbar-wrap" }, this.label, h("div", { class: "hotbar", role: "toolbar", "aria-label": "Hotbar" }, ...this.slots));

    const typing = (e: Event) => e.target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable);
    const key = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey || !this.active()) return;
      const m = /^Digit([1-9])$/.exec(e.code);
      if (m) this.select(Number(m[1]) - 1);
    };
    let acc = 0;
    const wheel = (e: WheelEvent) => {
      if (!this.active() || !(document.pointerLockElement || (e.target as Element)?.classList?.contains("game-canvas"))) return;
      acc += e.deltaY;
      if (Math.abs(acc) < 40) return;
      this.select(this.selected() + Math.sign(acc));
      acc = 0;
    };
    window.addEventListener("keydown", key);
    window.addEventListener("wheel", wheel, { passive: true });
    this.off.push(
      () => window.removeEventListener("keydown", key),
      () => window.removeEventListener("wheel", wheel),
    );
  }

  paint(inv: InvSlot[] | null, selected: number) {
    this.slots.forEach((el, i) => paintSlot(el, slotView(inv?.[i], i, i === selected)));
    const v = slotView(inv?.[selected], selected);
    const name = v.empty ? "" : v.name;
    if (name !== this.lastName) {
      this.lastName = name;
      this.label.textContent = name;
      this.label.classList.add("show");
      if (this.labelTimer !== null) clearTimeout(this.labelTimer);
      this.labelTimer = setTimeout(() => this.label.classList.remove("show"), 1800);
    }
  }

  dispose() {
    for (const f of this.off) f();
    if (this.labelTimer !== null) clearTimeout(this.labelTimer);
  }
}
