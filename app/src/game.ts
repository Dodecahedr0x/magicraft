// Game entry: receives the joined world, keeps the PlayerState subscription in app state,
// and runs the world view (chunk store + renderer + auto-create, world/world.ts), the player
// (controller + move sync, player/controller.ts; needs the core wasm), the interaction
// layer (player/interact.ts: mining, placing, attacking, eating, crafting) and the HUD
// (hotbar, health/food, inventory + crafting panel on `E`, death screen, settings menu on
// Esc / pointer-lock release: chunk auto-generation, back to worlds) on the game canvas,
// plus other players (world/players.ts) and the live day / night clock (world/sky.ts).
// The "entering world" overlay stays until the first chunk mesh is on screen.
import type { PublicKey } from "@solana/web3.js";
import { decodePlayerState, FP, INVENTORY_SIZE, PSTATE_INVENTORY_OFFSET, pstatePda, type PlayerStateAccount, type V3, type WorldAccount } from "./chain";
import type { App } from "./state";
import { startPlayer, type PlayerSession } from "./player/controller";
import { Interaction, MOB_NAMES } from "./player/interact";
import { CraftingPanel } from "./ui/crafting";
import { clear, focusHeading, h, sendResultMessage } from "./ui/dom";
import { DeathScreen, HealthBars } from "./ui/health";
import { Hotbar } from "./ui/hotbar";
import { InventoryGrid } from "./ui/inventory";
import { TouchControls } from "./ui/touch";
import type { Input } from "./player/physics";
import { blockFlags, loadCore } from "./wasm";
import { PlayerLayer } from "./world/players";
import { startWorld } from "./world/world";

export type GameHandle = { stop(): void };

/** Phones and tablets (short or narrow screen, or a touch-only pointer): the top bar moves
 *  into the in-game menu. */
export const MOBILE_QUERY = "(max-height: 520px), (max-width: 640px), (pointer: coarse)";

export function enterGame(app: App, root: HTMLElement, world: PublicKey, account: WorldAccount, onLeave: (notice?: string) => void): GameHandle {
  clear(root);
  app.set({ world: { pubkey: world, account }, playerState: null });
  const pstate = pstatePda(app.cfg.programId, world, app.state.player!);
  const canvas = h("canvas", { class: "game-canvas", "aria-label": `World ${account.name}` });
  const info = h("p", { class: "muted", role: "status" }, "Loading your player…");
  const leave = h("button", { class: "btn ghost small", type: "button" }, "Back to worlds");
  const overlay = h("div", { class: "game-overlay" }, h("h1", {}, "Entering world…"), h("p", { class: "lede" }, account.name), info, leave);
  root.append(h("section", { class: "screen game", "aria-labelledby": "game-title" }, canvas, overlay));
  overlay.querySelector("h1")!.id = "game-title";
  focusHeading(root);
  const screen = root.querySelector<HTMLElement>(".screen.game")!;

  const bar = h("div", { class: "game-bar" }, h("strong", { class: "game-name" }, account.name), h("span", { class: "game-pos muted" }));
  const mineBar = h("div", { class: "mine-bar", hidden: true }, h("span", {}));
  const aim = h("div", { class: "aim-label" });
  const hud = h("div", { class: "player-hud" });
  const invPanel = h("div", { class: "inv-panel", role: "dialog", "aria-modal": "false", "aria-label": "Inventory and crafting", hidden: true });

  let stopped = false;
  let touch: TouchControls | null = null;
  let latest: { s: PlayerStateAccount; inv: Uint8Array } | null = null;
  let player: PlayerSession | null = null;
  let act: Interaction | null = null;
  let hotbar: Hotbar | null = null;
  let grid: InventoryGrid | null = null;
  let crafting: CraftingPanel | null = null;
  let others: PlayerLayer | null = null;
  const bars = new HealthBars();
  const death = new DeathScreen(async () => {
    if (!act) return false;
    const r = await act.respawn();
    return r.status === "confirmed" || (r.status === "failed" && r.error.name === "NotDead");
  });

  const paintHud = () => {
    if (!latest) return;
    const { s } = latest;
    bars.paint(s.health, s.food);
    if (act && hotbar) hotbar.paint(s.inventory, act.select.selected);
    if (act && grid && !invPanel.hidden) {
      grid.paint(s.inventory, act.select.selected);
      const st = act.stations();
      crafting?.update(latest.inv, s.inventory, { table: !!st.table, furnace: !!st.furnace });
    }
  };

  const show = (s: PlayerStateAccount) => {
    app.set({ playerState: s });
    view.onPlayerState(s);
    const [x, y, z] = s.move.pos.map((v) => (v / FP).toFixed(1));
    info.textContent = `Health ${s.health}/20 · Food ${s.food}/20 · at ${x}, ${y}, ${z}`;
    bar.querySelector(".game-pos")!.textContent = `Player at ${x}, ${y}, ${z}`;
  };
  let lastData: Uint8Array | null = null;
  const apply = (data: Uint8Array) => {
    let s: PlayerStateAccount;
    try {
      s = decodePlayerState(data);
    } catch {
      return; /* not created yet */
    }
    lastData = data;
    latest = { s, inv: data.slice(PSTATE_INVENTORY_OFFSET, PSTATE_INVENTORY_OFFSET + INVENTORY_SIZE) };
    show(s);
    player?.onPlayerState(data);
    act?.select.onPlayerState(s.heldSlot);
    if (s.health === 0) setPanel(false, false);
    death.show(s.health === 0);
    if (s.health > 0 && player) player.controller.frozen = false;
    paintHud();
  };
  const view = startWorld(app, canvas, world, account, () => {
    overlay.hidden = true;
  });
  const resume = h("button", { class: "btn primary small", type: "button" }, "Resume");
  const menuLeave = h("button", { class: "btn ghost small", type: "button" }, "Back to worlds");
  // On mobile the top bar (balance, chunks, Top up, Withdraw, wallet) is hidden in game and
  // shown inside the menu instead: the live element moves here and back (`placeTopbar`).
  const accountBox = h("div", { class: "menu-account", hidden: true });
  const menu = h(
    "div",
    { class: "game-menu", hidden: true },
    h(
      "div",
      { class: "game-menu-panel", role: "dialog", "aria-modal": "true", "aria-labelledby": "game-menu-title" },
      h("div", { class: "panel-head" }, h("h2", { id: "game-menu-title" }, "Settings"), h("span", { class: "muted small" }, "Esc to resume")),
      accountBox,
      view.settings,
      h(
        "p",
        { class: "muted small menu-note" },
        "While you're in the world, other players see you and can attack you, even with this menu open. Back to worlds takes you out: nobody can see or hit you until you return.",
      ),
      h("div", { class: "actions" }, resume, menuLeave),
    ),
  );
  screen.append(bars.flash, bar, mineBar, aim, hud, view.ui, invPanel, death.el, menu);
  const topbar = document.querySelector<HTMLElement>(".topbar");
  const topHome = topbar ? { parent: topbar.parentElement!, next: topbar.nextSibling } : null;
  const mobileQ = matchMedia(MOBILE_QUERY);
  const placeTopbar = (restore = false) => {
    if (!topbar || !topHome) return;
    const inMenu = !restore && mobileQ.matches;
    accountBox.hidden = !inMenu;
    if (inMenu && topbar.parentElement !== accountBox) accountBox.append(topbar);
    else if (!inMenu && topbar.parentElement === accountBox) topHome.parent.insertBefore(topbar, topHome.next);
  };
  const onMobileChange = () => placeTopbar();
  mobileQ.addEventListener("change", onMobileChange);
  placeTopbar();
  // The controls hint goes to the top (the hotbar owns the bottom center).
  const help = view.ui.querySelector(".fly-help");
  if (help) screen.append(help);

  /** Gameplay input is off while the inventory or the settings menu is open. */
  const syncBlocked = () => {
    const blocked = !invPanel.hidden || !menu.hidden;
    if (player) player.controller.blocked = blocked;
    if (act) act.blocked = blocked;
    if (blocked) touch?.reset(); // a held stick / button must not resume on close
  };

  // ------------------------------------------------------------ settings menu (Esc)

  let menuAt = 0;
  /** Opens / closes the menu; `relock` recaptures the mouse on a user close. */
  function setMenu(open: boolean, relock = true) {
    if (open === !menu.hidden) return;
    if (open) setPanel(false, false);
    menu.hidden = !open;
    syncBlocked();
    if (open) {
      menuAt = performance.now();
      if (document.pointerLockElement) document.exitPointerLock();
      resume.focus({ preventScroll: true });
      menu.firstElementChild!.scrollTop = 0; // open at the top (account, settings)
    } else {
      if (menu.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      if (relock && !death.shown) (canvas.requestPointerLock?.() as Promise<void> | undefined)?.catch?.(() => {});
    }
  }
  resume.addEventListener("click", () => setMenu(false));
  menu.addEventListener("click", (e) => e.target === menu && setMenu(false));
  // Esc while the mouse is captured only releases it (no keydown): open the menu then.
  const onLockChange = () => {
    if (document.pointerLockElement || stopped || !invPanel.hidden || death.shown) return;
    setMenu(true);
  };
  document.addEventListener("pointerlockchange", onLockChange);

  // ------------------------------------------------------------ inventory panel (E)

  /** Opens / closes the panel; `relock` recaptures the mouse on a user close. */
  function setPanel(open: boolean, relock = true) {
    if (!act || !player || open === !invPanel.hidden) return;
    if (open && (death.shown || !menu.hidden)) return;
    invPanel.hidden = !open;
    syncBlocked();
    if (open) {
      if (document.pointerLockElement) document.exitPointerLock();
      paintHud();
      // Focus into the dialog (first craft button, else Close).
      (invPanel.querySelector<HTMLElement>(".craft-go .btn:not(.ghost):not(:disabled)") ?? invPanel.querySelector<HTMLElement>(".inv-head .btn"))?.focus();
    } else {
      if (invPanel.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      if (relock) (canvas.requestPointerLock?.() as Promise<void> | undefined)?.catch?.(() => {});
    }
  }
  const typing = (e: Event) => e.target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable);
  const onKey = (e: KeyboardEvent) => {
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (e.code === "KeyE") setPanel(invPanel.hidden);
    else if (e.code === "Escape") {
      if (!invPanel.hidden) setPanel(false, false);
      // Skip the keydown that some browsers also send with the lock release.
      else if (performance.now() - menuAt > 250) setMenu(menu.hidden);
    }
  };
  window.addEventListener("keydown", onKey);
  // Stations come and go as the player moves: refresh the open panel.
  const panelTimer = setInterval(() => !invPanel.hidden && paintHud(), 500);

  // ------------------------------------------------------------ player + interaction

  loadCore().then(
    () => {
      if (stopped) return;
      player = startPlayer(app, view, world, account, canvas, {
        onDead: () => {
          setPanel(false, false);
          death.show(true);
        },
        onIssue: (f) => view.toast(sendResultMessage({ status: "failed", error: f }, "Move") ?? f.message, "warn"),
        onKicked: () => kick(),
      });
      const session = player;
      act = new Interaction({
        app,
        view,
        session,
        world,
        account,
        flags: blockFlags(),
        state: () => latest,
        ui: {
          toast: (m, k) => view.toast(m, k),
          progress: (f) => {
            mineBar.hidden = f === null;
            if (f !== null) (mineBar.firstElementChild as HTMLElement).style.width = `${Math.round(f * 100)}%`;
          },
          target: (label) => (aim.textContent = label ?? ""),
          onDead: () => {
            setPanel(false, false);
            death.show(true);
          },
        },
      });
      const a = act;
      // Day / night from the live World + chain clock; other players from the presence lists.
      view.sky.source = { world: () => session.world(), now: () => session.clock.now() };
      const ps = new PlayerLayer(view.renderer, { lists: () => a.presence.lists(), self: app.state.player?.toBase58() ?? null, now: () => session.clock.now() });
      others = ps;
      view.onFrame((dt) => ps.update(dt));
      a.players = () => [...ps.tracker.players.values()].filter((t) => t.goneAt === null).map((t) => ({ key: t.key, pos: t.motion.at(performance.now(), [0, 0, 0]) }));
      a.select.onChange = () => paintHud();
      hotbar = new Hotbar(
        (i) => a.select.select(i),
        () => a.select.selected,
        () => !death.shown && invPanel.hidden && menu.hidden,
      );
      grid = new InventoryGrid((i) => a.select.select(i));
      crafting = new CraftingPanel(async (recipe, count) => (await a.craft(recipe, count)).status === "confirmed");
      invPanel.append(
        h("div", { class: "inv-head" }, h("span", { class: "muted" }, "E or Esc to close"), h("button", { class: "btn tiny ghost", type: "button", onclick: () => setPanel(false) }, "Close")),
        h("div", { class: "inv-body" }, grid.el, crafting.el),
      );
      hud.append(bars.el, hotbar.el);
      // Touch screens: joystick, drag to look, action buttons (ui/touch.ts).
      let stick: Partial<Input> = {};
      let jump = false;
      const pushTouch = () => (session.controller.touch = { ...stick, jump });
      touch = new TouchControls(screen, {
        move: (i) => ((stick = i), pushTouch()),
        look: (dy, dp) => session.controller.look(session.controller.yaw + dy, session.controller.pitch + dp),
        button: (b, down) => a.setButton(b, down),
        jump: (down) => ((jump = down), pushTouch()),
        inventory: () => setPanel(invPanel.hidden, false),
        menu: () => setMenu(true, false),
        blocked: () => death.shown || !invPanel.hidden || !menu.hidden,
      });
      screen.append(touch.el);
      view.onFrame(() => a.update());
      syncBlocked();
      if (latest) a.select.onPlayerState(latest.s.heldSlot);
      if (lastData) session.onPlayerState(lastData);
      paintHud();

      const g = globalThis as { __magicraft?: Record<string, Record<string, unknown> | undefined> };
      const dbg = g.__magicraft?.player;
      if (!import.meta.env.PROD && dbg)
        Object.assign(dbg, {
          interact: a,
          /** Holds a virtual mouse button for `ms` (no pointer lock needed). */
          click: (button: "left" | "right", ms = 100) => a.click(button, ms),
          select: (slot: number) => a.select.select(slot),
          craft: (recipe: number, count = 1) => a.craft(recipe, count),
          respawn: () => a.respawn(),
          inventory: (open?: boolean) => setPanel(open ?? invPanel.hidden),
          target: () => {
            const t = a.target;
            if (!t) return null;
            if (t.kind === "block") return { kind: "block", block: t.hit.block, face: t.hit.face, id: t.hit.id, inReach: t.inReach };
            if (t.kind === "player") return { kind: "player", player: t.key, chunk: [t.cx, t.cz], inReach: t.inReach };
            return { kind: MOB_NAMES[t.mob.kind], mob: t.mob, inReach: t.inReach };
          },
          mobs: () => {
            const p = session.sync.prevState?.pos;
            return a.mobs
              .all()
              .map((m) => ({ ...m, name: MOB_NAMES[m.kind], at: m.pos.map((v) => +(v / FP).toFixed(2)), dist: p ? +(Math.hypot(...m.pos.map((v, i) => v - p[i])) / FP).toFixed(2) : null }))
              .sort((x, y) => (x.dist ?? 0) - (y.dist ?? 0));
          },
          /** Points the camera at world point (x, y, z) (block units). */
          aim: (x: number, y: number, z: number) => {
            const c = view.renderer.camera.position;
            const [dx, dy, dz] = [x - c.x, y - c.y, z - c.z];
            session.controller.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
          },
          stations: () => a.stations(),
          others: () => [...ps.tracker.players.values()].map((t) => ({ key: t.key, at: t.motion.to, alpha: +ps.tracker.alpha(t, performance.now()).toFixed(2) })),
          held: () => ({ selected: a.select.selected, chainHeld: a.select.chainHeld }),
          stats2: () => ({ ...a.stats, localEdits: view.store.localEdits, move: session.sync.summary() }),
          feetBlock: (): V3 | null => {
            const p = session.sync.prevState?.pos;
            return p ? (p.map((v) => Math.floor(v / FP)) as V3) : null;
          },
        });
    },
    (e) => {
      console.error("core wasm failed to load", e);
      info.textContent = "Could not load the game engine (wasm). Reload to retry.";
    },
  );
  void app.conns.er.getAccountInfo(pstate, "confirmed").then((i) => i && apply(i.data), () => {});
  const sub = app.conns.er.onAccountChange(pstate, (i) => apply(i.data), { commitment: "confirmed" });

  const handle: GameHandle = {
    stop() {
      stopped = true;
      clearInterval(panelTimer);
      window.removeEventListener("keydown", onKey);
      mobileQ.removeEventListener("change", onMobileChange);
      placeTopbar(true);
      document.removeEventListener("pointerlockchange", onLockChange);
      hotbar?.dispose();
      touch?.dispose();
      act?.dispose();
      others?.dispose();
      player?.stop();
      view.stop();
      void app.conns.er.removeAccountChangeListener(sub).catch(() => {});
      app.set({ world: null, playerState: null });
    },
  };
  let leaving = false;
  /** Out of the world: stop moving, take our presence entry out (`leave_world`, so nobody
   *  sees or hits us from now on; bounded wait, a stale entry stops counting after 5 s
   *  anyway), then stop. Before the engine loaded there is no entry to remove. */
  const leaveGame = async () => {
    if (leaving) return;
    leaving = true;
    for (const b of [leave, menuLeave]) {
      b.disabled = true;
      b.textContent = "Leaving…";
    }
    player?.sync.stop();
    if (act && !death.shown) await act.leaveWorld().catch(() => false);
    handle.stop();
    onLeave();
  };
  /** Counted out of the world onchain (no move for a minute: a frozen or sleeping tab, a
   *  lost connection; or "Back to worlds" from another tab): out, back to the world list. */
  const kick = () => {
    if (leaving) return;
    leaving = true;
    handle.stop();
    onLeave("You were away for over a minute and left the world. Resume to go back in.");
  };
  leave.addEventListener("click", () => void leaveGame());
  menuLeave.addEventListener("click", () => void leaveGame());
  return handle;
}
