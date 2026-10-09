// Crafting panel (Task 26): the core's recipe table (`coreRecipes()`, id = index = what
// `craft` takes), each with the largest count the core's own `craft` accepts for the
// current inventory and the stations within reach (`maxCrafts`, wasm), so the list shows
// exactly what the program would accept. Craftable recipes first; "Show all" lists the
// rest with the reason (station, ingredients, fuel, space).
import type { InvSlot } from "../chain";
import { coreRecipes, maxCrafts, simulateCraft, type CoreRecipe } from "../wasm";
import { h } from "./dom";
import { itemIconUrl, itemName } from "./items";

export type Stations = { table: boolean; furnace: boolean };

export type RecipeRow = {
  recipe: CoreRecipe;
  /** Largest craftable count now (0 = not craftable). */
  max: number;
  /** Per input: item, held, needed for one craft. */
  inputs: { item: number; have: number; need: number }[];
  /** Why it can't be crafted (null when `max > 0`). */
  reason: string | null;
};

export const STATION_NAMES = ["", "Crafting table", "Furnace"];

/** Total count of `item` in the inventory. */
export const countOf = (inv: readonly InvSlot[], item: number) => inv.reduce((n, s) => n + (s.item === item ? s.count : 0), 0);

/** Every recipe with its craftable count and reason, craftable ones first (then by id). */
export function recipeRows(invBytes: Uint8Array, inv: readonly InvSlot[], near: Stations): RecipeRow[] {
  const rows = coreRecipes().map((recipe): RecipeRow => {
    const max = maxCrafts(invBytes, recipe.id, near.table, near.furnace);
    const inputs = recipe.inputs.map(([item, need]) => ({ item, have: countOf(inv, item), need }));
    let reason: string | null = null;
    if (max === 0) {
      const r = simulateCraft(invBytes, recipe.id, 1, near.table, near.furnace);
      const err = r.ok ? null : r.error;
      if (err === "WrongStation") reason = `Needs a ${STATION_NAMES[recipe.station].toLowerCase()} within reach`;
      else if (err === "MissingInputs") {
        const miss = inputs.filter((i) => i.have < i.need).map((i) => `${i.need - i.have} ${itemName(i.item)}`);
        reason = `Missing ${miss.join(", ")}`;
      } else if (err === "MissingFuel") reason = "Needs fuel (coal or planks)";
      else if (err === "InventoryFull") reason = "Inventory full";
      else reason = err ?? "Can't craft";
    }
    return { recipe, max, inputs, reason };
  });
  return rows.sort((a, b) => Number(b.max > 0) - Number(a.max > 0) || a.recipe.id - b.recipe.id);
}

/** The rows the panel shows: craftable ones, or all with `showAll`. */
export const visibleRows = (rows: RecipeRow[], showAll: boolean) => (showAll ? rows : rows.filter((r) => r.max > 0));

/** Clamps a requested craft count to `1..max` (max 0 → 0). */
export const clampCount = (n: number, max: number) => (max <= 0 ? 0 : Math.max(1, Math.min(max, Math.floor(n) || 1)));

// ---------------------------------------------------------------- view

export class CraftingPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private stationsEl: HTMLElement;
  private showAll = false;
  private counts = new Map<number, number>();
  private busy = new Set<number>();
  private last: { rows: RecipeRow[]; near: Stations } | null = null;

  constructor(private readonly onCraft: (recipe: number, count: number) => Promise<boolean>) {
    const toggle = h("input", { type: "checkbox", id: "craft-all" });
    toggle.addEventListener("change", () => {
      this.showAll = toggle.checked;
      this.render();
    });
    this.stationsEl = h("p", { class: "craft-stations" });
    this.list = h("ul", { class: "craft-list", role: "list" });
    this.el = h(
      "div",
      { class: "craft-panel" },
      h("div", { class: "craft-head" }, h("h3", { class: "panel-title" }, "Crafting"), h("label", { class: "check small", for: "craft-all" }, toggle, h("span", {}, "Show all"))),
      this.stationsEl,
      this.list,
    );
  }

  private sig = "";

  /** Recomputes the rows (only when the inventory bytes or the stations changed: the
   *  PlayerState updates ~8×/s with every move). */
  update(invBytes: Uint8Array, inv: readonly InvSlot[], near: Stations) {
    const sig = `${near.table}${near.furnace}${invBytes.join(",")}`;
    if (sig === this.sig) return;
    this.sig = sig;
    this.last = { rows: recipeRows(invBytes, inv, near), near };
    this.render();
  }

  private render() {
    if (!this.last) return;
    const { rows, near } = this.last;
    this.stationsEl.textContent = `Within reach: ${[near.table && "crafting table", near.furnace && "furnace"].filter(Boolean).join(", ") || "no stations (hand recipes only)"}`;
    const shown = visibleRows(rows, this.showAll);
    if (!shown.length) {
      this.list.replaceChildren(h("li", { class: "craft-empty muted" }, "Nothing craftable yet. Punch a tree for logs, or tick “Show all”."));
      return;
    }
    // Keep keyboard focus on the same control across the rebuild.
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.focus;
    this.list.replaceChildren(...shown.map((r) => this.row(r)));
    if (focused) this.list.querySelector<HTMLElement>(`[data-focus="${focused}"]`)?.focus();
  }

  private row(r: RecipeRow): HTMLElement {
    const id = r.recipe.id;
    const [out, outN] = r.recipe.output;
    const n = clampCount(this.counts.get(id) ?? 1, r.max);
    const count = h("output", { class: "craft-count" }, String(n || 1));
    const set = (v: number) => {
      const c = clampCount(v, r.max);
      this.counts.set(id, c);
      count.textContent = String(c);
      go.textContent = `Craft ${c > 1 ? `×${c}` : ""}`.trim();
    };
    const step = (label: string, d: number, aria: string) =>
      h("button", { class: "btn tiny ghost", type: "button", "aria-label": aria, "data-focus": `${id}:${label}`, disabled: r.max <= 1, onclick: () => set((this.counts.get(id) ?? 1) + d) }, label);
    const go = h("button", { class: "btn tiny", type: "button", "data-focus": `${id}:go`, disabled: r.max === 0 || this.busy.has(id) }, "Craft");
    go.addEventListener("click", async () => {
      const c = clampCount(this.counts.get(id) ?? 1, r.max);
      if (!c || this.busy.has(id)) return;
      this.busy.add(id);
      go.disabled = true;
      go.setAttribute("aria-busy", "true");
      try {
        await this.onCraft(id, c);
      } finally {
        this.busy.delete(id);
        go.disabled = false;
        go.removeAttribute("aria-busy");
      }
    });
    set(n || 1);
    const icon = (item: number) => h("img", { class: "craft-icon", src: itemIconUrl(item), alt: "" });
    return h(
      "li",
      { class: `craft-row${r.max ? "" : " off"}` },
      h("div", { class: "craft-out" }, icon(out), h("span", { class: "craft-name" }, itemName(out), outN > 1 ? h("span", { class: "muted" }, ` ×${outN}`) : null)),
      h(
        "div",
        { class: "craft-in" },
        ...r.inputs.map((i) =>
          h("span", { class: `craft-chip${i.have < i.need ? " short" : ""}`, title: `${itemName(i.item)}: have ${i.have}, need ${i.need} each` }, icon(i.item), `${i.need}`),
        ),
        r.recipe.station ? h("span", { class: "craft-station" }, STATION_NAMES[r.recipe.station]) : null,
        r.recipe.fuel ? h("span", { class: "craft-station" }, `+${r.recipe.fuel} fuel`) : null,
      ),
      r.max
        ? h("div", { class: "craft-go" }, step("−", -1, "Fewer"), count, step("+", 1, "More"), h("button", { class: "btn tiny ghost", type: "button", "data-focus": `${id}:max`, onclick: () => set(r.max) }, "Max"), go)
        : h("p", { class: "craft-why" }, r.reason ?? ""),
    );
  }
}
