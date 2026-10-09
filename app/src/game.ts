// Game entry: receives the joined world, keeps the PlayerState subscription in app state,
// and runs the world view (chunk store + renderer + auto-create, world/world.ts) on the
// game canvas. The "entering world" overlay stays until the first chunk mesh is on screen.
// (Player controller and gameplay UI: Tasks 25–27.)
import type { PublicKey } from "@solana/web3.js";
import { decodePlayerState, FP, pstatePda, type PlayerStateAccount, type WorldAccount } from "./chain";
import type { App } from "./state";
import { clear, focusHeading, h } from "./ui/dom";
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

  const bar = h("div", { class: "game-bar" }, h("strong", { class: "game-name" }, account.name), h("span", { class: "game-pos muted" }));
  const show = (s: PlayerStateAccount) => {
    app.set({ playerState: s });
    view.onPlayerState(s);
    const [x, y, z] = s.move.pos.map((v) => (v / FP).toFixed(1));
    info.textContent = `Health ${s.health}/20 · Food ${s.food}/20 · at ${x}, ${y}, ${z}`;
    bar.querySelector(".game-pos")!.textContent = `Player at ${x}, ${y}, ${z}`;
  };
  const apply = (data: Uint8Array) => {
    try {
      show(decodePlayerState(data));
    } catch {
      /* not created yet */
    }
  };
  const view = startWorld(app, canvas, world, account, () => {
    overlay.hidden = true;
    bar.append(leave);
  });
  root.querySelector(".screen.game")!.append(bar, view.ui);
  void app.conns.er.getAccountInfo(pstate, "confirmed").then((i) => i && apply(i.data), () => {});
  const sub = app.conns.er.onAccountChange(pstate, (i) => apply(i.data), { commitment: "confirmed" });

  const handle: GameHandle = {
    stop() {
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
