// Onboarding screens: connect a wallet → create + fund + delegate the Player (one wallet tx)
// → start a session (one wallet tx; restored from storage when still valid onchain).
import { LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import {
  CHUNK_TOTAL_RENT,
  ErSender,
  clearSession,
  newSession as buildSession,
  revokeSessionIx,
  ephemeralRent,
  PLAYER_LEN,
  loadSession,
  onboardingIxs,
  playerPda,
  playerStatus,
  saveSession,
  verifySession,
  walletTx,
  WORLD_LEN,
  type PlayerStatus,
  type Session,
} from "../chain";
import type { App } from "../state";
import {
  burnerAllowed,
  burnerKeypair,
  burnerWallet,
  chainFor,
  connectStandard,
  fundBurner,
  onWalletsChanged,
  sendWithWallet,
  standardWallets,
  type AppWallet,
} from "../wallet";
import { withdrawBaseFlow } from "./hud";
import { announce, busy, clear, errText, focusHeading, h, sleep, sol } from "./dom";

/** Default first deposit. */
export const DEFAULT_DEPOSIT_SOL = 0.05;
const LAST_WALLET = "magicraft.lastWallet";

/** How many chunks `lamports` sponsors (chunk + presence rent each). */
export const chunksFor = (lamports: number) => Math.max(0, Math.floor(lamports / CHUNK_TOTAL_RENT));

/** Parses a SOL amount typed by the user → lamports, or an error message. */
export function parseSol(text: string, min = 0, max = 1_000): { lamports: number } | { error: string } {
  const t = text.trim().replace(",", ".");
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return { error: "Enter an amount in SOL, e.g. 0.05." };
  const v = Number(t);
  if (!(v >= min)) return { error: `At least ${min} SOL.` };
  if (v > max) return { error: `At most ${max} SOL.` };
  const lamports = Math.round(v * LAMPORTS_PER_SOL);
  return { lamports };
}

const remember = (app: App, name: string) => {
  try {
    app.store?.setItem(LAST_WALLET, name);
  } catch {
    /* storage unavailable */
  }
};
const lastWallet = (app: App) => {
  try {
    return app.store?.getItem(LAST_WALLET) ?? null;
  } catch {
    return null;
  }
};
export const forgetWallet = (app: App) => {
  try {
    app.store?.removeItem(LAST_WALLET);
  } catch {
    /* storage unavailable */
  }
};

let offWalletChange: (() => void) | null = null;

/** Stops following the current wallet's account changes (disconnect / switch). */
export function releaseWallet() {
  offWalletChange?.();
  offWalletChange = null;
}

/** Sets the connected wallet (and its Player PDA) and follows account switches. */
function useWallet(app: App, w: AppWallet, next: () => void) {
  releaseWallet();
  app.set({ wallet: w, player: playerPda(app.cfg.programId, w.publicKey), session: null, sender: null, world: null, sessionStale: false });
  remember(app, w.name);
  offWalletChange = w.onChange(() => {
    releaseWallet();
    app.set({ wallet: null, player: null, session: null, sender: null, world: null });
    next();
  });
  next();
}

const burnerOk = (app: App) => burnerAllowed(app.cfg.baseRpc, import.meta.env.VITE_BURNER);

async function connectBurner(app: App): Promise<AppWallet> {
  const kp = burnerKeypair(app.store, app.cfg.baseRpc);
  await fundBurner(app.conns.base, kp.publicKey);
  return burnerWallet(kp);
}

/** Reconnects the last used wallet without prompting (burner, or an authorized wallet). */
export async function tryAutoConnect(app: App, next: () => void): Promise<boolean> {
  const name = lastWallet(app);
  if (!name) return false;
  try {
    if (name === "Burner wallet" && burnerOk(app)) {
      useWallet(app, await connectBurner(app), next);
      return true;
    }
    // Injected wallets register right after load.
    for (let i = 0; i < 10 && !standardWallets().some((w) => w.name === name); i++) await sleep(50);
    const w = standardWallets().find((x) => x.name === name);
    if (!w) return false;
    useWallet(app, await connectStandard(w, chainFor(app.cfg.baseRpc, import.meta.env.VITE_WALLET_CHAIN), true), next);
    return true;
  } catch {
    return false;
  }
}

const grassBlock = () =>
  h(
    "div",
    { class: "block-mark", "aria-hidden": "true" },
    h("span", { class: "face top" }),
    h("span", { class: "face left" }),
    h("span", { class: "face right" }),
  );

/** Wallet picker. */
export function showConnect(app: App, root: HTMLElement, next: () => void) {
  clear(root);
  const list = h("div", { class: "wallet-list", role: "list" });
  const err = h("p", { class: "form-error", role: "alert" });
  const chain = chainFor(app.cfg.baseRpc, import.meta.env.VITE_WALLET_CHAIN);

  const pick = (label: string, icon: string | null, note: string, connect: () => Promise<AppWallet>) => {
    const btn = h(
      "button",
      { class: "wallet-btn", type: "button" },
      icon ? h("img", { src: icon, alt: "", width: 28, height: 28 }) : h("span", { class: "wallet-glyph", "aria-hidden": "true" }),
      h("span", { class: "wallet-name" }, label),
      h("span", { class: "wallet-note" }, note),
    );
    btn.addEventListener("click", () =>
      busy(btn, `Connecting ${label}…`, async () => {
        err.textContent = "";
        try {
          useWallet(app, await connect(), next);
        } catch (e) {
          err.textContent = errText(e);
        }
      }),
    );
    return h("div", { role: "listitem" }, btn);
  };

  const render = () => {
    clear(list);
    const ws = standardWallets();
    for (const w of ws) list.append(pick(w.name, w.icon, "Detected", () => connectStandard(w, chain)));
    if (!ws.length)
      list.append(
        h(
          "p",
          { class: "muted" },
          "No Solana wallet detected. Install ",
          h("a", { href: "https://phantom.com", target: "_blank", rel: "noopener" }, "Phantom"),
          ", ",
          h("a", { href: "https://backpack.app", target: "_blank", rel: "noopener" }, "Backpack"),
          " or ",
          h("a", { href: "https://solflare.com", target: "_blank", rel: "noopener" }, "Solflare"),
          ", then reload.",
        ),
      );
    if (burnerOk(app))
      list.append(pick("Burner wallet", null, "Dev only · key in this browser · auto-airdrop", () => connectBurner(app)));
  };
  render();
  const off = onWalletsChanged(render);
  const stop = app.on((_, p) => {
    if (p.wallet) {
      off();
      stop();
    }
  });

  root.append(
    h(
      "section",
      { class: "screen connect", "aria-labelledby": "connect-title" },
      h(
        "div",
        { class: "intro" },
        grassBlock(),
        h("h1", { id: "connect-title" }, "Magicraft"),
        h("p", { class: "lede" }, "A survival sandbox where every block, mob and drop of water lives onchain."),
        h(
          "ul",
          { class: "facts" },
          h("li", {}, h("strong", {}, "One approval to set up. "), "Your player is funded once and plays without wallet popups."),
          h("li", {}, h("strong", {}, "You own the land you open. "), "Each new chunk costs ≈ ", sol(CHUNK_TOTAL_RENT, 5), " SOL of rent; untouched chunks are refundable."),
          h("li", {}, h("strong", {}, "Withdraw any time. "), "Nothing blocks taking your SOL back."),
        ),
      ),
      h("div", { class: "panel" }, h("h2", {}, "Connect a wallet"), list, err),
    ),
  );
  focusHeading(root);
}

/** Waits until the ER has cloned the delegated Player (returns its status). */
async function waitDelegated(app: App, timeoutMs = 30_000): Promise<Extract<PlayerStatus, { state: "delegated" }>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const st = await playerStatus(app.cfg.programId, app.conns.base, app.conns.er, app.state.wallet!.publicKey);
    if (st.state === "delegated" && st.erLamports !== null) return st;
    if (Date.now() > end) throw new Error("The rollup has not picked up your player yet. Reload in a moment.");
    await sleep(300);
  }
}

/** Player setup: none → create + fund + delegate; base (after a withdraw) → delegate again. */
export async function showPlayerSetup(app: App, root: HTMLElement, st: PlayerStatus, next: () => void) {
  clear(root);
  const wallet = app.state.wallet!;
  const fresh = st.state === "none";
  const amount = h("input", {
    id: "deposit",
    class: "input",
    inputmode: "decimal",
    autocomplete: "off",
    value: String(DEFAULT_DEPOSIT_SOL),
    "aria-describedby": "deposit-hint deposit-error",
  });
  const hint = h("p", { id: "deposit-hint", class: "hint" });
  const err = h("p", { id: "deposit-error", class: "form-error", role: "alert" });
  const walletBal = h("span", {}, "…");
  void app.conns.base.getBalance(wallet.publicKey).then(
    (b) => (walletBal.textContent = `${sol(b)} SOL`),
    () => (walletBal.textContent = "unavailable"),
  );
  // Spendable lamports of a parked Player (above its rent-exempt minimum).
  let parked = 0;
  const update = () => {
    const r = parseSol(amount.value, fresh ? 0.001 : 0);
    if ("error" in r) {
      err.textContent = r.error;
      amount.setAttribute("aria-invalid", "true");
      hint.textContent = "";
      return null;
    }
    err.textContent = "";
    amount.removeAttribute("aria-invalid");
    const total = r.lamports + parked;
    hint.textContent = `Enough for about ${chunksFor(total)} chunks at ≈ ${sol(CHUNK_TOTAL_RENT, 5)} SOL each (plus ${sol(ephemeralRent(WORLD_LEN), 5)} SOL per world you create).`;
    return r.lamports;
  };
  amount.addEventListener("input", update);
  update();

  const go = h("button", { class: "btn primary", type: "submit" }, fresh ? "Create player" : "Delegate and play");
  const form = h(
    "form",
    { class: "panel narrow", novalidate: true },
    h("h1", {}, fresh ? "Fund your player" : "Your player is parked"),
    fresh
      ? h("p", {}, "Your player is an onchain account that holds SOL and pays the rent of the land you open. One approval creates it, funds it and moves it to the rollup.")
      : h("p", { class: "parked" }, "Move it back to the rollup to play, optionally adding more."),
    h("label", { for: "deposit", class: "label" }, fresh ? "Deposit" : "Add (optional)"),
    h("div", { class: "input-wrap" }, amount, h("span", { class: "suffix" }, "SOL")),
    hint,
    err,
    h("p", { class: "muted small" }, "Wallet balance: ", walletBal),
    h("div", { class: "actions" }, go),
  );
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const lamports = update();
    if (lamports === null) return amount.focus();
    void busy(go, "Waiting for the wallet…", async () => {
      try {
        const ixs = await onboardingIxs(app.program, app.cfg, wallet.publicKey, lamports);
        // init_player only for a new Player; deposit needs an undelegated Player.
        const pick = fresh ? ixs : lamports > 0 ? ixs.slice(1) : ixs.slice(2);
        const tx = await walletTx(app.conns.base, wallet.publicKey, pick);
        go.textContent = "Confirming…";
        await sendWithWallet(wallet, app.conns.base, tx, { viaWallet: true });
        go.textContent = "Waiting for the rollup…";
        await waitDelegated(app);
        announce("Player ready.");
        next();
      } catch (e) {
        err.textContent = errText(e);
      }
    });
  });

  root.append(h("section", { class: "screen center" }, form));
  if (st.state === "base") {
    const minimum = await app.conns.base.getMinimumBalanceForRentExemption(PLAYER_LEN).catch(() => st.lamports);
    parked = Math.max(0, st.lamports - minimum);
    update();
    form.querySelector(".parked")!.textContent = parked
      ? `It holds ${sol(parked, 6)} SOL on the base layer. Move it back to the rollup to play, optionally adding more.`
      : "It is back on the base layer and empty. Add SOL and move it to the rollup to play.";
  }
  if (st.state === "base" && parked > 0) {
    const out = h("button", { class: "btn ghost", type: "button" }, `Withdraw ${sol(parked, 6)} SOL to my wallet`);
    out.addEventListener("click", () =>
      busy(out, "Withdrawing…", async () => {
        try {
          const got = await withdrawBaseFlow(app);
          announce(`Withdrew ${sol(got, 6)} SOL.`);
          next();
        } catch (e) {
          err.textContent = errText(e);
        }
      }),
    );
    form.querySelector(".actions")!.append(out);
  }
  focusHeading(root);
}

/** Makes an ER sender for `s` that flags the session stale on token errors. */
function senderFor(app: App, s: Session): ErSender {
  return new ErSender(app.conns.er, s.kp, {
    programId: app.cfg.programId,
    onError: (f) => {
      if (f.kind === "renewSession") app.set({ sessionStale: true });
    },
  });
}

/** Installs `s` as the active session (reusing the sender: only its payer changes). */
function useSession(app: App, s: Session) {
  const sender = app.state.sender ?? senderFor(app, s);
  sender.payer = s.kp;
  app.set({ session: s, sender, sessionStale: false });
}

/** A stored session that is still valid onchain, or null (an invalid one is forgotten). */
export async function restoreSession(app: App): Promise<Session | null> {
  const w = app.state.wallet!;
  const s = loadSession(app.store, app.cfg.programId, w.publicKey);
  if (!s) return null;
  if (await verifySession(app.conns.base, s)) return s;
  clearSession(app.store, app.cfg.programId, w.publicKey);
  return null;
}

/** Creates a new session (one wallet approval) and makes it active. With `revoke`, the
 *  same tx revokes that old token if it still exists (rent back to the wallet). */
export async function newSession(app: App, revoke: Session | null = null): Promise<Session> {
  const w = app.state.wallet!;
  const base = app.conns.base;
  const { session, ix } = buildSession(app.cfg.programId, w.publicKey);
  const tx = new Transaction();
  if (revoke && revoke.authority.equals(w.publicKey) && (await base.getAccountInfo(revoke.token, "confirmed")))
    tx.add(revokeSessionIx(revoke.token, w.publicKey));
  tx.add(ix);
  tx.feePayer = w.publicKey;
  tx.recentBlockhash = (await base.getLatestBlockhash("confirmed")).blockhash;
  tx.partialSign(session.kp);
  await sendWithWallet(w, base, tx, { viaWallet: true });
  saveSession(app.store, session);
  useSession(app, session);
  return session;
}

/** Session step: restore silently, else ask for one approval. */
export async function showSession(app: App, root: HTMLElement, next: () => void) {
  clear(root);
  const status = h("p", { class: "muted", role: "status" }, "Checking for a saved session…");
  const panel = h("div", { class: "panel narrow" }, h("h1", {}, "Start a play session"), status);
  root.append(h("section", { class: "screen center" }, panel));
  try {
    const s = await restoreSession(app);
    if (s) {
      useSession(app, s);
      return next();
    }
  } catch {
    /* fall through to a new session */
  }
  status.textContent = "";
  const err = h("p", { class: "form-error", role: "alert" });
  const go = h("button", { class: "btn primary", type: "button" }, "Start session");
  go.addEventListener("click", () =>
    busy(go, "Waiting for the wallet…", async () => {
      try {
        await newSession(app);
        announce("Session started.");
        next();
      } catch (e) {
        err.textContent = errText(e);
      }
    }),
  );
  panel.append(
    h("p", {}, "One approval lets this browser sign your moves for up to 7 days, so playing never opens the wallet. The session key holds no SOL and can only act as your player in Magicraft."),
    err,
    h("div", { class: "actions" }, go),
  );
  focusHeading(root);
}

/** Banner action: renew an expired / revoked session in place. */
export async function renewSession(app: App): Promise<void> {
  const old = app.state.session;
  clearSession(app.store, app.cfg.programId, app.state.wallet!.publicKey);
  await newSession(app, old);
}

