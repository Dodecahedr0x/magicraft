// Torch lights: the nearest ≤ 16 torches around the camera become shader point lights
// (renderer `setTorches`; per-fragment, radius 9 blocks, no occlusion). Chosen over a light
// value baked into the mesher (flood fill across chunk borders, re-mesh of every chunk a
// torch reaches on each edit) for simplicity; the cost is a 16-iteration loop per fragment
// and light leaking through walls.
//
// Torch positions are scanned from the block bytes of each loaded chunk once per re-mesh
// (`invalidate` with the store's dirty keys — header-only writes never rescan) and cached.
import { B } from "./blocks";
import { MAX_TORCHES } from "./renderer";

export type TorchPos = [number, number, number];

/** World positions (block coords) of every torch in chunk `(cx, cz)`'s block bytes. */
export function scanTorches(blocks: Uint8Array, cx: number, cz: number): TorchPos[] {
  const out: TorchPos[] = [];
  let i = blocks.indexOf(B.TORCH);
  while (i !== -1) {
    out.push([cx * 16 + (i & 15), i >> 8, cz * 16 + ((i >> 4) & 15)]);
    i = blocks.indexOf(B.TORCH, i + 1);
  }
  return out;
}

/** The `n` torches nearest to `p` (block units), nearest first. */
export function nearestTorches(all: Iterable<TorchPos>, p: readonly number[], n = MAX_TORCHES): TorchPos[] {
  const best: { t: TorchPos; d: number }[] = [];
  for (const t of all) {
    const d = (t[0] + 0.5 - p[0]) ** 2 + (t[1] + 0.5 - p[1]) ** 2 + (t[2] + 0.5 - p[2]) ** 2;
    if (best.length === n && d >= best[n - 1].d) continue;
    let i = best.length;
    while (i > 0 && best[i - 1].d > d) i--;
    best.splice(i, 0, { t, d });
    if (best.length > n) best.pop();
  }
  return best.map((b) => b.t);
}

export type TorchSource = {
  entry(key: string): { cx: number; cz: number; blocks: Uint8Array | null } | undefined;
  entries(): Iterable<{ key: string; cx: number; cz: number; blocks: Uint8Array | null }>;
};

export class TorchIndex {
  private perChunk = new Map<string, TorchPos[]>();
  private stale = true;
  private lastPick: { p: number[]; picked: TorchPos[] } | null = null;

  constructor(private readonly src: TorchSource) {}

  /** Chunks re-meshed / removed: rescan them on the next pick. */
  invalidate(keys: Iterable<string>) {
    for (const k of keys) {
      const e = this.src.entry(k);
      if (e?.blocks) this.perChunk.set(k, scanTorches(e.blocks, e.cx, e.cz));
      else this.perChunk.delete(k);
    }
    this.stale = true;
  }

  get count() {
    let n = 0;
    for (const t of this.perChunk.values()) n += t.length;
    return n;
  }

  /** Nearest torches to `p`; recomputed only after a change or a move of ≥ 1 block. */
  pick(p: readonly number[]): TorchPos[] {
    const l = this.lastPick;
    if (!this.stale && l && Math.hypot(p[0] - l.p[0], p[1] - l.p[1], p[2] - l.p[2]) < 1) return l.picked;
    this.stale = false;
    const picked = nearestTorches(
      (function* (m) {
        for (const ts of m.values()) yield* ts;
      })(this.perChunk),
      p,
    );
    this.lastPick = { p: [p[0], p[1], p[2]], picked };
    return picked;
  }
}
