// App entry: connect → Player (create / fund / delegate) → session → worlds → game.
// `flow()` re-derives the screen from the wallet's onchain state, so every step can be
// re-entered (reload, wallet switch, after a withdraw, after a region switch).
// The top-bar region picker selects the ER; a Player delegated to another region's
// validator gets the "your player is in <region>" screen instead of the world list.
import "./style.css";
import { playerPlacement, playerStatus } from "./chain";
import { enterGame, type GameHandle } from "./game";
import { createApp } from "./state";
import { clear, errText, h } from "./ui/dom";
import { createHud } from "./ui/hud";
import { showConnect, showPlayerSetup, showSession, tryAutoConnect, useSession } from "./ui/onboarding";
import { regionPicker, showRegionMismatch } from "./ui/region";
import { fetchWorlds } from "./ui/worldList";
import { showWorlds } from "./ui/worlds";

const root = document.getElementById("app")!;
const screen = h("main", { id: "screen", class: "main" });

function fatal(e: unknown) {
  clear(screen);
  screen.append(
    h("section", { class: "screen center" }, h("div", { class: "panel narrow" }, h("h1", {}, "Something went wrong"), h("p", { class: "form-error" }, errText(e)), h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: () => location.reload() }, "Reload")))),
  );
}

async function main() {
  const app = createApp(import.meta.env);
  let game: GameHandle | null = null;
  let running = 0;
  const hud = createHud(app, { onWithdrawn: () => void flow(), onDisconnect: () => void flow() });
  hud.el.querySelector(".brand")!.after(regionPicker(app, (id) => switchRegion(id)));
  root.replaceChildren(hud.el, screen);

  /** Tears down everything bound to the current ER (game, HUD subscription), swaps the
   *  connection / program / sender to region `id` and re-derives the screen. */
  function switchRegion(id: string) {
    if (id === app.cfg.region) return;
    game?.stop();
    game = null;
    hud.detach();
    app.setRegion(id);
    void flow();
  }

  const loading = (msg: string) => {
    clear(screen);
    screen.append(h("section", { class: "screen center" }, h("p", { class: "muted loading", role: "status" }, msg)));
  };

  async function flow(): Promise<void> {
    const run = ++running;
    game?.stop();
    game = null;
    const w = app.state.wallet;
    if (!w) {
      hud.detach();
      return showConnect(app, screen, () => void flow());
    }
    loading("Looking up your player…");
    let st;
    try {
      st = await playerStatus(app.cfg.programId, app.conns.base, app.conns.er, w.publicKey);
    } catch (e) {
      return fatal(e);
    }
    if (run !== running) return;
    if (st.state === "delegated") {
      const where = playerPlacement(app.cfg, st.validator);
      if (where.kind === "elsewhere") {
        hud.detach();
        return showRegionMismatch(app, screen, where, { switchTo: switchRegion, next: () => void flow() });
      }
    }
    if (st.state !== "delegated" || st.erLamports === null) {
      hud.detach();
      if (st.state === "delegated") {
        loading("Waiting for the rollup to pick up your player…");
        setTimeout(() => run === running && void flow(), 1000);
        return;
      }
      return showPlayerSetup(app, screen, st, () => void flow());
    }
    hud.attach();
    if (!app.state.session || app.state.sessionStale) {
      return showSession(app, screen, () => void flow());
    }
    // A region switch dropped the sender (it is bound to the old ER): rebuild it.
    if (!app.state.sender) useSession(app, app.state.session);
    showWorlds(app, screen, (world, account) => {
      game = enterGame(app, screen, world, account, () => void flow());
    });
  }

  if (!(await tryAutoConnect(app, () => void flow()))) await flow();
  // Dev handle for debugging in the console.
  if (!import.meta.env.PROD)
    Object.assign(globalThis, {
      __magicraft: app,
      // Dev-only: inspect / switch the region without a wallet.
      __magicraftDev: {
        switchRegion,
        fetchWorlds: () => fetchWorlds(app.conns.er, app.cfg.programId, app.state.wallet?.publicKey ?? null),
      },
    });
}

main().catch(fatal);
