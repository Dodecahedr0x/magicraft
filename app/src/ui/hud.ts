// HUD shell (top bar): wallet, the Player's ER balance (subscribed) and open chunks, Top up
// and Withdraw. Withdraw is never blocked: it lists the sponsored chunks, offers to close
// the reclaimable ones first, then `withdraw` (ER, wallet-signed) → base settlement →
// `withdraw_base`.
import { LAMPORTS_PER_SOL, SystemProgram, type PublicKey } from "@solana/web3.js";
import {
  CHUNK_TOTAL_RENT,
  PLAYER_LEN,
  TOPUP_SETUP_LAMPORTS,
  accountKind,
  closeChunkIx,
  decodePlayer,
  eSplRentPda,
  fetchChunkView,
  NBR_OFF,
  sessionAuth,
  topUpIx,
  walletTx,
  withdrawBaseIx,
  withdrawIx,
} from "../chain";
import type { App } from "../state";
import { isLocalRpc, sendWithWallet } from "../wallet";
import { announce, busy, clear, errText, h, short, sleep, sol } from "./dom";
import { parseSol, chunksFor, renewSession, forgetWallet } from "./onboarding";
import { fetchWithdrawPlan, type SponsoredChunk, type WithdrawPlan } from "./withdrawPlan";

export type Hud = {
  el: HTMLElement;
  /** Starts the Player balance subscription (after delegation). */
  attach(): void;
  /** Stops subscriptions (wallet switch / withdraw). */
  detach(): void;
  /** Current ER balance (null until known). */
  balance(): number | null;
};

/** Called by the HUD after a withdraw / disconnect: the app re-runs its flow. */
export type HudEvents = { onWithdrawn(): void; onDisconnect(): void };

export function createHud(app: App, ev: HudEvents): Hud {
  let subId: number | null = null;
  let lamports: number | null = null;
  let openChunks: number | null = null;

  const balEl = h("output", { class: "stat-value", "aria-live": "off" }, "—");
  const chunksEl = h("output", { class: "stat-value" }, "—");
  const walletEl = h("span", { class: "wallet-chip-name" });
  const topUpBtn = h("button", { class: "btn small", type: "button", disabled: true }, "Top up");
  const withdrawBtn = h("button", { class: "btn small ghost", type: "button", disabled: true }, "Withdraw");
  const discBtn = h("button", { class: "btn small ghost", type: "button", title: "Disconnect wallet" }, "Disconnect");
  const renew = h("button", { class: "btn small warn", type: "button" }, "Renew session");
  const banner = h("div", { class: "banner", role: "alert", hidden: true }, h("span", {}, "Your play session expired."), renew);

  const stats = h(
    "div",
    { class: "hud-stats", hidden: true },
    h("div", { class: "stat" }, h("span", { class: "stat-label" }, "Player balance"), h("span", { class: "stat-row" }, balEl, h("span", { class: "stat-unit" }, "SOL"))),
    h("div", { class: "stat" }, h("span", { class: "stat-label" }, "Open chunks"), chunksEl),
    topUpBtn,
    withdrawBtn,
  );
  const el = h(
    "header",
    { class: "topbar" },
    h("div", { class: "brand" }, h("span", { class: "brand-mark", "aria-hidden": "true" }), "Magicraft"),
    stats,
    h("div", { class: "wallet-chip", hidden: true }, walletEl, discBtn),
    banner,
  );

  const paint = () => {
    const w = app.state.wallet;
    (el.querySelector(".wallet-chip") as HTMLElement).hidden = !w;
    walletEl.textContent = w ? `${w.name} · ${short(w.publicKey)}` : "";
    balEl.textContent = lamports === null ? "—" : sol(lamports);
    chunksEl.textContent = openChunks === null ? "—" : String(openChunks);
    const low = lamports !== null && lamports < CHUNK_TOTAL_RENT * 2;
    balEl.classList.toggle("low", low);
    balEl.title = lamports === null ? "" : `≈ ${chunksFor(lamports)} more chunks`;
    banner.hidden = !app.state.sessionStale;
  };
  app.on(paint);

  const apply = (data: Uint8Array, l: number) => {
    lamports = l;
    if (accountKind(data) === "player" && data.length >= PLAYER_LEN) openChunks = decodePlayer(data).openChunks;
    paint();
  };

  const hud: Hud = {
    el,
    attach() {
      const player = app.state.player;
      if (!player || subId !== null) return;
      stats.hidden = false;
      topUpBtn.disabled = withdrawBtn.disabled = false;
      void app.conns.er.getAccountInfo(player, "confirmed").then((i) => i && apply(i.data, i.lamports), () => {});
      subId = app.conns.er.onAccountChange(player, (i) => apply(i.data, i.lamports), { commitment: "confirmed" });
    },
    detach() {
      if (subId !== null) void app.conns.er.removeAccountChangeListener(subId).catch(() => {});
      subId = null;
      lamports = openChunks = null;
      stats.hidden = true;
      topUpBtn.disabled = withdrawBtn.disabled = true;
      paint();
    },
    balance: () => lamports,
  };

  topUpBtn.addEventListener("click", () => openTopUp(app));
  withdrawBtn.addEventListener("click", () => openWithdraw(app, openChunks, () => {
    hud.detach();
    ev.onWithdrawn();
  }));
  discBtn.addEventListener("click", async () => {
    hud.detach();
    forgetWallet(app);
    await app.state.wallet?.disconnect().catch(() => {});
    app.set({ wallet: null, player: null, session: null, sender: null, world: null, sessionStale: false });
    ev.onDisconnect();
  });
  renew.addEventListener("click", () =>
    busy(renew, "Waiting for the wallet…", async () => {
      try {
        await renewSession(app);
        announce("Session renewed.");
      } catch (e) {
        announce(errText(e));
      }
    }),
  );
  paint();
  return hud;
}

// ---------------------------------------------------------------- dialogs

function dialog(title: string, ...body: (Node | string)[]): { dlg: HTMLDialogElement; body: HTMLElement; close: () => void } {
  const content = h("div", { class: "dialog-body" }, ...body);
  const x = h("button", { class: "icon-btn", type: "button", "aria-label": "Close" }, "×");
  const dlg = h("dialog", { class: "dialog", "aria-labelledby": "dlg-title" }, h("div", { class: "dialog-head" }, h("h2", { id: "dlg-title" }, title), x), content);
  const close = () => {
    dlg.close();
    dlg.remove();
  };
  x.addEventListener("click", close);
  dlg.addEventListener("cancel", (e) => {
    if (dlg.dataset.busy) e.preventDefault();
  });
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, body: content, close };
}

/** Top-up: e-SPL `lamportsDelegatedTransferIx` (base tx, credited on the ER in ~100 ms). */
export function openTopUp(app: App) {
  const wallet = app.state.wallet!;
  const player = app.state.player!;
  const input = h("input", { id: "topup-amount", class: "input", inputmode: "decimal", value: "0.05", autocomplete: "off", "aria-describedby": "topup-cost topup-err" });
  const cost = h("p", { id: "topup-cost", class: "hint" });
  const err = h("p", { id: "topup-err", class: "form-error", role: "alert" });
  const go = h("button", { class: "btn primary", type: "submit" }, "Top up");
  const update = () => {
    const r = parseSol(input.value, 0.001);
    if ("error" in r) {
      err.textContent = r.error;
      cost.textContent = "";
      input.setAttribute("aria-invalid", "true");
      return null;
    }
    err.textContent = "";
    input.removeAttribute("aria-invalid");
    cost.replaceChildren(
      `Your wallet pays ${sol(r.lamports + TOPUP_SETUP_LAMPORTS)} SOL + network fee: `,
      h("strong", {}, `${sol(r.lamports)} SOL`),
      ` to the player and a ${sol(TOPUP_SETUP_LAMPORTS)} SOL setup charge for the transfer. Covers ≈ ${chunksFor(r.lamports)} chunks.`,
    );
    return r.lamports;
  };
  input.addEventListener("input", update);
  update();
  const form = h(
    "form",
    { novalidate: true },
    h("p", {}, "Adds SOL to your player on the rollup without leaving the game. It arrives in about a second."),
    h("label", { for: "topup-amount", class: "label" }, "Amount"),
    h("div", { class: "input-wrap" }, input, h("span", { class: "suffix" }, "SOL")),
    cost,
    err,
    h("div", { class: "actions" }, go),
  );
  const d = dialog("Top up player", form);
  input.focus();
  input.select();
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const lamports = update();
    if (lamports === null) return;
    d.dlg.dataset.busy = "1";
    void busy(go, "Waiting for the wallet…", async () => {
      try {
        const before = (await app.conns.er.getBalance(player, "confirmed")) ?? 0;
        const ixs = [];
        // The local stack's e-SPL rent PDA is not pre-funded (MagicBlock clusters' is).
        if (isLocalRpc(app.cfg.baseRpc)) {
          const rent = await eSplRentPda();
          if (((await app.conns.base.getAccountInfo(rent))?.lamports ?? 0) < 0.1 * LAMPORTS_PER_SOL)
            ixs.push(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: rent, lamports: LAMPORTS_PER_SOL }));
        }
        ixs.push(await topUpIx(wallet.publicKey, player, lamports));
        await sendWithWallet(wallet, app.conns.base, await walletTx(app.conns.base, wallet.publicKey, ixs), { viaWallet: true });
        go.textContent = "Waiting for the rollup…";
        const t0 = Date.now();
        while (Date.now() - t0 < 20_000) {
          if ((await app.conns.er.getBalance(player, "confirmed")) >= before + lamports) break;
          await sleep(100);
        }
        announce(`Topped up ${sol(lamports)} SOL.`);
        delete d.dlg.dataset.busy;
        d.close();
      } catch (e) {
        err.textContent = errText(e);
      } finally {
        delete d.dlg.dataset.busy;
      }
    });
  });
}

const chunkLabel = (c: SponsoredChunk) => `(${c.cx}, ${c.cz}) in ${short(c.world)}`;

/** Closes the plan's closable chunks one by one (session-signed); returns how many closed. */
async function closeChunks(app: App, chunks: SponsoredChunk[], progress: (i: number, msg: string) => void): Promise<number> {
  const { sender, session, player } = app.state;
  if (!sender || !session || !player) throw new Error("Start a session first.");
  const auth = sessionAuth(session, player);
  let closed = 0;
  for (const [i, c] of chunks.entries()) {
    progress(i, `Closing ${chunkLabel(c)}…`);
    const view = await fetchChunkView(app.conns.er, app.cfg.programId, c.world, NBR_OFF.map(([dx, dz]) => [c.cx + dx, c.cz + dz]));
    const r = await sender.send(async () => [await closeChunkIx(app.program, auth, c.world, c.cx, c.cz, view)]);
    if (r.status === "confirmed") closed++;
    else if (r.status === "failed") progress(i, `${chunkLabel(c)}: ${r.error.name ?? r.error.message}`);
  }
  return closed;
}

/** `withdraw_base` of everything above the Player's rent-exempt minimum; returns lamports. */
export async function withdrawBaseFlow(app: App): Promise<number> {
  const { wallet, player } = app.state;
  const base = app.conns.base;
  const info = await base.getAccountInfo(player!, "confirmed");
  if (!info) throw new Error("No player account on the base layer.");
  const keep = await base.getMinimumBalanceForRentExemption(info.data.length);
  const amount = info.lamports - keep;
  if (amount <= 0) return 0;
  await sendWithWallet(wallet!, base, await walletTx(base, wallet!.publicKey, [await withdrawBaseIx(app.program, wallet!.publicKey, amount)]), { viaWallet: true });
  return amount;
}

/** Waits until the Player is owned by our program on base again (commit + undelegation). */
async function waitSettled(app: App, player: PublicKey, tick: (s: number) => void, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const i = await app.conns.base.getAccountInfo(player, "confirmed");
    if (i?.owner.equals(app.cfg.programId)) return;
    tick(Math.round((Date.now() - t0) / 1000));
    await sleep(500);
  }
  throw new Error("The rollup hasn't settled your player on the base layer yet. It will; reopen Withdraw in a minute to finish.");
}

function planSummary(plan: WithdrawPlan, openChunks: number | null): HTMLElement {
  const li = (n: number, text: string, cls: string) => (n ? h("li", { class: cls }, h("strong", {}, String(n)), " ", text) : null);
  return h(
    "div",
    { class: "plan" },
    h("p", {}, `Your player sponsors ${openChunks ?? plan.closable.length + plan.edited.length + plan.occupied.length} open chunk${openChunks === 1 ? "" : "s"}.`),
    h(
      "ul",
      { class: "plan-list" },
      li(plan.closable.length, `untouched and empty: closing ${plan.closable.length === 1 ? "it" : "them"} refunds ${sol(plan.refund, 5)} SOL now.`, "ok"),
      li(plan.edited.length, "edited: their rent stays locked for good (the world keeps your changes).", "locked"),
      li(plan.occupied.length, "untouched but with someone listed inside: can't be closed right now.", "warn"),
    ),
    plan.closable.length || plan.occupied.length
      ? h("p", { class: "muted small" }, "Untouched chunks you leave open keep their rent on the rollup; you can only reclaim it after delegating your player again.")
      : null,
  );
}

/** Withdraw dialog: plan → (close chunks) → withdraw → settlement → withdraw_base. */
export function openWithdraw(app: App, openChunks: number | null, done: () => void) {
  const status = h("p", { class: "muted", role: "status" }, "Looking up the chunks your player sponsors…");
  const err = h("p", { class: "form-error", role: "alert" });
  const actions = h("div", { class: "actions" });
  const d = dialog("Withdraw", status, err, actions);
  const wallet = app.state.wallet!;
  const player = app.state.player!;

  const withdraw = async (closeFirst: WithdrawPlan["closable"]) => {
    d.dlg.dataset.busy = "1";
    clear(actions);
    err.textContent = "";
    try {
      if (closeFirst.length) {
        const n = await closeChunks(app, closeFirst, (i, msg) => (status.textContent = `${msg} (${i + 1}/${closeFirst.length})`));
        status.textContent = `Closed ${n} of ${closeFirst.length} chunks.`;
      }
      status.textContent = "Approve the withdraw in your wallet…";
      const er = app.conns.er;
      const tx = await walletTx(er, wallet.publicKey, [await withdrawIx(app.program, wallet.publicKey)]);
      await sendWithWallet(wallet, er, tx, { skipPreflight: true, timeoutMs: 30_000 });
      await waitSettled(app, player, (s) => (status.textContent = `Settling on the base layer… ${s}s (the first settlement on a fresh rollup can take ~10 s)`));
      status.textContent = "Approve the transfer to your wallet…";
      const got = await withdrawBaseFlow(app);
      status.textContent = `Done. ${sol(got, 6)} SOL is back in your wallet.`;
      announce(status.textContent);
      delete d.dlg.dataset.busy;
      const ok = h("button", { class: "btn primary", type: "button" }, "Close");
      ok.addEventListener("click", () => {
        d.close();
        done();
      });
      actions.append(ok);
      d.dlg.addEventListener("close", done, { once: true });
      ok.focus();
    } catch (e) {
      delete d.dlg.dataset.busy;
      err.textContent = errText(e);
      const retry = h("button", { class: "btn", type: "button" }, "Try again");
      retry.addEventListener("click", () => void withdraw([]));
      actions.append(retry);
    }
  };

  void fetchWithdrawPlan(app.conns.er, app.cfg.programId, player).then(
    (plan) => {
      status.before(planSummary(plan, openChunks));
      status.textContent = "";
      if (plan.closable.length) {
        const a = h("button", { class: "btn primary", type: "button" }, `Close ${plan.closable.length} and withdraw`);
        a.addEventListener("click", () => void withdraw(plan.closable));
        actions.append(a);
      }
      const b = h("button", { class: `btn${plan.closable.length ? " ghost" : " primary"}`, type: "button" }, plan.closable.length ? "Withdraw without closing" : "Withdraw everything");
      b.addEventListener("click", () => void withdraw([]));
      actions.append(b);
      (actions.firstElementChild as HTMLElement | null)?.focus();
    },
    (e) => {
      status.textContent = "";
      err.textContent = `Couldn't list your chunks (${errText(e)}). You can still withdraw.`;
      const b = h("button", { class: "btn primary", type: "button" }, "Withdraw anyway");
      b.addEventListener("click", () => void withdraw([]));
      actions.append(b);
    },
  );
}
