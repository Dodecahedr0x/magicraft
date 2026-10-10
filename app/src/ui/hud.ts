// HUD shell (top bar): wallet, the Player's ER balance (subscribed) and open chunks, Top up
// and Withdraw. Withdraw is never blocked: it lists the sponsored chunks, offers to close
// the reclaimable ones first, then `withdraw` (ER, wallet-signed) → base settlement →
// `withdraw_base`.
import { LAMPORTS_PER_SOL, SystemProgram, type Connection, type PublicKey } from "@solana/web3.js";
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
import { announce, busy, clear, errText, h, sendResultMessage, short, sleep, sol } from "./dom";
import { parseSol, chunksFor, renewSession, forgetWallet, releaseWallet } from "./onboarding";
import { fetchWithdrawPlan, withdrawPhase, type SponsoredChunk, type WithdrawPhase, type WithdrawPlan } from "./withdrawPlan";

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
    releaseWallet();
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

type Dialog = { dlg: HTMLDialogElement; body: HTMLElement; close: () => void; setBusy: (b: boolean) => void };

function dialog(title: string, ...body: (Node | string)[]): Dialog {
  const content = h("div", { class: "dialog-body" }, ...body);
  const x = h("button", { class: "icon-btn", type: "button", "aria-label": "Close" }, "×");
  const dlg = h("dialog", { class: "dialog", "aria-labelledby": "dlg-title" }, h("div", { class: "dialog-head" }, h("h2", { id: "dlg-title" }, title), x), content);
  let busyNow = false;
  const close = () => {
    if (dlg.open) dlg.close();
  };
  x.addEventListener("click", close);
  dlg.addEventListener("cancel", (e) => {
    if (busyNow) e.preventDefault();
  });
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return {
    dlg,
    body: content,
    close,
    setBusy(b) {
      busyNow = b;
      x.disabled = b;
    },
  };
}

/** Shown before a wallet signs a tx that runs on the rollup: wallets simulate it against
 *  the base layer, where it would fail, and may say so. */
const ER_SIGN_NOTE =
  "Your wallet may warn that this transaction could fail: it checks it against the base layer, but it runs on the rollup. That warning is expected.";

/** Top-up: e-SPL `lamportsDelegatedTransferIx` (base tx, credited on the ER in ~100 ms). */
export function openTopUp(app: App) {
  const wallet = app.state.wallet!;
  const player = app.state.player!;
  const input = h("input", { id: "topup-amount", class: "input", inputmode: "decimal", value: "0.05", autocomplete: "off", "aria-describedby": "topup-cost topup-err" });
  const cost = h("p", { id: "topup-cost", class: "hint" });
  const err = h("p", { id: "topup-err", class: "form-error", role: "alert" });
  const status = h("p", { class: "muted", role: "status" });
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
  const actions = h("div", { class: "actions" }, go);
  const form = h(
    "form",
    { novalidate: true },
    h("p", {}, "Adds SOL to your player on the rollup without leaving the game. It arrives in about a second."),
    h("label", { for: "topup-amount", class: "label" }, "Amount"),
    h("div", { class: "input-wrap" }, input, h("span", { class: "suffix" }, "SOL")),
    cost,
    err,
    status,
    actions,
  );
  const d = dialog("Top up player", form);
  input.focus();
  input.select();
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const lamports = update();
    if (lamports === null) return;
    d.setBusy(true);
    void busy(go, "Waiting for the wallet…", async () => {
      try {
        const before = await app.conns.er.getBalance(player, "confirmed");
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
        let credited = false;
        while (!credited && Date.now() - t0 < 20_000) {
          credited = (await app.conns.er.getBalance(player, "confirmed")) >= before + lamports;
          if (!credited) await sleep(100);
        }
        if (credited) {
          announce(`Topped up ${sol(lamports)} SOL.`);
          d.setBusy(false);
          d.close();
          return;
        }
        // Paid on base but not visible on the rollup yet: report it as pending.
        status.textContent = `Sent: ${sol(lamports)} SOL is paid but the rollup hasn't credited it yet. It should appear in your player balance shortly.`;
        announce(status.textContent);
        const ok = h("button", { class: "btn", type: "button" }, "Close");
        ok.addEventListener("click", d.close);
        actions.replaceChildren(ok);
        ok.focus();
      } catch (e) {
        err.textContent = errText(e);
      } finally {
        d.setBusy(false);
      }
    });
  });
}

const chunkLabel = (c: SponsoredChunk) => `(${c.cx}, ${c.cz}) in ${short(c.world)}`;

type CloseResult = { closed: number; failed: null | { chunk: SponsoredChunk; message: string; session: boolean } };

/** Closes the plan's closable chunks one by one (session-signed); stops at the first
 *  failure. */
async function closeChunks(app: App, chunks: SponsoredChunk[], progress: (i: number, msg: string) => void): Promise<CloseResult> {
  const { sender, session, player } = app.state;
  if (!sender || !session || !player) return { closed: 0, failed: { chunk: chunks[0], message: "No play session.", session: true } };
  const auth = sessionAuth(session, player);
  let closed = 0;
  for (const [i, c] of chunks.entries()) {
    progress(i, `Closing ${chunkLabel(c)}…`);
    const view = await fetchChunkView(app.conns.er, app.cfg.programId, c.world, NBR_OFF.map(([dx, dz]) => [c.cx + dx, c.cz + dz]));
    const r = await sender.send(async () => [await closeChunkIx(app.program, auth, c.world, c.cx, c.cz, view)]);
    const msg = sendResultMessage(r, `Closing ${chunkLabel(c)}`);
    if (msg !== null) return { closed, failed: { chunk: c, message: msg, session: r.status === "failed" && r.error.kind === "renewSession" } };
    closed++;
  }
  return { closed, failed: null };
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
export async function waitSettled(app: App, player: PublicKey, tick: (s: number) => void, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const i = await app.conns.base.getAccountInfo(player, "confirmed");
    if (i?.owner.equals(app.cfg.programId)) return;
    tick(Math.round((Date.now() - t0) / 1000));
    await sleep(500);
  }
  throw new Error("The rollup hasn't settled your player on the base layer yet. It will; try again in a minute to finish.");
}

const withdrawSigKey = (player: PublicKey) => `magicraft.withdrawSig.${player.toBase58()}`;

/** The current withdraw phase of the Player, from chain state (and our last `withdraw` sig).
 *  `er`: the ER the Player is delegated to (default: the selected region's). */
export async function currentWithdrawPhase(app: App, er: Connection = app.conns.er): Promise<WithdrawPhase> {
  const player = app.state.player!;
  const base = app.conns.base;
  const [bi, ei] = await Promise.all([base.getAccountInfo(player, "confirmed"), er.getAccountInfo(player, "confirmed")]);
  let spendable = 0;
  if (bi?.owner.equals(app.cfg.programId)) spendable = bi.lamports - (await base.getMinimumBalanceForRentExemption(bi.data.length));
  let landed = false;
  let sig: string | null = null;
  try {
    sig = app.store?.getItem(withdrawSigKey(player)) ?? null;
  } catch {
    /* storage unavailable */
  }
  if (sig && bi && !bi.owner.equals(app.cfg.programId)) {
    const st = (await er.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
    landed = !!st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized");
  }
  return withdrawPhase({
    programId: app.cfg.programId,
    baseOwner: bi?.owner ?? null,
    spendable,
    // A delegated Player the ER serves as ours (owner = program) is still live there.
    onEr: !!ei && ei.owner.equals(app.cfg.programId),
    withdrawLanded: landed,
  });
}

/** `withdraw` on `er` (wallet-signed ER tx: commit + undelegate the Player) unless it already
 *  happened, then waits for the base settlement. Resumable: the phase is re-derived from the
 *  chain. Returns the phase afterwards (`withdrawBase`, `done` or `none`). */
export async function withdrawToBase(app: App, status: (msg: string) => void, er: Connection = app.conns.er): Promise<WithdrawPhase> {
  const wallet = app.state.wallet!;
  const player = app.state.player!;
  let phase = await currentWithdrawPhase(app, er);
  if (phase === "withdraw") {
    status(wallet.burner ? "Withdrawing…" : `Approve the withdraw in your wallet. ${ER_SIGN_NOTE}`);
    const tx = await walletTx(er, wallet.publicKey, [await withdrawIx(app.program, wallet.publicKey)]);
    try {
      await sendWithWallet(wallet, er, tx, {
        skipPreflight: true,
        timeoutMs: 30_000,
        onSent: (sig) => {
          try {
            app.store?.setItem(withdrawSigKey(player), sig);
          } catch {
            /* storage unavailable: the ER state still tells */
          }
        },
      });
    } catch (e) {
      // A timed-out withdraw may still have landed: re-derive before failing.
      phase = await currentWithdrawPhase(app, er);
      if (phase === "withdraw") throw e;
    }
    phase = "settling";
  }
  if (phase === "settling") {
    await waitSettled(app, player, (s) => status(`Settling on the base layer… ${s}s (the first settlement on a fresh rollup can take ~10 s)`));
    phase = await currentWithdrawPhase(app, er);
  }
  try {
    app.store?.removeItem(withdrawSigKey(player));
  } catch {
    /* storage unavailable */
  }
  return phase;
}

function planSummary(plan: WithdrawPlan, openChunks: number | null): HTMLElement {
  const li = (n: number, text: string, cls: string) => (n ? h("li", { class: cls }, h("strong", {}, String(n)), " ", text) : null);
  const total = plan.closable.length + plan.edited.length + plan.spawn.length + plan.occupied.length;
  const n = openChunks ?? total;
  return h(
    "div",
    { class: "plan" },
    h("p", {}, `Your player sponsors ${n} open chunk${n === 1 ? "" : "s"}.`),
    h(
      "ul",
      { class: "plan-list" },
      li(plan.closable.length, `untouched and empty: closing ${plan.closable.length === 1 ? "it" : "them"} refunds ${sol(plan.refund, 5)} SOL now.`, "ok"),
      li(plan.edited.length, "edited: their rent stays locked for good (the world keeps your changes).", "locked"),
      li(plan.spawn.length, `spawn chunk${plan.spawn.length === 1 ? "" : "s"} (0, 0): every player arrives there, so ${plan.spawn.length === 1 ? "it stays" : "they stay"} open and the rent stays locked.`, "locked"),
      li(plan.occupied.length, "untouched but with someone listed inside: can't be closed right now.", "warn"),
    ),
    plan.closable.length || plan.occupied.length
      ? h("p", { class: "muted small" }, "Untouched chunks you leave open keep their rent on the rollup; you can only reclaim it after delegating your player again.")
      : null,
  );
}

/** Withdraw dialog: plan → (close chunks) → withdraw → settlement → withdraw_base. Each
 *  attempt re-derives its phase from the chain, so a retry (or a reopened dialog) resumes
 *  where the last one stopped. `done()` runs once, when the dialog closes after any
 *  attempt (the app then re-derives its screen). */
export function openWithdraw(app: App, openChunks: number | null, done: () => void) {
  const status = h("p", { class: "muted", role: "status" }, "Checking your player…");
  const err = h("p", { class: "form-error", role: "alert" });
  const actions = h("div", { class: "actions" });
  const d = dialog("Withdraw", status, err, actions);
  const wallet = app.state.wallet!;
  const player = app.state.player!;
  let attempted = false;
  let finished = false;
  d.dlg.addEventListener("close", () => {
    if (attempted && !finished) {
      finished = true;
      done();
    }
  });
  const button = (label: string, cls: string, onClick: () => void) => {
    const b = h("button", { class: `btn ${cls}`, type: "button" }, label);
    b.addEventListener("click", onClick);
    actions.append(b);
    return b;
  };

  /** Runs the remaining phases (after closing `closeFirst`). */
  const run = async (closeFirst: SponsoredChunk[]) => {
    attempted = true;
    d.setBusy(true);
    clear(actions);
    err.textContent = "";
    try {
      if (closeFirst.length) {
        const r = await closeChunks(app, closeFirst, (i, msg) => (status.textContent = `${msg} (${i + 1}/${closeFirst.length})`));
        if (r.failed) {
          const rest = closeFirst.slice(closeFirst.indexOf(r.failed.chunk));
          status.textContent = `Closed ${r.closed} of ${closeFirst.length} chunks, then stopped.`;
          err.textContent = r.failed.message;
          d.setBusy(false);
          if (r.failed.session)
            button("Renew session", "primary", () =>
              void (async () => {
                try {
                  d.setBusy(true);
                  await renewSession(app);
                  await run(rest);
                } catch (e) {
                  d.setBusy(false);
                  err.textContent = errText(e);
                }
              })(),
            );
          button("Withdraw anyway", r.failed.session ? "ghost" : "primary", () => void run([]));
          (actions.firstElementChild as HTMLElement | null)?.focus();
          return;
        }
        status.textContent = `Closed ${r.closed} chunk${r.closed === 1 ? "" : "s"}.`;
      }
      const phase = await withdrawToBase(app, (m) => (status.textContent = m));
      let got = 0;
      if (phase === "withdrawBase") {
        status.textContent = wallet.burner ? "Transferring to your wallet…" : "Approve the transfer to your wallet…";
        got = await withdrawBaseFlow(app);
      }
      status.textContent = got ? `Done. ${sol(got, 6)} SOL is back in your wallet.` : "Done. Your player is back on the base layer.";
      announce(status.textContent);
      d.setBusy(false);
      button("Close", "primary", d.close).focus();
    } catch (e) {
      d.setBusy(false);
      err.textContent = errText(e);
      button("Try again", "primary", () => void run([])).focus();
    }
  };

  // A withdraw already under way (reload, earlier failure): resume it directly.
  void currentWithdrawPhase(app)
    .then(async (phase) => {
      if (phase === "settling" || phase === "withdrawBase") {
        status.textContent = "A withdraw is already under way.";
        button("Finish withdraw", "primary", () => void run([])).focus();
        return;
      }
      status.textContent = "Looking up the chunks your player sponsors…";
      const plan = await fetchWithdrawPlan(app.conns.er, app.cfg.programId, player);
      status.before(planSummary(plan, openChunks));
      status.textContent = "";
      if (plan.closable.length) button(`Close ${plan.closable.length} and withdraw`, "primary", () => void run(plan.closable));
      button(plan.closable.length ? "Withdraw without closing" : "Withdraw everything", plan.closable.length ? "ghost" : "primary", () => void run([]));
      (actions.firstElementChild as HTMLElement | null)?.focus();
    })
    .catch((e) => {
      status.textContent = "";
      err.textContent = `Couldn't list your chunks (${errText(e)}). You can still withdraw.`;
      button("Withdraw anyway", "primary", () => void run([]));
    });
}
