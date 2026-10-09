// Meeting zombies in specs: pick a spawn column near the player, and the
// shared chase loop (walk toward the nearest zombie at the player's level until
// its hits land; the damage must arrive through the presence entry's
// `pending_damage`, i.e. from a zombie).
import { web3 } from "@anchor-lang/core";
import { TxError } from "./env";
import { chunkPda, liveBlocks, presencePda } from "./chunk";
import { center, chunkOf, fetchPresence, FP } from "./play";
import { mobsIn, ZOMBIE } from "./actions";
import { Col, Terrain, walkTree } from "./scout";

const ckey = (c: Col) => `${Math.floor(c[0] / 16)},${Math.floor(c[1] / 16)}`;

/** A surface column walkable from `from`, in the same chunk, at Chebyshev
 *  distance `d` (FP feet position at its center), or null. */
export function columnNear(t: Terrain, from: Col, d = 3): number[] | null {
  const c = walkTree(t, from).order.find(
    (c) =>
      ckey(c) === ckey(from) &&
      Math.max(Math.abs(c[0] - from[0]), Math.abs(c[1] - from[1])) === d
  );
  return c ? center(c[0], t.h(...c)!, c[1]) : null;
}

export type Chase = {
  hurt: boolean;
  dead: boolean;
  /** A level zombie was seen (ms after the start, −1 = never). */
  seenMs: number;
  /** `pending_damage` seen in the player's entry right before a move that
   *  lowered health (0 if never seen). */
  pendingBeforeHit: number;
  health: number;
};

/** Moves `player` toward the nearest zombie within 2 blocks of its level in
 *  `keys()` chunks (in place when close or unreachable) until health drops,
 *  it dies, `timeoutMs` passes, or `stop()` says so. `move(next?)` sends one
 *  move (in place without `next`); `me()` reads feet position and health. */
export async function chaseUntilHurt(o: {
  world: web3.PublicKey;
  player: web3.PublicKey;
  keys: () => Iterable<string>;
  me: () => Promise<{ pos: number[]; health: number }>;
  move: (next?: number[]) => Promise<unknown>;
  timeoutMs: number;
  stop?: () => Promise<boolean>;
}): Promise<Chase> {
  const t0 = Date.now();
  const out: Chase = {
    hurt: false,
    dead: false,
    seenMs: -1,
    pendingBeforeHit: 0,
    health: (await o.me()).health,
  };
  while (Date.now() - t0 < o.timeoutMs && !(await o.stop?.())) {
    const { pos, health } = await o.me();
    const zs = (await mobsIn(o.world, o.keys(), ZOMBIE))
      .filter((m) => Math.abs(m.pos[1] - pos[1]) <= 2 * FP)
      .map((m) => ({
        ...m,
        d: Math.hypot(m.pos[0] - pos[0], m.pos[2] - pos[2]),
      }))
      .sort((a, b) => a.d - b.d);
    if (zs.length && out.seenMs < 0) out.seenMs = Date.now() - t0;
    let next: number[] | undefined;
    if (zs.length && zs[0].d > 1.5 * FP) {
      const t = new Terrain(await liveBlocks(o.world, o.keys()));
      const me: Col = [Math.floor(pos[0] / FP), Math.floor(pos[2] / FP)];
      const path = walkTree(t, me).path([
        Math.floor(zs[0].pos[0] / FP),
        Math.floor(zs[0].pos[2] / FP),
      ]);
      if (path?.length) next = center(...path[0]);
    }
    // Next to a zombie: wait (≤ 1.5 s, the entry stays fresh) until its hit is
    // recorded in our presence entry, so the move below is the one applying it.
    const pendingNow = async () => {
      const pres = await fetchPresence(
        presencePda(chunkPda(o.world, chunkOf(pos[0]), chunkOf(pos[2])))
      ).catch(() => null);
      return (
        pres?.entries.find((e) => e.player.equals(o.player))?.pendingDamage ?? 0
      );
    };
    let pending = await pendingNow();
    if (!next && zs.length && zs[0].d <= 2 * FP) {
      const until = Date.now() + 1_500;
      while (!pending && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 100));
        pending = await pendingNow();
      }
    }
    try {
      await o.move(next);
    } catch (e) {
      if ((e as TxError).code !== "Dead") throw e;
      out.dead = out.hurt = true;
      out.pendingBeforeHit = Math.max(out.pendingBeforeHit, pending);
      out.health = 0;
      break;
    }
    const h = (await o.me()).health;
    out.health = h;
    if (h < health) {
      out.hurt = true;
      out.pendingBeforeHit = Math.max(out.pendingBeforeHit, pending);
      out.dead = h === 0;
      // Done once a drop is attributed to recorded zombie damage (a hit can
      // also land between the read and the move: keep going then).
      if (pending > 0 || out.dead) break;
    }
  }
  return out;
}
