// App entry: connect → Player (create / fund / delegate) → session → worlds → game.
// `flow()` re-derives the screen from the wallet's onchain state, so every step can be
// re-entered (reload, wallet switch, after a withdraw).
import "./style.css";
import { playerStatus } from "./chain";
import { enterGame, type GameHandle } from "./game";
import { createApp } from "./state";
import { clear, errText, h } from "./ui/dom";
import { createHud } from "./ui/hud";
import { showConnect, showPlayerSetup, showSession, tryAutoConnect } from "./ui/onboarding";
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
  root.replaceChildren(hud.el, screen);

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
    showWorlds(app, screen, (world, account) => {
      game = enterGame(app, screen, world, account, () => void flow());
    });
  }

  if (!(await tryAutoConnect(app, () => void flow()))) await flow();
  // Dev handle for debugging in the console.
  if (!import.meta.env.PROD) (globalThis as { __magicraft?: unknown }).__magicraft = app;
}

main().catch(fatal);
