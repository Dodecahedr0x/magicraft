// World picker: every World on the rollup (search, refresh), a detail pane for the selected
// one (Join / Resume / Finish setup) and the create-world panel.
import type { PublicKey } from "@solana/web3.js";
import {
  currentRegion,
  dayCrankStale,
  decodeWorld,
  joinWorldIx,
  pstatePda,
  scheduleDayCrankIx,
  worldChainMs,
  type WorldAccount,
} from "../chain";
import type { App } from "../state";
import { createWorldPanel, progress } from "./createWorld";
import { busy, clear, errText, focusHeading, h, sendResultMessage, short } from "./dom";
import { toForm } from "./params";
import { cachedWorlds, fetchWorlds, visibleWorlds, type WorldEntry } from "./worldList";

const STATUS_TEXT: Record<WorldEntry["status"], string> = {
  ready: "Open",
  setup: "Setup unfinished",
  seeding: "Waiting for seed",
};

/** Re-arms the day crank if it is stale (client-driven watchdog; no-op onchain otherwise). */
export async function dayCrankWatchdog(app: App, world: PublicKey, w: WorldAccount) {
  if (!w.seedSet || !app.state.sender) return;
  const slot = await app.conns.er.getSlot("confirmed");
  const now = worldChainMs(w, slot) ?? Date.now();
  if (dayCrankStale(w, now)) void app.state.sender.send(async () => [await scheduleDayCrankIx(app.program, world)]);
}

/** Joins `world` (creates the PlayerState at spawn) unless already joined; returns the
 *  fresh World account. */
export async function joinOrResume(app: App, world: PublicKey): Promise<{ account: WorldAccount; joined: boolean }> {
  const er = app.conns.er;
  const [wi, pi] = await er.getMultipleAccountsInfo([world, pstatePda(app.cfg.programId, world, app.state.player!)], "confirmed");
  if (!wi) throw new Error("This world no longer exists.");
  const account = decodeWorld(wi.data);
  if (!account.spawnSet) throw new Error("This world is not finished yet.");
  void dayCrankWatchdog(app, world, account).catch(() => {});
  if (pi) return { account, joined: false };
  const r = await app.state.sender!.send(async () => [await joinWorldIx(app.program, app.auth(), world)]);
  const msg = sendResultMessage(r, "Join");
  if (msg !== null) {
    // A timed-out join may have landed: check before failing.
    if (await er.getAccountInfo(pstatePda(app.cfg.programId, world, app.state.player!), "confirmed")) return { account, joined: true };
    throw new Error(msg);
  }
  return { account, joined: true };
}

const fmt = (n: number) => String(n);

function paramSummary(w: WorldAccount) {
  const f = toForm(w.params);
  const row = (k: string, v: string) => h("div", {}, h("dt", {}, k), h("dd", {}, v));
  return h(
    "dl",
    { class: "params" },
    row("Day length", `${Math.round(f.dayLengthSecs / 60)} min`),
    row("Zombies / chunk", f.zombieCapPerChunk ? fmt(f.zombieCapPerChunk) : "Peaceful"),
    row("Fall damage", f.fallDamage ? "On" : "Off"),
    row("Hunger", f.hunger ? "On" : "Off"),
    row("Walk / sprint", `${f.walkSpeed.toFixed(1)} / ${f.sprintSpeed.toFixed(1)} b/s`),
    row("Reach", `${f.reach} blocks`),
  );
}

/** The world picker screen. `onEnter(world)` hands off to the game. */
export function showWorlds(app: App, root: HTMLElement, onEnter: (world: PublicKey, account: WorldAccount) => void) {
  clear(root);
  const me = app.state.wallet!.publicKey;
  // Only the selected region's ER: worlds exist on the ER they were created on.
  const er = app.conns.er;
  const region = currentRegion(app.cfg);
  let entries: WorldEntry[] = cachedWorlds(er, app.cfg.programId, me) ?? [];
  let selected: string | null = null;

  const search = h("input", { id: "world-search", class: "input", type: "search", placeholder: "Search by name or creator", autocomplete: "off" });
  const refresh = h("button", { class: "btn small ghost", type: "button" }, "Refresh");
  const list = h("ul", { class: "world-list", "aria-label": "Worlds" });
  const listStatus = h("p", { class: "muted", role: "status" }, "Loading worlds…");
  const side = h("div", { class: "panel side", "aria-live": "polite" });
  const createBtn = h("button", { class: "btn primary", type: "button" }, "Create a world");

  const renderList = () => {
    const vis = visibleWorlds(entries, search.value);
    clear(list);
    listStatus.textContent = entries.length
      ? vis.length
        ? `${vis.length} world${vis.length === 1 ? "" : "s"}`
        : "No world matches."
      : "No worlds yet. Create the first one.";
    for (const e of vis) {
      const k = e.pubkey.toBase58();
      const btn = h(
        "button",
        { class: "world-row", type: "button", "aria-pressed": selected === k ? "true" : "false", "data-world": k },
        h("span", { class: "world-swatch", "aria-hidden": "true", style: `--h:${hue(k)}` }),
        h("span", { class: "world-name" }, e.world.name || "Unnamed"),
        h("span", { class: "world-meta" }, e.mine ? "Yours" : `by ${short(e.world.creator)}`, " · ", `${e.world.chunkCount} chunk${e.world.chunkCount === 1 ? "" : "s"}`),
        e.status !== "ready" ? h("span", { class: "badge" }, STATUS_TEXT[e.status]) : null,
      );
      btn.addEventListener("click", () => select(k));
      list.append(h("li", {}, btn));
    }
  };

  const select = (k: string) => {
    selected = k;
    renderList();
    const e = entries.find((x) => x.pubkey.toBase58() === k);
    if (e) renderDetail(e);
    // Single-column layout: bring the details into view.
    if (matchMedia("(max-width: 860px)").matches) side.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const renderDetail = (e: WorldEntry) => {
    const err = h("p", { class: "form-error", role: "alert" });
    const w = e.world;
    const action = h("button", { class: "btn primary", type: "button" }, "Join world");
    const actions = h("div", { class: "actions" });
    if (e.status === "ready") {
      actions.append(action);
      void app.conns.er.getAccountInfo(pstatePda(app.cfg.programId, e.pubkey, app.state.player!), "confirmed").then(
        (i) => i && (action.textContent = "Resume"),
        () => {},
      );
      action.addEventListener("click", () =>
        busy(action, "Joining…", async () => {
          err.textContent = "";
          try {
            const { account } = await joinOrResume(app, e.pubkey);
            onEnter(e.pubkey, account);
          } catch (x) {
            err.textContent = errText(x);
          }
        }),
      );
    } else if (e.mine) {
      action.textContent = "Finish setup";
      actions.append(action);
      action.addEventListener("click", () =>
        void progress(app, side, e.pubkey, null, async (world) => {
          try {
            const { account } = await joinOrResume(app, world);
            onEnter(world, account);
          } catch (x) {
            side.append(h("p", { class: "form-error", role: "alert" }, errText(x)));
          }
        }),
      );
    }
    side.replaceChildren(
      h("div", { class: "panel-head" }, h("h2", { tabindex: -1 }, w.name || "Unnamed")),
      h("p", { class: "muted small" }, e.mine ? "Created by you" : `Created by ${short(w.creator)}`, " · ", h("code", {}, short(e.pubkey, 6))),
      h(
        "div",
        { class: "world-facts" },
        h("div", {}, h("span", { class: "stat-label" }, "Status"), h("span", {}, STATUS_TEXT[e.status])),
        h("div", {}, h("span", { class: "stat-label" }, "Chunks"), h("span", {}, fmt(w.chunkCount))),
        h("div", {}, h("span", { class: "stat-label" }, "Spawn"), h("span", {}, w.spawnSet ? w.spawn.join(", ") : "—")),
      ),
      paramSummary(w),
      err,
      actions,
    );
  };

  const showCreate = () => {
    selected = null;
    renderList();
    side.replaceChildren(
      createWorldPanel(
        app,
        async (world) => {
          try {
            const { account } = await joinOrResume(app, world);
            onEnter(world, account);
          } catch (x) {
            side.append(h("p", { class: "form-error", role: "alert" }, errText(x)));
          }
        },
        () => {
          renderEmptySide();
          createBtn.focus();
        },
        () => void load(),
      ),
    );
    side.querySelector<HTMLInputElement>("#world-name")?.focus();
  };

  const renderEmptySide = () =>
    side.replaceChildren(
      h("div", { class: "empty" }, h("h2", {}, "Pick a world"), h("p", { class: "muted" }, "Choose one from the list to see its rules, or start your own. Creating a world takes a few seconds: the seed comes from verifiable randomness."), createBtn),
    );

  const load = async () => {
    listStatus.textContent = "Loading worlds…";
    try {
      const fetched = await fetchWorlds(er, app.cfg.programId, me);
      if (er !== app.conns.er) return; // region switched meanwhile
      entries = fetched;
      renderList();
    } catch (e) {
      listStatus.textContent = `Couldn't load worlds: ${errText(e)}`;
    }
  };
  refresh.addEventListener("click", () => busy(refresh, "Refreshing…", load));
  search.addEventListener("input", renderList);
  createBtn.addEventListener("click", showCreate);

  root.append(
    h(
      "section",
      { class: "screen worlds", "aria-labelledby": "worlds-title" },
      h(
        "div",
        { class: "panel list-panel" },
        h("div", { class: "panel-head" }, h("h1", { id: "worlds-title" }, "Worlds ", h("span", { class: "region-tag", title: `Worlds on the ${region.label} rollup (${region.erRpc})` }, region.label)), refresh),
        h("label", { for: "world-search", class: "sr-only" }, "Search worlds"),
        search,
        listStatus,
        list,
      ),
      side,
    ),
  );
  renderEmptySide();
  focusHeading(root);
  if (entries.length) renderList();
  void load();
}

/** A stable hue per world (list swatch). */
function hue(k: string): number {
  let x = 0;
  for (let i = 0; i < k.length; i++) x = (x * 31 + k.charCodeAt(i)) >>> 0;
  return x % 360;
}
