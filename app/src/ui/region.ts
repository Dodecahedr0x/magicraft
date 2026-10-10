// ER region UI: the top-bar picker (Europe / US / Asia on devnet, "Local" on the local
// stack) and the screen shown when the wallet's Player is delegated to another region's
// validator (switch there, or move the Player here: withdraw on the old ER → base → the
// usual "parked player" delegate step pinned to the selected region's validator).
import "./region.css";
import {
  currentRegion,
  makeConnections,
  selectRegion,
  type PlayerPlacement,
  type Region,
} from "../chain";
import type { App } from "../state";
import { announce, busy, clear, errText, focusHeading, h, short } from "./dom";
import { withdrawToBase } from "./hud";
import { fetchWorlds, visibleWorlds } from "./worldList";

let lockReason: string | null = null;
let repaintPicker: (() => void) | null = null;

/** Blocks region changes while something depends on the current ER (null unblocks). */
export function lockRegion(reason: string | null) {
  lockReason = reason;
  repaintPicker?.();
}

/** Why the picker is disabled right now (null: it is enabled). Pure, for tests. */
export function pickerDisabledReason(o: { regions: number; inWorld: boolean; lock: string | null }): string | null {
  if (o.regions < 2) return "This build has a single rollup.";
  if (o.inWorld) return "Leave the world to change the region.";
  return o.lock;
}

/** Top-bar region picker; `onPick(id)` runs when the player selects another region. */
export function regionPicker(app: App, onPick: (id: string) => void): HTMLElement {
  const sel = h("select", { id: "region-select", class: "region-select" });
  for (const r of app.cfg.regions) sel.append(h("option", { value: r.id }, r.label));
  const el = h(
    "label",
    { class: "region-picker", for: "region-select" },
    h("span", { class: "region-picker-label" }, "Region"),
    sel,
  );
  const paint = () => {
    sel.value = app.cfg.region;
    const why = pickerDisabledReason({ regions: app.cfg.regions.length, inWorld: !!app.state.world, lock: lockReason });
    sel.disabled = why !== null;
    el.title = why ?? `Rollup: ${currentRegion(app.cfg).erRpc}. Worlds live on the rollup they were created on.`;
  };
  sel.addEventListener("change", () => {
    if (sel.value !== app.cfg.region) onPick(sel.value);
  });
  repaintPicker = paint;
  app.on(paint);
  paint();
  return el;
}

/** "Your player is in <region>": switch there, or move the Player to the selected region.
 *  Creating / joining worlds is not offered here (the Player can't act on this ER). */
export function showRegionMismatch(
  app: App,
  root: HTMLElement,
  where: Extract<PlayerPlacement, { kind: "elsewhere" }>,
  ctx: { switchTo(id: string): void; next(): void },
) {
  clear(root);
  const here = currentRegion(app.cfg);
  const there: Region | null = where.region;
  const err = h("p", { class: "form-error", role: "alert" });
  const status = h("p", { class: "muted", role: "status" });
  const actions = h("div", { class: "actions" });
  const move = h("div", { class: "region-move", hidden: true });
  const panel = h(
    "div",
    { class: "panel narrow" },
    h("h1", {}, there ? `Your player is in ${there.label}` : "Your player is on another rollup"),
    there
      ? h(
          "p",
          {},
          `You picked ${here.label}, but your player is delegated to the ${there.label} rollup. Worlds and your progress in them live on the rollup where they were created, so you can play in ${there.label}, or move your player to ${here.label}.`,
        )
      : h(
          "p",
          {},
          `Your player is delegated to the validator ${short(where.validator, 6)}, which none of this app's regions runs. Withdraw it from there with a client for that rollup, then come back.`,
        ),
    status,
    err,
    actions,
    move,
  );

  if (there) {
    const sw = h("button", { class: "btn primary", type: "button" }, `Switch to ${there.label}`);
    sw.addEventListener("click", () => ctx.switchTo(there.id));
    const mv = h("button", { class: "btn ghost", type: "button" }, `Move player to ${here.label}`);
    mv.addEventListener("click", () => {
      move.hidden = false;
      mv.disabled = true;
      move.querySelector<HTMLButtonElement>("button")?.focus();
    });
    actions.append(sw, mv);

    const go = h("button", { class: "btn warn", type: "button" }, `Move to ${here.label}`);
    const cancel = h("button", { class: "btn ghost", type: "button" }, "Cancel");
    cancel.addEventListener("click", () => {
      move.hidden = true;
      mv.disabled = false;
      mv.focus();
    });
    move.append(
      h("strong", {}, `Moving your player to ${here.label}`),
      h(
        "ul",
        {},
        h("li", {}, `First approval: withdraw it from ${there.label}. Its SOL settles on the base layer (usually a few seconds).`),
        h("li", {}, `Second approval: delegate it to ${here.label}, optionally adding SOL.`),
        h(
          "li",
          {},
          `Your worlds, chunks and per-world progress in ${there.label} stay there. The rent of chunks you opened there stays locked until you play there again (switch to ${there.label} first to reclaim unused chunks).`,
        ),
      ),
      h("div", { class: "actions" }, go, cancel),
    );
    go.addEventListener("click", () =>
      busy(go, "Moving…", async () => {
        err.textContent = "";
        cancel.disabled = sw.disabled = true;
        lockRegion("Finishing the move of your player…");
        try {
          const er = makeConnections(selectRegion(app.cfg, there.id)).er;
          await withdrawToBase(app, (m) => (status.textContent = m), er);
          status.textContent = "Your player is on the base layer.";
          announce(`Withdrawn from ${there.label}. Now delegate it to ${here.label}.`);
          lockRegion(null);
          ctx.next();
        } catch (e) {
          lockRegion(null);
          err.textContent = errText(e);
          cancel.disabled = sw.disabled = false;
          go.textContent = "Try again";
        }
      }),
    );
  }

  // Read-only preview of this region's worlds (joining needs the player here).
  const worlds = h("ul", { class: "region-worlds", "aria-label": `Worlds in ${here.label}` });
  const wStatus = h("p", { class: "muted small", role: "status" }, "Loading worlds…");
  const er = app.conns.er;
  void fetchWorlds(er, app.cfg.programId, app.state.wallet?.publicKey ?? null).then(
    (list) => {
      if (er !== app.conns.er) return;
      const vis = visibleWorlds(list).filter((e) => e.status === "ready");
      wStatus.textContent = vis.length
        ? `${vis.length} world${vis.length === 1 ? "" : "s"} here. Move your player to ${here.label} to join them.`
        : `No worlds in ${here.label} yet.`;
      for (const e of vis.slice(0, 8))
        worlds.append(h("li", {}, h("span", {}, e.world.name || "Unnamed"), h("span", { class: "muted small" }, `${e.world.chunkCount} chunks`)));
    },
    (e) => (wStatus.textContent = `Couldn't load worlds: ${errText(e)}`),
  );

  root.append(
    h(
      "section",
      { class: "screen center" },
      h(
        "div",
        { class: "region-stack" },
        panel,
        h(
          "section",
          { class: "panel narrow", "aria-labelledby": "region-worlds-title" },
          h("h2", { id: "region-worlds-title" }, "Worlds in ", h("span", { class: "region-tag" }, here.label)),
          wStatus,
          worlds,
        ),
      ),
    ),
  );
  focusHeading(root);
}
