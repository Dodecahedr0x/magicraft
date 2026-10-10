// World picker: every World on the rollup (search, refresh), a detail pane for the selected
// one (Join / Resume / Finish setup / Close world), the create-world panel and the reclaim
// panel (close the unused chunks you paid for, and your untouched worlds, for their rent).
import type { PublicKey } from "@solana/web3.js";
import {
  CHUNK_TOTAL_RENT,
  closeWorldIx,
  currentRegion,
  dayCrankStale,
  decodeWorld,
  enterWorldIx,
  joinWorldIx,
  MAX_EXPIRE,
  pstatePda,
  scheduleDayCrankIx,
  worldChainMs,
  type WorldAccount,
} from "../chain";
import type { App } from "../state";
import { createWorldPanel, progress } from "./createWorld";
import { busy, clear, errText, focusHeading, h, sendResultMessage, short, sol } from "./dom";
import { closeChunks } from "./hud";
import { toForm } from "./params";
import { fetchWithdrawPlan, type WithdrawPlan } from "./withdrawPlan";
import { cachedWorlds, expireSilent, fetchWorlds, findSilentPlayers, visibleWorlds, worldClosable, worldCloseRefund, type WorldEntry } from "./worldList";

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
  if (pi) {
    // Back in: counted in again (`enter_world`; a no-op if this player still counts as in),
    // counting out this world's silent players on the way. A failure is not fatal: the
    // first move then fails `NotInWorld` and the game enters again (`MoveSync.reenter`).
    const entry: WorldEntry = { pubkey: world, world: account, mine: false, status: "ready" };
    const me = pstatePda(app.cfg.programId, world, app.state.player!);
    const silent = (await findSilentPlayers(er, app.cfg.programId, [entry]).catch(() => null))?.get(world.toBase58()) ?? [];
    const expire = silent.filter((k) => !k.equals(me)).slice(0, MAX_EXPIRE);
    const r = await app.state.sender!.send(async () => [await enterWorldIx(app.program, app.auth(), world, expire)]);
    const msg = sendResultMessage(r, "Entering the world");
    if (msg !== null) console.warn(msg);
    return { account, joined: false };
  }
  const r = await app.state.sender!.send(async () => [await joinWorldIx(app.program, app.auth(), world)]);
  const msg = sendResultMessage(r, "Join");
  if (msg !== null) {
    // A timed-out join may have landed: check before failing.
    if (await er.getAccountInfo(pstatePda(app.cfg.programId, world, app.state.player!), "confirmed")) return { account, joined: true };
    throw new Error(msg);
  }
  return { account, joined: true };
}

/** Sends `close_world` for `world`; returns an error message, or null once closed. */
async function closeWorld(app: App, world: PublicKey, w: WorldAccount): Promise<string | null> {
  if (!app.state.sender) return "No play session.";
  const r = await app.state.sender.send(async () => [await closeWorldIx(app.program, app.auth(), world, w.chunkCount > 0)]);
  return sendResultMessage(r, "Closing the world");
}

const fmt = (n: number) => String(n);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

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
export function showWorlds(app: App, root: HTMLElement, onEnter: (world: PublicKey, account: WorldAccount) => void, notice: string | null = null) {
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

  // Players in each world (`World.playersOnline`, counted onchain on enter / leave). Spans
  // showing a count carry `data-online` = the world key and are updated in place.
  const countsOf = (es: readonly WorldEntry[]) => new Map(es.map((e) => [e.pubkey.toBase58(), e.world.playersOnline]));
  let online = countsOf(entries);
  const onlineText = (k: string, long = false) => {
    const n = online.get(k) ?? 0;
    return long ? fmt(n) : `${n} online`;
  };
  const onlineSpan = (k: string, long = false) =>
    h("span", { "data-online": k, "data-long": long ? "1" : null, class: online.get(k) ? "online live" : "online" }, onlineText(k, long));
  const paintOnline = () => {
    for (const el of root.querySelectorAll<HTMLElement>("[data-online]")) {
      const k = el.dataset.online!;
      el.textContent = onlineText(k, el.dataset.long === "1");
      el.classList.toggle("live", !!online.get(k));
    }
  };
  /** Counts out players whose client went silent (> 1 min: closed or crashed; free ER txs
   *  from our session key), then re-reads the counts. */
  const loadOnline = async () => {
    try {
      const sender = app.state.sessionStale ? null : app.state.sender;
      const silent = sender ? await findSilentPlayers(er, app.cfg.programId, entries) : new Map<string, PublicKey[]>();
      if (sender && silent.size) await expireSilent(async (build) => (await sender.send(async () => [await build()])).status === "confirmed", app.program, silent);
      const fetched = await fetchWorlds(er, app.cfg.programId, me);
      if (er !== app.conns.er) return; // region switched meanwhile
      online = countsOf(fetched);
      paintOnline();
    } catch {
      /* keep the last counts */
    }
  };
  const ONLINE_EVERY_MS = 10_000;
  const onlineTimer = setInterval(() => {
    // Stop once the picker is gone (entering a world replaces the screen).
    if (!list.isConnected) return clearInterval(onlineTimer);
    if (document.visibilityState === "visible") void loadOnline();
  }, ONLINE_EVERY_MS);

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
        h(
          "span",
          { class: "world-meta" },
          e.mine ? "Yours" : `by ${short(e.world.creator)}`,
          " · ",
          `${e.world.chunkCount} chunk${e.world.chunkCount === 1 ? "" : "s"}`,
          e.status === "ready" ? " · " : null,
          e.status === "ready" ? onlineSpan(k) : null,
        ),
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
    if (e.mine && worldClosable(w)) {
      const refund = worldCloseRefund(w);
      const close = h("button", { class: "btn ghost", type: "button" }, "Close world");
      let armed = false;
      close.addEventListener("click", () => {
        // First click arms, second confirms.
        if (!armed) {
          armed = true;
          close.className = "btn warn";
          close.textContent = `Confirm: close and get ${sol(refund, 6)} SOL back`;
          return;
        }
        void busy(close, "Closing…", async () => {
          err.textContent = "";
          const msg = await closeWorld(app, e.pubkey, e.world).catch(errText);
          if (msg !== null) {
            err.textContent = msg;
            return;
          }
          selected = null;
          renderEmptySide();
          await Promise.all([load(), loadReclaim()]);
        });
      });
      actions.append(close);
    }
    side.replaceChildren(
      h("div", { class: "panel-head" }, h("h2", { tabindex: -1 }, w.name || "Unnamed")),
      h("p", { class: "muted small" }, e.mine ? "Created by you" : `Created by ${short(w.creator)}`, " · ", h("code", {}, short(e.pubkey, 6))),
      h(
        "div",
        { class: "world-facts" },
        h("div", {}, h("span", { class: "stat-label" }, "Status"), h("span", {}, STATUS_TEXT[e.status])),
        h("div", {}, h("span", { class: "stat-label" }, "Players online"), onlineSpan(e.pubkey.toBase58(), true)),
        h("div", {}, h("span", { class: "stat-label" }, "Chunks"), h("span", {}, fmt(w.chunkCount))),
        h("div", {}, h("span", { class: "stat-label" }, "Spawn"), h("span", {}, w.spawnSet ? w.spawn.join(", ") : "—")),
      ),
      paramSummary(w),
      e.mine && worldClosable(w)
        ? h("p", { class: "muted small close-note" }, "Nobody has joined this world yet: you can close it to get its rent back.")
        : "",
      err,
      actions,
    );
  };

  // ------------------------------------------------------------ reclaim panel

  const reclaimBody = h("div", { class: "reclaim-body", "aria-live": "polite" });
  let plan: WithdrawPlan | null = null;

  const myClosableWorlds = () => entries.filter((e) => e.mine && worldClosable(e.world));

  const renderReclaim = (note = "", error = "") => {
    if (!plan) return;
    const worlds = myClosableWorlds();
    const worldRefund = worlds.reduce((s, e) => s + worldCloseRefund(e.world), 0);
    const kept = plan.edited.length + plan.occupied.length;
    const chunkBtn = h("button", { class: "btn primary small", type: "button", hidden: !plan.closable.length }, `Reclaim ${sol(plan.refund, 6)} SOL`);
    const worldBtn = h("button", { class: "btn ghost small", type: "button" }, `Close ${plural(worlds.length, "world")} · ${sol(worldRefund, 6)} SOL`);
    const rows = [
      h(
        "div",
        { class: "reclaim-row" },
        h(
          "div",
          {},
          h("strong", {}, plan.closable.length ? `${plural(plan.closable.length, "unused chunk")}` : "No unused chunks"),
          h(
            "p",
            { class: "muted small" },
            plan.closable.length ? "Unedited, empty chunks you paid for. Anyone can regenerate them later." : "Every chunk you paid for is edited, occupied or a spawn.",
            kept ? ` ${plural(kept, "chunk")} ${kept === 1 ? "keeps its" : "keep their"} rent (${[plan.edited.length && `${plan.edited.length} edited`, plan.occupied.length && `${plan.occupied.length} occupied`].filter(Boolean).join(", ")}).` : "",
          ),
        ),
        chunkBtn,
      ),
    ];
    if (worlds.length)
      rows.push(
        h(
          "div",
          { class: "reclaim-row" },
          h("div", {}, h("strong", {}, plural(worlds.length, "untouched world")), h("p", { class: "muted small" }, "Nobody joined them yet. Closing deletes them for good.")),
          worldBtn,
        ),
      );
    reclaimBody.replaceChildren(...rows, h("p", { class: "muted small", role: "status" }, note), h("p", { class: "form-error", role: "alert" }, error));

    chunkBtn.addEventListener("click", () =>
      busy(chunkBtn, "Reclaiming…", async () => {
        const status = reclaimBody.querySelector<HTMLElement>("[role=status]")!;
        const r = await closeChunks(app, plan!.closable, (i, msg) => (status.textContent = `${msg} (${i + 1}/${plan!.closable.length})`));
        await Promise.all([load(), loadReclaim(false)]);
        renderReclaim(r.closed ? `Reclaimed ${plural(r.closed, "chunk")} · ${sol(r.closed * CHUNK_TOTAL_RENT, 6)} SOL.` : "", r.failed?.message ?? "");
      }),
    );
    let armed = false;
    worldBtn.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        worldBtn.className = "btn warn small";
        worldBtn.textContent = `Confirm: close ${plural(worlds.length, "world")}`;
        return;
      }
      void busy(worldBtn, "Closing…", async () => {
        const status = reclaimBody.querySelector<HTMLElement>("[role=status]")!;
        let closed = 0;
        let error = "";
        for (const [i, e] of worlds.entries()) {
          status.textContent = `Closing ${e.world.name || "Unnamed"} (${i + 1}/${worlds.length})…`;
          const msg = await closeWorld(app, e.pubkey, e.world).catch(errText);
          if (msg !== null) {
            error = `${e.world.name || "Unnamed"}: ${msg}`;
            break;
          }
          closed++;
        }
        if (selected && worlds.some((e) => e.pubkey.toBase58() === selected)) {
          selected = null;
          renderEmptySide();
        }
        await Promise.all([load(), loadReclaim(false)]);
        renderReclaim(closed ? `Closed ${plural(closed, "world")}.` : "", error);
      });
    });
  };

  /** Fetches the chunks this Player sponsors (`render`: repaint when done). */
  const loadReclaim = async (render = true) => {
    if (!plan) reclaimBody.replaceChildren(h("p", { class: "muted small", role: "status" }, "Checking the chunks you paid for…"));
    try {
      plan = await fetchWithdrawPlan(app.conns.er, app.cfg.programId, app.state.player!);
      if (render) renderReclaim();
    } catch (x) {
      reclaimBody.replaceChildren(h("p", { class: "form-error", role: "alert" }, `Couldn't check your chunks: ${errText(x)}`));
    }
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
      online = countsOf(entries);
      renderList();
      renderReclaim();
      void loadOnline();
    } catch (e) {
      listStatus.textContent = `Couldn't load worlds: ${errText(e)}`;
    }
  };
  refresh.addEventListener("click", () => busy(refresh, "Refreshing…", () => Promise.all([load(), loadReclaim()]).then(() => {})));
  search.addEventListener("input", renderList);
  createBtn.addEventListener("click", showCreate);

  root.append(
    h(
      "section",
      { class: "screen worlds", "aria-labelledby": "worlds-title" },
      h(
        "div",
        { class: "worlds-col" },
        h(
          "div",
          { class: "panel list-panel" },
          h("div", { class: "panel-head" }, h("h1", { id: "worlds-title" }, "Worlds ", h("span", { class: "region-tag", title: `Worlds on the ${region.label} rollup (${region.erRpc})` }, region.label)), refresh),
          h("label", { for: "world-search", class: "sr-only" }, "Search worlds"),
          search,
          notice ? h("p", { class: "world-notice", role: "alert" }, notice) : null,
          listStatus,
          list,
        ),
        h("section", { class: "panel reclaim-panel", "aria-labelledby": "reclaim-title" }, h("h2", { id: "reclaim-title" }, "Reclaim SOL"), reclaimBody),
      ),
      side,
    ),
  );
  renderEmptySide();
  focusHeading(root);
  if (entries.length) renderList();
  void load();
  void loadReclaim();
}

/** A stable hue per world (list swatch). */
function hue(k: string): number {
  let x = 0;
  for (let i = 0; i < k.length; i++) x = (x * 31 + k.charCodeAt(i)) >>> 0;
  return x % 360;
}
