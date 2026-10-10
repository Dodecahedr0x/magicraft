// Mobs: tracked by mob id across chunk headers, interpolated between account updates, drawn
// as instanced box models (models.ts) with a walk cycle, hurt flash, death poof and
// zombies burning by day.
//
// Data flow: the chunk store applies every account update (header-only writes too — they
// never re-mesh but bump the entry's `version`); `MobLayer.update` polls the loaded entries
// each frame and feeds the mobs of every changed chunk to `MobTracker.ingest`.
//
// - Identity is the mob `id` (stable random u32), not the slot: a mob walking into another
//   chunk shows up in that chunk's header and leaves the old one, in either order (two
//   account notifications). The tracker keeps per-mob the set of chunks listing it; a mob
//   listed nowhere is "missing" for `graceMs` before it counts as dead (poof), so a
//   border crossing whose "left" notification lands first continues smoothly — unless its
//   last position is more than `EDGE_GRACE_BLOCKS` from that chunk's edge (a mob moves
//   ≤ 1.2 blocks per tick, so it cannot have crossed): then it dies at once.
// - A chunk leaving the load radius forgets its mobs silently (no poof).
// - Positions are interpolated: each new position starts a segment from the currently
//   shown position to the new one over one mob tick (`mob_tick_ms`), so motion is continuous
//   with ~1 tick of latency. Jumps over `TELEPORT_BLOCKS` snap.
// - Heading: movement direction while moving, else the passive heading `dir` (`DIRS8`),
//   else a zombie near the player faces the player.
// - The interaction layer picks / outlines mobs at their **shown** position (`renderPos`)
//   so the hit box matches what is on screen; reach is still checked onchain-style from
//   the account position.
import { decodeMob, FP, GEN_DONE, MOB, MOB_SIZE, MOB_SLOTS, MOBS_OFFSET, type V3 } from "../chain";
import { BoxBatch, drawCube, drawModel, linear, MOB_MODELS } from "./models";
import type { WorldRenderer } from "./renderer";

/** `core::mobs::DIRS8` headings (dx, dz): E, SE, S, SW, W, NW, N, NE; 8 = idle. */
export const DIRS8: readonly (readonly [number, number])[] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];
export const TELEPORT_BLOCKS = 4;
/** A mob that vanishes farther than this from its chunk's edge died (no crossing). */
export const EDGE_GRACE_BLOCKS = 1.5;

/** Distance (blocks) from `p` to the nearest edge of chunk `key` ("cx,cz"). */
export function edgeDistance(key: string, p: readonly number[]): number {
  const [cx, cz] = key.split(",").map(Number);
  const lx = p[0] - cx * 16;
  const lz = p[2] - cz * 16;
  return Math.min(lx, 16 - lx, lz, 16 - lz);
}

/** A position segment: `from` → `to` over `[t0, t0 + dur]` (ms, blocks). */
export class Motion {
  from: V3;
  to: V3;
  t0 = 0;
  dur = 1;
  constructor(p: V3) {
    this.from = [...p];
    this.to = [...p];
  }
  at(now: number, out: V3 = [0, 0, 0]): V3 {
    const k = Math.min(1, Math.max(0, (now - this.t0) / this.dur));
    for (let i = 0; i < 3; i++) out[i] = this.from[i] + (this.to[i] - this.from[i]) * k;
    return out;
  }
  /** Blocks per second along the current segment (0 once it has ended). */
  speed(now: number): number {
    if (now >= this.t0 + this.dur) return 0;
    return Math.hypot(this.to[0] - this.from[0], this.to[1] - this.from[1], this.to[2] - this.from[2]) / (this.dur / 1000);
  }
  /** Heads to `p` from wherever it is shown now (snaps if farther than `snap` blocks). */
  retarget(p: V3, now: number, dur: number, snap = TELEPORT_BLOCKS) {
    const cur = this.at(now);
    const far = Math.hypot(p[0] - cur[0], p[1] - cur[1], p[2] - cur[2]) > snap;
    this.from = far ? [...p] : cur;
    this.to = [...p];
    this.t0 = now;
    this.dur = Math.max(1, dur);
  }
}

export type MobSnap = { id: number; kind: number; hp: number; dir: number; burnMs: number; /** FP feet. */ pos: V3 };

export type MobTrack = {
  id: number;
  kind: number;
  hp: number;
  dir: number;
  motion: Motion;
  /** Chunk keys whose latest header lists this mob. */
  chunks: Set<string>;
  missingSince: number | null;
  /** Last update time and last hp drop / burning sighting (ms). */
  seenAt: number;
  hurtAt: number;
  burnAt: number;
};

export type MobEvent = { type: "spawn" | "hurt" | "died"; id: number; kind: number; pos: V3 };

const toBlocks = (p: V3): V3 => [p[0] / FP, p[1] / FP, p[2] / FP];
const same = (a: V3, b: V3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** Mob identity + interpolation (no rendering; unit-tested). Times in ms (any clock). */
export class MobTracker {
  readonly mobs = new Map<number, MobTrack>();
  private byChunk = new Map<string, Set<number>>();

  constructor(
    /** Interpolation length per update (the world's `mob_tick_ms`). */
    public tickMs = 333,
    readonly graceMs = 450,
  ) {}

  /** Chunk `key`'s current live mobs (its whole header). */
  ingest(key: string, snaps: readonly MobSnap[], now: number): MobEvent[] {
    const ev: MobEvent[] = [];
    const before = this.byChunk.get(key) ?? new Set<number>();
    const after = new Set<number>();
    for (const s of snaps) {
      if (after.has(s.id)) continue;
      after.add(s.id);
      const p = toBlocks(s.pos);
      let m = this.mobs.get(s.id);
      if (!m) {
        m = { id: s.id, kind: s.kind, hp: s.hp, dir: s.dir, motion: new Motion(p), chunks: new Set(), missingSince: null, seenAt: now, hurtAt: -Infinity, burnAt: -Infinity };
        this.mobs.set(s.id, m);
        ev.push({ type: "spawn", id: s.id, kind: s.kind, pos: p });
      } else if (!same(p, m.motion.to)) m.motion.retarget(p, now, Math.min(1000, Math.max(80, this.tickMs)));
      if (s.hp < m.hp && s.kind === m.kind) {
        m.hurtAt = now;
        ev.push({ type: "hurt", id: s.id, kind: s.kind, pos: p });
      }
      if (s.burnMs > 0) m.burnAt = now;
      m.kind = s.kind;
      m.hp = s.hp;
      m.dir = s.dir;
      m.seenAt = now;
      m.chunks.add(key);
      m.missingSince = null;
    }
    for (const id of before)
      if (!after.has(id)) {
        const m = this.mobs.get(id);
        if (!m) continue;
        m.chunks.delete(key);
        if (!m.chunks.size) m.missingSince = edgeDistance(key, m.motion.to) > EDGE_GRACE_BLOCKS ? -Infinity : now;
      }
    if (after.size) this.byChunk.set(key, after);
    else this.byChunk.delete(key);
    return ev;
  }

  /** Chunk `key` was unloaded: its mobs vanish silently unless another chunk lists them. */
  unload(key: string) {
    const ids = this.byChunk.get(key);
    this.byChunk.delete(key);
    if (!ids) return;
    for (const id of ids) {
      const m = this.mobs.get(id);
      if (!m) continue;
      m.chunks.delete(key);
      if (!m.chunks.size) this.mobs.delete(id);
    }
  }

  /** Drops mobs missing for longer than the grace period (`died` events). */
  expire(now: number): MobEvent[] {
    const ev: MobEvent[] = [];
    for (const m of this.mobs.values())
      if (m.missingSince !== null && now - m.missingSince > this.graceMs) {
        this.mobs.delete(m.id);
        ev.push({ type: "died", id: m.id, kind: m.kind, pos: m.motion.at(now) });
      }
    return ev;
  }

  /** Shown position (blocks). */
  pos(id: number, now: number): V3 | null {
    const m = this.mobs.get(id);
    return m ? m.motion.at(now) : null;
  }
}

/** Live mobs (`kind != 0 && hp > 0`) of a chunk account's header. */
export function chunkMobs(data: Uint8Array): MobSnap[] {
  const out: MobSnap[] = [];
  for (let i = 0; i < MOB_SLOTS; i++) {
    const m = decodeMob(data, MOBS_OFFSET + MOB_SIZE * i);
    if (m.kind !== MOB.EMPTY && m.hp > 0) out.push({ id: m.id, kind: m.kind, hp: m.hp, dir: m.dir, burnMs: m.burnMs, pos: m.pos });
  }
  return out;
}

/** Angle difference wrapped to (−π, π]. */
export const angleDiff = (a: number, b: number) => {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
};

// ---------------------------------------------------------------- rendering

type Anim = { yaw: number; speed: number; phase: number };
type Particle = { p: V3; v: V3; life: number; max: number; size: number; color: [number, number, number]; gravity: number };

export type MobSource = {
  entries(): Iterable<{ key: string; version: number; data: Uint8Array | null; genStage: number }>;
};

export type MobLayerDeps = {
  store: MobSource;
  /** World `mob_tick_ms`. */
  tickMs: number;
  /** The local player's feet (blocks), for zombies facing the player; null = unknown. */
  player?: () => V3 | null;
};

const HURT_MS = 320;
const BURN_HOLD_MS = 1200;
const RED = [1, 0.08, 0.05];
const FIRE = [1, 0.45, 0.05];
const POOF = linear(0xe8e8e8);
const FLAMES = [linear(0xffd34d), linear(0xff8a1f), linear(0xff5a14)];

export class MobLayer {
  readonly tracker: MobTracker;
  readonly batch: BoxBatch;
  private seen = new Map<string, number>();
  private present = new Set<string>();
  private anim = new Map<number, Anim>();
  private particles: Particle[] = [];
  private fireAcc = 0;
  private readonly tmp: V3 = [0, 0, 0];

  constructor(
    private readonly renderer: WorldRenderer,
    readonly deps: MobLayerDeps,
  ) {
    this.tracker = new MobTracker(deps.tickMs);
    this.batch = new BoxBatch(renderer, 1024, { name: "mobs" });
  }

  /** Feeds changed chunk headers to the tracker (header-only writes included). */
  poll(now: number) {
    const present = this.present;
    present.clear();
    for (const e of this.deps.store.entries()) {
      if (!e.data || e.genStage !== GEN_DONE) continue;
      present.add(e.key);
      if (this.seen.get(e.key) === e.version) continue;
      this.seen.set(e.key, e.version);
      for (const ev of this.tracker.ingest(e.key, chunkMobs(e.data), now)) this.onEvent(ev);
    }
    for (const k of [...this.seen.keys()])
      if (!present.has(k)) {
        this.seen.delete(k);
        this.tracker.unload(k);
      }
  }

  private onEvent(ev: MobEvent) {
    if (ev.type !== "died") return;
    this.anim.delete(ev.id);
    const h = (MOB_MODELS[ev.kind] ? (ev.kind === MOB.ZOMBIE ? 1.9 : ev.kind === MOB.PIG ? 0.8 : 1.2) : 1) / 2;
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 0.8 + Math.random() * 1.6;
      this.particles.push({
        p: [ev.pos[0] + (Math.random() - 0.5) * 0.5, ev.pos[1] + h + (Math.random() - 0.5) * h, ev.pos[2] + (Math.random() - 0.5) * 0.5],
        v: [Math.cos(a) * s, 0.6 + Math.random() * 1.4, Math.sin(a) * s],
        life: 0,
        max: 0.5 + Math.random() * 0.4,
        size: 0.14 + Math.random() * 0.12,
        color: POOF,
        gravity: -1.5,
      });
    }
  }

  /** Shown position of mob `id` in FP (picking / outline), or null. */
  renderPos(id: number): V3 | null {
    const p = this.tracker.pos(id, performance.now());
    return p && [p[0] * FP, p[1] * FP, p[2] * FP];
  }

  get count() {
    return this.tracker.mobs.size;
  }

  update(dt: number, now = performance.now()) {
    this.poll(now);
    for (const ev of this.tracker.expire(now)) this.onEvent(ev);
    const player = this.deps.player?.() ?? null;
    // Mobs beyond the fog are not drawn (and don't count against the batch).
    const cam = this.renderer.camera.position;
    const far = (this.renderer.scene.fog as { far?: number } | null)?.far ?? Infinity;
    const far2 = (far + 2) * (far + 2);
    const b = this.batch;
    b.begin();
    this.fireAcc += dt;
    const emitFire = this.fireAcc > 0.06;
    if (emitFire) this.fireAcc = 0;
    for (const m of this.tracker.mobs.values()) {
      const parts = MOB_MODELS[m.kind];
      if (!parts) continue;
      const pos = m.motion.at(now, this.tmp);
      if ((pos[0] - cam.x) ** 2 + (pos[1] - cam.y) ** 2 + (pos[2] - cam.z) ** 2 > far2) continue;
      let a = this.anim.get(m.id);
      if (!a) this.anim.set(m.id, (a = { yaw: Math.random() * Math.PI * 2, speed: 0, phase: Math.random() * 6 }));
      // Heading.
      const dx = m.motion.to[0] - m.motion.from[0];
      const dz = m.motion.to[2] - m.motion.from[2];
      const moving = now < m.motion.t0 + m.motion.dur && Math.hypot(dx, dz) > 0.02;
      let target: number | null = null;
      if (moving) target = Math.atan2(dx, dz);
      else if (m.kind !== MOB.ZOMBIE && m.dir < 8) target = Math.atan2(DIRS8[m.dir][0], DIRS8[m.dir][1]);
      else if (m.kind === MOB.ZOMBIE && player && Math.hypot(player[0] - pos[0], player[2] - pos[2]) < 16) target = Math.atan2(player[0] - pos[0], player[2] - pos[2]);
      if (target !== null) a.yaw += angleDiff(target, a.yaw) * Math.min(1, dt * 8);
      // Walk cycle: smoothed horizontal speed drives the phase and the swing amplitude.
      const sp = moving ? m.motion.speed(now) : 0;
      a.speed += (sp - a.speed) * Math.min(1, dt * 6);
      a.phase += a.speed * dt * 5.5;
      const swing = Math.sin(a.phase) * Math.min(0.75, a.speed * 0.6);
      // Tint: hurt flash wins over fire.
      const hurt = now - m.hurtAt < HURT_MS;
      const burning = m.kind === MOB.ZOMBIE && now - m.burnAt < BURN_HOLD_MS;
      let tint: number[] | undefined;
      let k = 0;
      if (hurt) {
        tint = RED;
        k = 0.6 * (1 - (now - m.hurtAt) / HURT_MS) + 0.2;
      } else if (burning) {
        tint = FIRE;
        k = 0.25 + 0.15 * Math.sin(now / 70 + m.id);
      }
      drawModel(b, parts, { pos, yaw: a.yaw, swing, tint, tintAmount: k });
      if (burning && emitFire)
        this.particles.push({
          p: [pos[0] + (Math.random() - 0.5) * 0.5, pos[1] + Math.random() * 1.8, pos[2] + (Math.random() - 0.5) * 0.5],
          v: [(Math.random() - 0.5) * 0.3, 1 + Math.random() * 0.8, (Math.random() - 0.5) * 0.3],
          life: 0,
          max: 0.35 + Math.random() * 0.3,
          size: 0.08 + Math.random() * 0.08,
          color: FLAMES[(Math.random() * 3) | 0],
          gravity: 0,
        });
    }
    for (const id of this.anim.keys()) if (!this.tracker.mobs.has(id)) this.anim.delete(id);
    // Particles.
    let w = 0;
    for (const p of this.particles) {
      p.life += dt;
      if (p.life >= p.max) continue;
      p.v[1] += p.gravity * dt;
      for (let i = 0; i < 3; i++) p.p[i] += p.v[i] * dt;
      const f = 1 - p.life / p.max;
      drawCube(b, p.p, p.size * (0.4 + 0.6 * f), p.color);
      this.particles[w++] = p;
    }
    this.particles.length = w;
    b.end();
  }

  dispose() {
    this.batch.dispose();
  }
}
