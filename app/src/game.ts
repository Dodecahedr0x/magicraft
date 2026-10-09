// Game entry (placeholder until Tasks 24–27: chunk store + renderer, player controller,
// gameplay UI). Receives the joined world, keeps the PlayerState subscription in app state
// and shows an "entering world" overlay on a canvas.
import type { PublicKey } from "@solana/web3.js";
import { decodePlayerState, FP, pstatePda, type PlayerStateAccount, type WorldAccount } from "./chain";
import type { App } from "./state";
import { clear, focusHeading, h } from "./ui/dom";

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

  const show = (s: PlayerStateAccount) => {
    app.set({ playerState: s });
    const [x, y, z] = s.move.pos.map((v) => (v / FP).toFixed(1));
    info.textContent = `Health ${s.health}/20 · Food ${s.food}/20 · at ${x}, ${y}, ${z}`;
  };
  const apply = (data: Uint8Array) => {
    try {
      show(decodePlayerState(data));
    } catch {
      /* not created yet */
    }
  };
  void app.conns.er.getAccountInfo(pstate, "confirmed").then((i) => i && apply(i.data), () => {});
  const sub = app.conns.er.onAccountChange(pstate, (i) => apply(i.data), { commitment: "confirmed" });

  // A tiny sky/ground gradient so the canvas is not blank (the renderer replaces this).
  const ctx = canvas.getContext("2d");
  const paint = () => {
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * devicePixelRatio));
    canvas.height = Math.max(1, Math.round(r.height * devicePixelRatio));
    if (!ctx) return;
    const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
    g.addColorStop(0, "#7fb2e6");
    g.addColorStop(0.62, "#cfe3f2");
    g.addColorStop(0.62, "#5f8f3a");
    g.addColorStop(1, "#3c5a26");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };
  paint();
  window.addEventListener("resize", paint);

  const handle: GameHandle = {
    stop() {
      window.removeEventListener("resize", paint);
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
