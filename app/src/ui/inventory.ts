// Inventory UI (Task 26): the slot view model shared by the hotbar and the inventory panel,
// and the panel itself (`E`): 27 main slots + the 9 hotbar slots (read-only — the program
// has no slot-moving ix; clicking a hotbar slot selects it) next to the crafting list.
import type { InvSlot } from "../chain";
import { h } from "./dom";
import { itemIconUrl, itemInfo, itemName } from "./items";

export const HOTBAR = 9;

/** What one slot shows. */
export type SlotView = {
  index: number;
  empty: boolean;
  item: number;
  name: string;
  /** Stack count label ("" for 1 or empty). */
  countLabel: string;
  /** Remaining durability 0..1 for a worn tool, null otherwise (full tools show no bar). */
  durability: number | null;
  selected: boolean;
  /** Tooltip text. */
  title: string;
};

/** The view model of inventory slot `index`. */
export function slotView(s: InvSlot | undefined, index: number, selected = false): SlotView {
  if (!s || s.item === 0 || s.count === 0) return { index, empty: true, item: 0, name: "", countLabel: "", durability: null, selected, title: `Slot ${index + 1}: empty` };
  const info = itemInfo(s.item);
  const name = itemName(s.item);
  const max = info?.maxDurability ?? 0;
  const durability = max > 0 && s.durability < max ? Math.max(0, s.durability / max) : null;
  const extra = max > 0 ? ` · ${s.durability}/${max} uses` : s.count > 1 ? ` × ${s.count}` : "";
  return {
    index,
    empty: false,
    item: s.item,
    name,
    countLabel: s.count > 1 ? String(s.count) : "",
    durability,
    selected,
    title: `${name}${extra}`,
  };
}

/** Durability bar color: green → yellow → red. */
export const durabilityColor = (f: number) => `hsl(${Math.round(f * 120)} 80% 50%)`;

/** A slot element (button) for view `v`; `paint` updates it in place. */
export function slotEl(v: SlotView, onClick?: (i: number) => void): HTMLButtonElement {
  const el = h("button", { class: "slot", type: "button" });
  if (onClick) el.addEventListener("click", () => onClick(Number(el.dataset.index)));
  else el.tabIndex = -1;
  paintSlot(el, v);
  return el;
}

export function paintSlot(el: HTMLElement, v: SlotView) {
  const key = `${v.item}|${v.countLabel}|${v.durability}|${v.selected}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.dataset.index = String(v.index);
  el.classList.toggle("selected", v.selected);
  el.classList.toggle("empty", v.empty);
  el.title = v.title;
  el.setAttribute("aria-label", v.title);
  el.replaceChildren();
  if (v.empty) return;
  el.append(h("img", { class: "slot-icon", src: itemIconUrl(v.item), alt: "", draggable: "false" }));
  if (v.countLabel) el.append(h("span", { class: "slot-count" }, v.countLabel));
  if (v.durability !== null) {
    const bar = h("span", { class: "slot-dur" }, h("span", {}));
    const fill = bar.firstElementChild as HTMLElement;
    fill.style.width = `${Math.round(v.durability * 100)}%`;
    fill.style.background = durabilityColor(v.durability);
    el.append(bar);
  }
}

/** The inventory grid: main slots 9..35 (3 rows), then the hotbar row 0..8. */
export class InventoryGrid {
  readonly el: HTMLElement;
  private main: HTMLButtonElement[] = [];
  private bar: HTMLButtonElement[] = [];

  constructor(onSelect: (i: number) => void) {
    const empty = (i: number) => slotView(undefined, i);
    for (let i = HOTBAR; i < 36; i++) this.main.push(slotEl(empty(i)));
    for (let i = 0; i < HOTBAR; i++) this.bar.push(slotEl(empty(i), onSelect));
    this.el = h(
      "div",
      { class: "inv-grid-wrap" },
      h("h3", { class: "panel-title" }, "Inventory"),
      h("div", { class: "inv-grid" }, ...this.main),
      h("div", { class: "inv-grid hotbar-row" }, ...this.bar),
    );
  }

  paint(inv: InvSlot[], selected: number) {
    this.main.forEach((el, k) => paintSlot(el, slotView(inv[HOTBAR + k], HOTBAR + k)));
    this.bar.forEach((el, i) => paintSlot(el, slotView(inv[i], i, i === selected)));
  }
}
