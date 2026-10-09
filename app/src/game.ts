// Game entry: receives the joined world, keeps the PlayerState subscription in app state,
// and runs the world view (chunk store + renderer + auto-create, world/world.ts), the player
// (controller + move sync, player/controller.ts; needs the core wasm), the interaction
// layer (player/interact.ts: mining, placing, attacking, eating, crafting) and the HUD
// (hotbar, health/food, inventory + crafting panel on `E`, death screen) on the game canvas.
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
import { blockFlags, loadCore } from "./wasm";
import { startWorld } from "./world/world";

export type GameHandle = { stop(): void };

export function enterGame(app: App, root: HTMLElement, world: PublicKey, account: WorldAccount, onLeave: () => void): GameHandle {
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

  let latest: { s: PlayerStateAccount; inv: Uint8Array } | null = null;
  let player: PlayerSession | null = null;
  let act: Interaction | null = null;
  let hotbar: Hotbar | null = null;
  let grid: InventoryGrid | null = null;
  let crafting: CraftingPanel | null = null;
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
    death.show(s.health === 0);
    if (s.health > 0 && player) player.controller.frozen = false;
    paintHud();
  };
  const view = startWorld(app, canvas, world, account, () => {
    overlay.hidden = true;
    bar.append(leave);
  });
  screen.append(bars.flash, bar, mineBar, aim, hud, view.ui, invPanel, death.el);
  // The controls hint goes to the top (the hotbar owns the bottom center).
  const help = view.ui.querySelector(".fly-help");
  if (help) screen.append(help);

  // ------------------------------------------------------------ inventory panel (E)

  const setPanel = (open: boolean) => {
    if (!act || !player || open === !invPanel.hidden) return;
    if (open && death.shown) return;
    invPanel.hidden = !open;
    player.controller.blocked = open;
    act.blocked = open;
    if (open) {
      if (document.pointerLockElement) document.exitPointerLock();
      paintHud();
    } else {
      (canvas.requestPointerLock?.() as Promise<void> | undefined)?.catch?.(() => {});
    }
  };
  const typing = (e: Event) => e.target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable);
  const onKey = (e: KeyboardEvent) => {
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (e.code === "KeyE") setPanel(invPanel.hidden);
    else if (e.code === "Escape" && !invPanel.hidden) setPanel(false);
  };
  window.addEventListener("keydown", onKey);
  // Stations come and go as the player moves: refresh the open panel.
  const panelTimer = setInterval(() => !invPanel.hidden && paintHud(), 500);

  // ------------------------------------------------------------ player + interaction

  let stopped = false;
  loadCore().then(
    () => {
      if (stopped) return;
      player = startPlayer(app, view, world, account, canvas, {
        onDead: () => death.show(true),
        onIssue: (f) => view.toast(sendResultMessage({ status: "failed", error: f }, "Move") ?? f.message, "warn"),
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
          onDead: () => death.show(true),
        },
      });
      const a = act;
      a.select.onChange = () => paintHud();
      hotbar = new Hotbar(
        (i) => a.select.select(i),
        () => a.select.selected,
        () => !death.shown && invPanel.hidden,
      );
      grid = new InventoryGrid((i) => a.select.select(i));
      crafting = new CraftingPanel(async (recipe, count) => (await a.craft(recipe, count)).status === "confirmed");
      invPanel.append(
        h("div", { class: "inv-head" }, h("span", { class: "muted" }, "E or Esc to close"), h("button", { class: "btn tiny ghost", type: "button", onclick: () => setPanel(false) }, "Close")),
        h("div", { class: "inv-body" }, grid.el, crafting.el),
      );
      hud.append(bars.el, hotbar.el);
      view.onFrame(() => a.update());
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
            return t.kind === "block" ? { kind: "block", block: t.hit.block, face: t.hit.face, id: t.hit.id, inReach: t.inReach } : { kind: MOB_NAMES[t.mob.kind], mob: t.mob, inReach: t.inReach };
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
      hotbar?.dispose();
      act?.dispose();
      player?.stop();
      view.stop();
      void app.conns.er.removeAccountChangeListener(sub).catch(() => {});
      app.set({ world: null, playerState: null });
    },
  };
  leave.addEventListener("click", () => {
    handle.stop();
    onLeave();
  });
  return handle;
}
