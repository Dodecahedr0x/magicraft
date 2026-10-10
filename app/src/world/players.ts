// Other players: from the presence lists the client keeps subscribed (player/presence.ts,
// the chunks around the player), drawn as box humanoids with a name tag (short Player PDA),
// interpolated between presence updates and faded out once their entry goes stale.
//
// - `visiblePlayers`: entries fresh at chain time (`now − last_seen_ms ≤ PRESENCE_STALE_MS`,
//   the program's rule), excluding our own Player PDA, deduplicated by player (a player
//   can be listed in two chunks around a border crossing: the newest entry wins).
// - Each visible player retargets a `Motion` over `MOVE_LERP_MS` (moves arrive at ≤ 8 Hz);
//   a player no longer visible fades out over `FADE_MS` and is then dropped; new ones fade in.
import type { PublicKey } from "@solana/web3.js";
import * as THREE from "three";
import { FP, PRESENCE_STALE_MS, type V3 } from "../chain";
import { angleDiff, Motion } from "./mobs";
import { BoxBatch, drawModel, humanoid, type Part } from "./models";
import type { WorldRenderer } from "./renderer";

export type PresenceLike = { player: PublicKey; pos: V3; lastSeenMs: number };

/** base58 of a key, cached per `PublicKey` object (entries are re-decoded only when their
 *  presence account changes, so this is computed once per update, not per frame). */
const keyCache = new WeakMap<PublicKey, string>();
export function keyOf(k: PublicKey): string {
  let s = keyCache.get(k);
  if (s === undefined) keyCache.set(k, (s = k.toBase58()));
  return s;
}

/** Fresh entries by player (base58), newest per player, without `self`, into `out`
 *  (cleared first). Unknown chain time (`nowMs` null) shows nobody. */
export function visiblePlayers(
  lists: Iterable<readonly PresenceLike[]>,
  self: string | null,
  nowMs: number | null,
  staleMs = PRESENCE_STALE_MS,
  out = new Map<string, PresenceLike>(),
): Map<string, PresenceLike> {
  out.clear();
  if (nowMs === null) return out;
  for (const list of lists)
    for (const e of list) {
      if (nowMs - e.lastSeenMs > staleMs) continue;
      const k = keyOf(e.player);
      if (k === self) continue;
      const cur = out.get(k);
      if (!cur || e.lastSeenMs > cur.lastSeenMs) out.set(k, e);
    }
  return out;
}

/** Short form of a public key: `AbCd…WxYz`. */
export const shortKey = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

export const MOVE_LERP_MS = 150;
export const FADE_MS = 1000;
const FADE_IN_MS = 300;

export type PlayerTrack = {
  key: string;
  motion: Motion;
  lastSeenMs: number;
  /** Fade: alpha target 1 while visible; `goneAt` set once not visible. */
  bornAt: number;
  goneAt: number | null;
};

/** Visibility + interpolation (unit-tested). `now` = local ms. */
export class PlayerTracker {
  readonly players = new Map<string, PlayerTrack>();

  update(visible: Map<string, PresenceLike>, now: number) {
    for (const [k, e] of visible) {
      const [x, y, z] = [e.pos[0] / FP, e.pos[1] / FP, e.pos[2] / FP];
      let t = this.players.get(k);
      if (!t) this.players.set(k, (t = { key: k, motion: new Motion([x, y, z]), lastSeenMs: e.lastSeenMs, bornAt: now, goneAt: null }));
      else {
        const m = t.motion;
        if (x !== m.to[0] || y !== m.to[1] || z !== m.to[2]) m.retarget([x, y, z], now, MOVE_LERP_MS, 16);
        if (t.goneAt !== null) {
          // Back: fade in from the current alpha.
          t.bornAt = now - FADE_IN_MS * this.alpha(t, now);
          t.goneAt = null;
        }
      }
      t.lastSeenMs = e.lastSeenMs;
    }
    for (const t of this.players.values()) {
      if (!visible.has(t.key) && t.goneAt === null) t.goneAt = now - FADE_MS * (1 - this.alpha(t, now));
      if (t.goneAt !== null && now - t.goneAt >= FADE_MS) this.players.delete(t.key);
    }
  }

  alpha(t: PlayerTrack, now: number): number {
    if (t.goneAt !== null) return Math.max(0, 1 - (now - t.goneAt) / FADE_MS);
    return Math.min(1, (now - t.bornAt) / FADE_IN_MS);
  }
}

// ---------------------------------------------------------------- rendering

export type PlayerLayerDeps = {
  /** Cached presence lists around the player. */
  lists(): Iterable<readonly PresenceLike[]>;
  /** Our own Player PDA (base58). */
  self: string | null;
  /** Chain-time estimate, ms. */
  now(): number | null;
};

type Look = { parts: Part[]; tag: THREE.Sprite; yaw: number; speed: number; phase: number };

const hashOf = (k: string) => {
  let h = 2166136261;
  for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 16777619);
  return h >>> 0;
};
const SKINS = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];

function hsl(h: number, s: number, l: number) {
  return new THREE.Color().setHSL(h, s, l, THREE.SRGBColorSpace).getHex(THREE.SRGBColorSpace);
}

function nameTag(text: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const g = c.getContext("2d")!;
  g.font = "600 34px ui-monospace, Menlo, monospace";
  const w = Math.min(248, g.measureText(text).width + 24);
  g.fillStyle = "rgba(0,0,0,0.45)";
  g.fillRect((256 - w) / 2, 8, w, 48);
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  s.scale.set(1.4, 0.35, 1);
  s.renderOrder = 4;
  return s;
}

export class PlayerLayer {
  readonly tracker = new PlayerTracker();
  /** Opaque players; fading ones go to the transparent batch. */
  readonly batch: BoxBatch;
  readonly fading: BoxBatch;
  private looks = new Map<string, Look>();
  private visible = new Map<string, PresenceLike>();
  private readonly tmp: V3 = [0, 0, 0];

  constructor(
    private readonly renderer: WorldRenderer,
    readonly deps: PlayerLayerDeps,
  ) {
    this.batch = new BoxBatch(renderer, 128, { name: "players" });
    this.fading = new BoxBatch(renderer, 64, { name: "players (fading)", transparent: true });
  }

  get count() {
    return this.tracker.players.size;
  }

  private look(key: string): Look {
    let l = this.looks.get(key);
    if (l) return l;
    const h = hashOf(key);
    const parts = humanoid(SKINS[h % SKINS.length], hsl(((h >>> 8) % 360) / 360, 0.55, 0.45), hsl(((h >>> 17) % 360) / 360, 0.35, 0.25), false);
    const tag = nameTag(shortKey(key));
    this.renderer.scene.add(tag);
    l = { parts, tag, yaw: 0, speed: 0, phase: 0 };
    this.looks.set(key, l);
    return l;
  }

  update(dt: number, now = performance.now()) {
    this.tracker.update(visiblePlayers(this.deps.lists(), this.deps.self, this.deps.now(), PRESENCE_STALE_MS, this.visible), now);
    const cam = this.renderer.camera.position;
    const far = (this.renderer.scene.fog as { far?: number } | null)?.far ?? Infinity;
    const far2 = (far + 2) * (far + 2);
    this.batch.begin();
    this.fading.begin();
    for (const t of this.tracker.players.values()) {
      const l = this.look(t.key);
      const pos = t.motion.at(now, this.tmp);
      const culled = (pos[0] - cam.x) ** 2 + (pos[1] - cam.y) ** 2 + (pos[2] - cam.z) ** 2 > far2;
      l.tag.visible = !culled;
      if (culled) continue;
      const dx = t.motion.to[0] - t.motion.from[0];
      const dz = t.motion.to[2] - t.motion.from[2];
      const moving = now < t.motion.t0 + t.motion.dur && Math.hypot(dx, dz) > 0.01;
      if (moving) l.yaw += angleDiff(Math.atan2(dx, dz), l.yaw) * Math.min(1, dt * 10);
      const sp = moving ? Math.hypot(dx, dz) / (t.motion.dur / 1000) : 0;
      l.speed += (sp - l.speed) * Math.min(1, dt * 6);
      l.phase += l.speed * dt * 3.2;
      const alpha = this.tracker.alpha(t, now);
      drawModel(alpha < 1 ? this.fading : this.batch, l.parts, { pos, yaw: l.yaw, swing: Math.sin(l.phase) * Math.min(0.8, l.speed * 0.25), alpha });
      l.tag.position.set(pos[0], pos[1] + 2.15, pos[2]);
      (l.tag.material as THREE.SpriteMaterial).opacity = alpha;
    }
    this.batch.end();
    this.fading.end();
    for (const [k, l] of this.looks)
      if (!this.tracker.players.has(k)) {
        this.renderer.scene.remove(l.tag);
        l.tag.material.map?.dispose();
        l.tag.material.dispose();
        this.looks.delete(k);
      }
  }

  dispose() {
    for (const l of this.looks.values()) {
      this.renderer.scene.remove(l.tag);
      l.tag.material.map?.dispose();
      l.tag.material.dispose();
    }
    this.looks.clear();
    this.batch.dispose();
    this.fading.dispose();
  }
}
