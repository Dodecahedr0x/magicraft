// Tiny DOM helpers shared by the screens (no framework).
import { LAMPORTS_PER_SOL, type PublicKey } from "@solana/web3.js";
import { TxError } from "../wallet";

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

/** `h("button", { class: "btn", onclick: fn, disabled: true }, "Go")`. `on*` keys are
 *  listeners; `true` booleans become empty attributes, `false`/null are skipped. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  append(el, ...children);
  return el;
}

export function append(el: Element, ...children: Child[]) {
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
}

export const clear = (el: Element) => el.replaceChildren();

/** Lamports → "0.0123" SOL (4 significant decimals, ≥ 1e-6 shown). */
export function sol(lamports: number | bigint, digits = 4): string {
  const v = Number(lamports) / LAMPORTS_PER_SOL;
  if (v !== 0 && Math.abs(v) < 10 ** -digits) return v.toFixed(6).replace(/0+$/, "");
  return v.toFixed(digits).replace(/\.?0+$/, "") || "0";
}

export const short = (pk: PublicKey | string, n = 4) => {
  const s = typeof pk === "string" ? pk : pk.toBase58();
  return `${s.slice(0, n)}…${s.slice(-n)}`;
};

/** A readable message for anything thrown by a wallet, RPC or builder. */
export function errText(e: unknown): string {
  if (e instanceof TxError) return e.message;
  const m = e instanceof Error ? e.message : String(e);
  if (/user rejected|rejected the request|declined/i.test(m)) return "Request rejected in the wallet.";
  if (/failed to fetch|networkerror|ECONNREFUSED/i.test(m)) return "Can't reach the RPC. Check your connection and try again.";
  return m.length > 300 ? `${m.slice(0, 300)}…` : m;
}

/** Announces `msg` to screen readers (polite live region in index.html). */
export function announce(msg: string) {
  const el = document.getElementById("live");
  if (!el) return;
  el.textContent = "";
  requestAnimationFrame(() => (el.textContent = msg));
}

/** Moves focus to the screen's heading so keyboard / SR users land on the new content. */
export function focusHeading(root: Element) {
  const hd = root.querySelector<HTMLElement>("h1, h2");
  if (!hd) return;
  hd.tabIndex = -1;
  hd.focus({ preventScroll: false });
}

/** Runs `fn` with `btn` disabled and marked busy; restores it afterwards. */
export async function busy<T>(btn: HTMLButtonElement, label: string, fn: () => Promise<T>): Promise<T> {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  btn.textContent = label;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btn.innerHTML = old;
  }
}

export type StepState = "pending" | "active" | "done" | "error" | "skipped";

/** An ordered progress list; `set(i, state, detail?)` updates one step. */
export function stepList(labels: string[]) {
  const items = labels.map((l) =>
    h("li", { class: "step", "data-state": "pending" }, h("span", { class: "step-dot", "aria-hidden": "true" }), h("span", { class: "step-label" }, l), h("span", { class: "step-detail" })),
  );
  const el = h("ol", { class: "steps" }, ...items);
  return {
    el,
    set(i: number, state: StepState, detail = "") {
      const li = items[i];
      li.dataset.state = state;
      if (state === "active") li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
      li.querySelector(".step-detail")!.textContent = detail;
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
