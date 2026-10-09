// HUD models: inventory slot views, recipe filtering (core craft via wasm), break-time
// parity with the core, health/food pips.
import { describe, expect, it } from "vitest";
import { breakTimeMs, canHarvest, coreItems, coreRecipes, dropItem, maxCrafts, simulateCraft } from "../wasm";
import { clampCount, recipeRows, visibleRows } from "./crafting";
import { pips } from "./health";
import { ITEM_NAMES, itemSprite } from "./items";
import { slotView } from "./inventory";
import { decodeInventory, type InvSlot } from "../chain";

/** 216 inventory bytes from `[item, count, durability]` slots (rest empty). */
function invBytes(slots: [number, number, number?][]): Uint8Array {
  const b = new Uint8Array(216);
  const v = new DataView(b.buffer);
  slots.forEach(([item, count, dur = 0], i) => {
    v.setUint16(i * 6, item, true);
    b[i * 6 + 2] = count;
    v.setUint16(i * 6 + 4, dur, true);
  });
  return b;
}

const LOG = 9;
const PLANKS = 11;
const STICK = 512;
const COBBLE = 4;
const WOOD_PICK = 256;

describe("break time parity (core wasm)", () => {
  it("matches blocks::break_time_ms", () => {
    // hardness / tier speed on the preferred tool, else hardness.
    expect(breakTimeMs(9, 0)).toBe(3000); // log by hand
    expect(breakTimeMs(9, 260)).toBe(1500); // wooden axe
    expect(breakTimeMs(3, 0)).toBe(7500); // stone by hand
    expect(breakTimeMs(3, WOOD_PICK)).toBe(3750);
    expect(breakTimeMs(3, 259)).toBe(937); // diamond pickaxe: 7500 / 8
    expect(breakTimeMs(3, 264)).toBe(7500); // wrong tool (shovel)
    expect(breakTimeMs(2, 267)).toBe(93); // dirt, diamond shovel
    expect(breakTimeMs(17, 0)).toBe(50); // torch
    for (const unbreakable of [0, 8, 23, 30, 200]) expect(breakTimeMs(unbreakable, WOOD_PICK)).toBe(0);
  });

  it("harvest and drops", () => {
    expect(canHarvest(3, 0)).toBe(false);
    expect(canHarvest(3, WOOD_PICK)).toBe(true);
    expect(canHarvest(13, WOOD_PICK)).toBe(false); // iron ore needs stone
    expect(canHarvest(13, 257)).toBe(true);
    expect(dropItem(3)).toEqual([COBBLE, 1]);
    expect(dropItem(1)).toEqual([2, 1]); // grass → dirt
    expect(dropItem(10)).toBeNull();
  });

  it("every core item has a name and a sprite", () => {
    for (const [id, info] of coreItems()) {
      expect(ITEM_NAMES[id], `item ${id}`).toBeTruthy();
      if (info.block < 0) {
        const px = itemSprite(id, info);
        let opaque = 0;
        for (let i = 3; i < px.length; i += 4) if (px[i] > 0) opaque++;
        expect(opaque, `sprite ${id}`).toBeGreaterThan(8);
      }
    }
    expect(coreItems().get(WOOD_PICK)).toMatchObject({ toolKind: 0, tier: 1, maxDurability: 59, maxStack: 1 });
    expect(coreItems().get(771)?.food).toBe(8);
  });
});

describe("inventory slot view", () => {
  it("renders counts, names and durability", () => {
    const inv = decodeInventory(invBytes([[LOG, 5], [WOOD_PICK, 1, 30], [WOOD_PICK, 1, 59], [STICK, 1]]));
    const log = slotView(inv[0], 0, true);
    expect(log).toMatchObject({ empty: false, name: "Log", countLabel: "5", durability: null, selected: true, title: "Log × 5" });
    const worn = slotView(inv[1], 1);
    expect(worn.countLabel).toBe("");
    expect(worn.durability).toBeCloseTo(30 / 59);
    expect(worn.title).toBe("Wooden Pickaxe · 30/59 uses");
    expect(slotView(inv[2], 2).durability).toBeNull(); // full tools show no bar
    expect(slotView(inv[3], 3).countLabel).toBe("");
    expect(slotView(inv[4], 4)).toMatchObject({ empty: true, title: "Slot 5: empty" });
    expect(slotView(undefined, 7).empty).toBe(true);
  });

  it("health and food pips", () => {
    expect(pips(20)).toEqual(Array(10).fill("full"));
    expect(pips(0)).toEqual(Array(10).fill("empty"));
    const p = pips(7);
    expect(p.slice(0, 4)).toEqual(["full", "full", "full", "half"]);
    expect(p.slice(4)).toEqual(Array(6).fill("empty"));
    expect(pips(25)).toEqual(pips(20));
  });
});

describe("recipe filtering", () => {
  const recipes = coreRecipes();
  const idOf = (out: number) => recipes.findIndex((r) => r.output[0] === out);

  it("decodes the core recipe table in id order", () => {
    expect(recipes.length).toBe(27);
    expect(recipes[0]).toEqual({ id: 0, inputs: [[LOG, 1]], output: [PLANKS, 4], station: 0, fuel: 0 });
    expect(recipes[idOf(WOOD_PICK)]).toMatchObject({ id: 5, inputs: [[PLANKS, 3], [STICK, 2]], station: 1 });
    expect(recipes[idOf(514)]).toMatchObject({ station: 2, fuel: 1 }); // iron ingot: smelting
  });

  const rowsFor = (slots: [number, number, number?][], near = { table: false, furnace: false }) => {
    const b = invBytes(slots);
    return recipeRows(b, decodeInventory(b), near);
  };

  it("lists what the inventory and stations allow, with counts", () => {
    const rows = rowsFor([[LOG, 3]]);
    const craftable = visibleRows(rows, false);
    expect(craftable.map((r) => r.recipe.output[0])).toEqual([PLANKS]);
    expect(craftable[0].max).toBe(3);
    expect(visibleRows(rows, true).length).toBe(27);
    // 8 planks: sticks (4×), table (2×); the pickaxe needs a table and sticks.
    const r2 = rowsFor([[PLANKS, 8]]);
    const m = new Map(r2.map((r) => [r.recipe.output[0], r]));
    expect(m.get(STICK)!.max).toBe(4);
    expect(m.get(15)!.max).toBe(2);
    expect(m.get(WOOD_PICK)!.max).toBe(0);
    expect(m.get(WOOD_PICK)!.reason).toBe("Needs a crafting table within reach");
    // With the table: still missing sticks.
    const r3 = new Map(rowsFor([[PLANKS, 8]], { table: true, furnace: false }).map((r) => [r.recipe.output[0], r]));
    expect(r3.get(WOOD_PICK)!.reason).toBe("Missing 2 Stick");
    const r4 = new Map(rowsFor([[PLANKS, 7], [STICK, 4]], { table: true, furnace: false }).map((r) => [r.recipe.output[0], r]));
    expect(r4.get(WOOD_PICK)!.max).toBe(2);
    expect(r4.get(WOOD_PICK)!.inputs).toEqual([
      { item: PLANKS, have: 7, need: 3 },
      { item: STICK, have: 4, need: 2 },
    ]);
    // Craftable first.
    expect(rowsFor([[PLANKS, 8]])[0].max).toBeGreaterThan(0);
  });

  it("smelting needs a furnace and fuel", () => {
    const ingot = idOf(514);
    const noFuel = rowsFor([[13, 2]], { table: false, furnace: true }).find((r) => r.recipe.id === ingot)!;
    expect(noFuel.max).toBe(0);
    expect(noFuel.reason).toBe("Needs fuel (coal or planks)");
    const fuel = rowsFor([[13, 2], [513, 1], [PLANKS, 5]], { table: false, furnace: true }).find((r) => r.recipe.id === ingot)!;
    expect(fuel.max).toBe(2);
  });

  it("agrees with the core's craft on random inventories", () => {
    let seed = 3;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const pool = [LOG, PLANKS, STICK, COBBLE, 513, 13, 514, 515, 5, 770];
    for (let k = 0; k < 200; k++) {
      const slots: [number, number][] = [];
      for (let i = 0; i < 1 + rnd(6); i++) slots.push([pool[rnd(pool.length)], 1 + rnd(64)]);
      const b = invBytes(slots);
      const near = { table: rnd(2) === 1, furnace: rnd(2) === 1 };
      for (const row of recipeRows(b, decodeInventory(b), near)) {
        const id = row.recipe.id;
        if (row.max > 0) expect(simulateCraft(b, id, row.max, near.table, near.furnace).ok).toBe(true);
        if (row.max < 64) expect(simulateCraft(b, id, row.max + 1, near.table, near.furnace).ok).toBe(false);
        expect(maxCrafts(b, id, near.table, near.furnace)).toBe(row.max);
      }
    }
  });

  it("craft count clamp", () => {
    expect(clampCount(5, 3)).toBe(3);
    expect(clampCount(0, 3)).toBe(1);
    expect(clampCount(2, 0)).toBe(0);
    expect(clampCount(NaN, 4)).toBe(1);
  });

  it("simulated craft returns the new inventory", () => {
    const b = invBytes([[LOG, 2]]);
    const r = simulateCraft(b, 0, 2, false, false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(decodeInventory(r.inv).filter((s: InvSlot) => s.count).map((s) => [s.item, s.count])).toEqual([[PLANKS, 8]]);
    expect(simulateCraft(b, 0, 3, false, false)).toEqual({ ok: false, error: "MissingInputs" });
  });
});
