// Per-instruction CU and tx counting for long scenario specs: record tx
// signatures as they are sent, resolve the CUs (one getTransaction each) at
// the end, print a summary table.
import { ixCus } from "./chunk";

export class TxStats {
  private pending: { names: string[]; sig: string }[] = [];
  readonly cus = new Map<string, number[]>();
  /** Txs by category (e.g. "ER session", "ER wallet", "base"). */
  readonly txs = new Map<string, number>();

  /** Counts a tx in `category`; `names` label its magicraft ixs in order
   *  (CUs resolved by `resolve()`), none for non-magicraft txs. */
  add(category: string, sig: string | null, names: string[] = []) {
    this.txs.set(category, (this.txs.get(category) ?? 0) + 1);
    if (sig && names.length) this.pending.push({ names, sig });
  }

  /** Fetches the CUs of the recorded txs (in parallel batches). */
  async resolve() {
    const todo = this.pending.splice(0);
    for (let i = 0; i < todo.length; i += 16) {
      const batch = todo.slice(i, i + 16);
      const res = await Promise.all(batch.map((t) => ixCus(t.sig)));
      batch.forEach((t, j) =>
        t.names.forEach((n, k) => {
          const c = res[j].ixs[k];
          if (c !== undefined) this.cus.set(n, [...(this.cus.get(n) ?? []), c]);
        })
      );
    }
  }

  /** Adds externally measured CUs (e.g. cranked ticks). */
  addCus(name: string, v: number[]) {
    this.cus.set(name, [...(this.cus.get(name) ?? []), ...v]);
  }

  /** Markdown-ish table: ix, count, min, median, max. */
  table(): string {
    const rows = [...this.cus].map(([n, v]) => {
      const s = [...v].sort((a, b) => a - b);
      return `| ${n} | ${v.length} | ${s[0]} | ${s[s.length >> 1]} | ${
        s[s.length - 1]
      } |`;
    });
    return [
      "| ix | n | min CU | median CU | max CU |",
      "|---|---|---|---|---|",
      ...rows,
    ].join("\n");
  }
}
