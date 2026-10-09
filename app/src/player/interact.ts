// Interaction (Task 26): what the crosshair targets and what the mouse does with it.
//
// - Target: a voxel DDA from the (interpolated) camera along the view direction, plus a
//   ray hit-test against the mob boxes decoded from loaded chunk headers; the nearer wins.
//   Only targets the program would accept are highlighted: blocks within reach of the eye
//   at the **onchain** position (`MoveSync.prevState`, the program's rule: center ≤ reach +
//   0.5), mobs within melee reach (3 + 0.5 to the mob column).
// - Left mouse (held): mine the targeted block. Progress runs over `break_time_ms(block,
//   held tool)` (core wasm) and is gated by the onchain cooldown (`break_until_ms`, plus a
//   local guard after each break: the program sets `break_until = now + time of the block
//   just broken`); when both are done `break_block` is sent and the block is removed
//   locally at once (store overlay; restored + re-read on failure; `Cooldown` → silent
//   retry). Targeting a mob instead attacks it (`attack_mob`) whenever the attack cooldown
//   allows.
// - Right mouse: food in hand and food < 20 → `eat`; a block item → `place_block` on the
//   hit face if the client checks pass (`rules.placeError`: reach, replaceable target,
//   face-adjacent support, no overlap with the placer's onchain + local box or any fresh
//   presence entry); optimistic with rollback. Held: repeats every 250 ms.
// - The tool the program uses is the onchain `held_slot`: hotbar selections are sent as
//   `select_slot` (debounced, `SlotSelect`), and a break / attack first waits until the
//   onchain slot matches the local selection.
import * as THREE from "three";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  attackMobIx,
  breakBlockIx,
  craftIx,
  decodeMob,
  eatIx,
  GEN_DONE,
  MOB_SIZE,
  MOB_SLOTS,
  placeBlockIx,
  respawnIx,
  selectSlotIx,
  type PlayerStateAccount,
  type SendResult,
  type TxFailure,
  type V3,
  type WorldAccount,
} from "../chain";
import type { App } from "../state";
import { breakTimeMs, canHarvest, coreRecipes, simulateCraft } from "../wasm";
import type { ChunkStore } from "../world/store";
import type { WorldHandle } from "../world/world";
import { itemInfo, itemName } from "../ui/items";
import { BLOCK_NAMES } from "../world/blocks";
import type { PlayerSession } from "./controller";
import { placePresenceChunks, PresenceWatch } from "./presence";
import { blockInReach, FLUID, mobBox, mobInReach, nearestStation, pickMob, placeError, raycast, SOLID, type BlockHit, type MobRef } from "./rules";

/** Short player-facing messages for action failures (null = stay silent). */
const MESSAGES: Record<string, string | null> = {
  OutOfReach: "Too far away.",
  NotFaceAdjacent: "Needs a block to attach to.",
  SelfOverlap: "Someone is standing there.",
  InventoryFull: "Inventory full.",
  MissingInputs: "Missing ingredients.",
  MissingFuel: "The furnace needs fuel (coal or planks).",
  WrongStation: "Needs a crafting table or furnace within reach.",
  Unbreakable: "That can't be broken.",
  InvalidTarget: "Can't place there.",
  NotPlaceable: "That item can't be placed.",
  FoodFull: "You're not hungry.",
  NotFood: "That isn't edible.",
  EmptySlot: "Nothing in hand.",
  NotEnoughItems: "Not enough items.",
  BadSlot: "Invalid slot.",
  InvalidCount: "Invalid count.",
  UnknownRecipe: "Unknown recipe.",
  ChunkNotReady: "That chunk is still generating.",
  NoMob: null,
  Cooldown: null,
  Dead: null,
  NotDead: null,
};

/** A short message for a failed action (null: stay silent — cooldowns, a mob that just
 *  died, death itself). */
export function actionMessage(f: TxFailure, what: string): string | null {
  if (f.kind === "retry" || f.kind === "dead") return null;
  if (f.kind === "topup") return "Your player is out of SOL. Top it up, then retry.";
  if (f.kind === "renewSession") return "Your play session expired. Renew it, then retry.";
  if (f.kind === "timeout") return `${what} was not confirmed in time; it may still land.`;
  if (f.kind === "notReady") return MESSAGES.ChunkNotReady;
  if (f.kind === "send") return `${what} could not be sent. Check your connection.`;
  if (f.name && f.name in MESSAGES) return MESSAGES[f.name];
  return `${what} failed${f.name ? ` (${f.name})` : ""}.`;
}

// ---------------------------------------------------------------- held slot

/** Local hotbar selection + its onchain `held_slot` (`select_slot`, debounced). */
export class SlotSelect {
  selected = 0;
  /** Onchain held slot as far as we know (null until the first PlayerState). */
  chainHeld: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<boolean> | null = null;
  private seeded = false;
  onChange: ((slot: number) => void) | null = null;

  constructor(
    private readonly sendSelect: (slot: number) => Promise<SendResult>,
    readonly debounceMs = 150,
  ) {}

  /** Selects hotbar slot `i` (0..8) locally; the ix follows after the debounce. */
  select(i: number) {
    const s = ((i % 9) + 9) % 9;
    if (s === this.selected && this.seeded) return;
    this.seeded = true;
    this.selected = s;
    this.onChange?.(s);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync();
    }, this.debounceMs);
  }

  /** PlayerState `held_slot`; adopted while nothing is pending. The first one also seeds
   *  the local selection. */
  onPlayerState(held: number) {
    if (this.timer === null && !this.inflight) this.chainHeld = held;
    if (!this.seeded) {
      this.seeded = true;
      this.chainHeld = held;
      if (held < 9) {
        this.selected = held;
        this.onChange?.(held);
      } else this.select(0);
    }
  }

  /** Makes the onchain held slot equal the selection (sends now if needed); true if so. */
  async sync(): Promise<boolean> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.inflight) await this.inflight;
    const want = this.selected;
    if (this.chainHeld === want) return true;
    this.inflight = this.sendSelect(want).then((r) => {
      if (r.status === "confirmed") this.chainHeld = want;
      return r.status === "confirmed";
    });
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
    return this.chainHeld === this.selected;
  }

  dispose() {
    if (this.timer !== null) clearTimeout(this.timer);
  }
}

// ---------------------------------------------------------------- mobs

export type LiveMob = MobRef & { id: number };

/** Live mobs of every loaded, generated chunk (decoded headers, cached per chunk version). */
export class MobIndex {
  private cache = new Map<string, { version: number; mobs: LiveMob[] }>();
  constructor(private readonly store: WorldHandle["store"]) {}

  all(): LiveMob[] {
    const out: LiveMob[] = [];
    const seen = new Set<string>();
    for (const e of this.store.entries()) {
      seen.add(e.key);
      if (!e.data || e.genStage !== GEN_DONE) continue;
      let c = this.cache.get(e.key);
      if (!c || c.version !== e.version) {
        const mobs: LiveMob[] = [];
        for (let i = 0; i < MOB_SLOTS; i++) {
          const m = decodeMob(e.data, 364 + MOB_SIZE * i);
          if (m.kind !== 0 && m.hp > 0) mobs.push({ cx: e.cx, cz: e.cz, idx: i, kind: m.kind, hp: m.hp, pos: m.pos, id: m.id });
        }
        c = { version: e.version, mobs };
        this.cache.set(e.key, c);
      }
      out.push(...c.mobs);
    }
    for (const k of this.cache.keys()) if (!seen.has(k)) this.cache.delete(k);
    return out;
  }
}

// ---------------------------------------------------------------- optimistic edits

export type EditStore = Pick<ChunkStore, "setLocal" | "clearLocal" | "revertLocal">;

/** Writes `block` at `at` locally, sends the edit, and settles the local write: kept (then
 *  dropped from the overlay) when confirmed, reverted + re-read on failure. A `retry`
 *  failure (`Cooldown`: the previous break's `break_until` hasn't passed onchain) is
 *  re-sent every `retryMs`, at most `maxRetries` times, with the local write kept. Null
 *  if the chunk isn't ready locally (nothing sent). */
export async function optimisticEdit(o: {
  store: EditStore;
  at: V3;
  block: number;
  send: () => Promise<SendResult>;
  retryMs?: number;
  maxRetries?: number;
  onRetry?: () => void;
}): Promise<SendResult | null> {
  const [x, y, z] = o.at;
  const ed = o.store.setLocal(x, y, z, o.block);
  if (!ed) return null;
  for (let tries = 0; ; tries++) {
    const r = await o.send();
    if (r.status === "confirmed") {
      o.store.clearLocal(x, y, z, ed.seq);
      return r;
    }
    if (r.status === "failed" && r.error.kind === "retry" && tries < (o.maxRetries ?? MAX_COOLDOWN_RETRIES)) {
      o.onRetry?.();
      await new Promise((res) => setTimeout(res, o.retryMs ?? COOLDOWN_RETRY_MS));
      continue;
    }
    o.store.revertLocal(x, y, z, ed.seq, ed.old);
    return r;
  }
}

// ---------------------------------------------------------------- interaction

export type Target = { kind: "block"; hit: BlockHit; inReach: boolean } | { kind: "mob"; mob: LiveMob; dist: number; inReach: boolean };

export type InteractUi = {
  toast(msg: string, kind?: "info" | "warn"): void;
  /** Mining progress 0..1 (null = hide). */
  progress(frac: number | null): void;
  /** What the crosshair is on (null = nothing in reach). */
  target(label: string | null): void;
  onDead(): void;
};

export type InteractDeps = {
  app: App;
  view: WorldHandle;
  session: PlayerSession;
  world: PublicKey;
  account: WorldAccount;
  flags: Uint8Array;
  ui: InteractUi;
  /** Latest PlayerState (decoded) + its 216 inventory bytes. */
  state: () => { s: PlayerStateAccount; inv: Uint8Array } | null;
};

type Mining = { key: string; block: V3; id: number; item: number; start: number; time: number };

const RIGHT_REPEAT_MS = 250;
const COOLDOWN_RETRY_MS = 60;
const MAX_COOLDOWN_RETRIES = 20;

export type InteractStats = {
  breaks: number;
  breakFailures: number;
  cooldownRetries: number;
  places: number;
  placeFailures: number;
  placeBlockedLocally: Record<string, number>;
  attacks: number;
  eats: number;
  crafts: number;
};

export class Interaction {
  readonly select: SlotSelect;
  readonly presence: PresenceWatch;
  readonly mobs: MobIndex;
  target: Target | null = null;
  /** Input blocked (inventory open, dead). */
  blocked = false;
  readonly stats: InteractStats = { breaks: 0, breakFailures: 0, cooldownRetries: 0, places: 0, placeFailures: 0, placeBlockedLocally: {}, attacks: 0, eats: 0, crafts: 0 };

  private buttons = { left: false, right: false };
  private virtual = { left: 0, right: 0 };
  private rightWas = false;
  private rightNext = 0;
  private mining: Mining | null = null;
  /** Chain-time lower bounds for the next break / attack (from our own sends). */
  private breakGuard = 0;
  private attackGuard = 0;
  private breaking = new Set<string>();
  private attacking = false;
  private eating = false;
  private pendingPlace = new Map<number, number>();
  private readonly outline: THREE.LineSegments;
  private readonly mobOutline: THREE.LineSegments;
  private off: (() => void)[] = [];
  private lastToast = { msg: "", at: 0 };

  constructor(readonly d: InteractDeps) {
    const { app, world } = d;
    this.select = new SlotSelect((slot) => this.send(() => selectSlotIx(app.program, app.auth(), world, slot), { key: "select" }));
    this.presence = new PresenceWatch(app.conns.er, app.cfg.programId, world);
    this.mobs = new MobIndex(d.view.store);

    const edges = (w: number, h: number) => new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, w));
    this.outline = new THREE.LineSegments(edges(1.004, 1.004), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 }));
    this.mobOutline = new THREE.LineSegments(edges(1, 1), new THREE.LineBasicMaterial({ color: 0xff4040, transparent: true, opacity: 0.9 }));
    this.outline.visible = this.mobOutline.visible = false;
    d.view.renderer.scene.add(this.outline, this.mobOutline);

    const canvas = d.view.renderer.canvas;
    const on = <E extends Event>(t: EventTarget, type: string, f: (e: E) => void) => {
      t.addEventListener(type, f as EventListener);
      this.off.push(() => t.removeEventListener(type, f as EventListener));
    };
    on<MouseEvent>(canvas, "mousedown", (e) => {
      if (!d.session.controller.locked) return; // the first click only captures the mouse
      if (e.button === 0) this.buttons.left = true;
      if (e.button === 2) this.buttons.right = true;
      e.preventDefault();
    });
    on<MouseEvent>(window, "mouseup", (e) => {
      if (e.button === 0) this.buttons.left = false;
      if (e.button === 2) this.buttons.right = false;
    });
    on(canvas, "contextmenu", (e) => e.preventDefault());
    on(document, "pointerlockchange", () => {
      if (!d.session.controller.locked) this.buttons = { left: false, right: false };
    });
    on(window, "blur", () => (this.buttons = { left: false, right: false }));
  }

  private get chainNow() {
    return this.d.session.clock.now();
  }

  private send(build: () => Promise<TransactionInstruction>, opts: { key?: string } = {}): Promise<SendResult> {
    const s = this.d.app.state.sessionStale ? null : this.d.app.state.sender;
    if (!s) return Promise.resolve({ status: "failed", error: { kind: "renewSession", message: "No play session." } });
    return s.send(async () => [await build()], opts);
  }

  private toast(msg: string | null, kind: "info" | "warn" = "warn") {
    if (!msg) return;
    const now = performance.now();
    if (msg === this.lastToast.msg && now - this.lastToast.at < 1500) return;
    this.lastToast = { msg, at: now };
    this.d.ui.toast(msg, kind);
  }

  private fail(f: TxFailure, what: string) {
    if (f.kind === "dead") this.d.ui.onDead();
    this.toast(actionMessage(f, what));
  }

  /** Holds a virtual mouse button for `ms` (automation without pointer lock). */
  click(button: "left" | "right", ms = 100) {
    this.virtual[button] = performance.now() + ms;
  }

  private pressed(b: "left" | "right") {
    return this.buttons[b] || performance.now() < this.virtual[b];
  }

  private heldItem(): { slot: number; item: number; count: number } {
    const st = this.d.state();
    const slot = this.select.selected;
    const s = st?.s.inventory[slot];
    return s && s.count > 0 ? { slot, item: s.item, count: s.count } : { slot, item: 0, count: 0 };
  }

  // ------------------------------------------------------------ per frame

  /** Recomputes the target and runs the mouse actions (call after the camera update). */
  update() {
    const { session, view } = this.d;
    const prev = session.sync.prevState;
    const st = this.d.state();
    const dead = !st || st.s.health === 0 || session.sync.dead;
    if (!prev || dead || this.blocked || view.flying) {
      this.setTarget(null);
      this.mining = null;
      this.d.ui.progress(null);
      this.rightWas = this.pressed("right");
      return;
    }
    const cx = Math.floor(prev.pos[0] / 4096);
    const cz = Math.floor(prev.pos[2] / 4096);
    this.presence.setCenter(cx, cz);
    this.setTarget(this.computeTarget(prev.pos));

    const t = this.target;
    const now = performance.now();
    // Left: mine / attack.
    if (this.pressed("left") && t?.inReach) {
      if (t.kind === "mob") {
        this.mining = null;
        void this.attack(t.mob);
      } else this.mine(t.hit, now);
    } else this.mining = null;
    this.d.ui.progress(this.mining ? this.progressOf(this.mining, now) : null);

    // Right: use (edge, then repeat while held).
    const right = this.pressed("right");
    if (right && (!this.rightWas || now >= this.rightNext)) {
      this.rightNext = now + RIGHT_REPEAT_MS;
      void this.use(t);
    }
    this.rightWas = right;
  }

  private computeTarget(pos: V3): Target | null {
    const cam = this.d.view.renderer.camera;
    const o = cam.position;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const origin = [o.x, o.y, o.z];
    const d = [dir.x, dir.y, dir.z];
    const reach = this.d.account.params.reach;
    const maxDist = reach / 256 + 1.5;
    const store = this.d.view.store;
    const flags = this.d.flags;
    const hit = raycast(origin, d, maxDist, (x, y, z) => store.getBlock(x, y, z), (id) => id !== 0 && !(flags[id] & FLUID));
    const mob = pickMob(origin, d, Math.min(maxDist, hit?.dist ?? Infinity), this.mobs.all());
    if (mob) return { kind: "mob", mob: mob.mob, dist: mob.dist, inReach: mobInReach(pos, mob.mob.pos) };
    if (hit) return { kind: "block", hit, inReach: blockInReach(pos, hit.block, reach) };
    return null;
  }

  private setTarget(t: Target | null) {
    this.target = t;
    const show = t?.inReach ? t : null;
    this.outline.visible = show?.kind === "block";
    this.mobOutline.visible = show?.kind === "mob";
    if (show?.kind === "block") {
      const [x, y, z] = show.hit.block;
      this.outline.position.set(x + 0.5, y + 0.5, z + 0.5);
      this.d.ui.target(BLOCK_NAMES[show.hit.id] ?? null);
    } else if (show?.kind === "mob") {
      const { halfW, height } = mobBox(show.mob.kind);
      this.mobOutline.scale.set(halfW * 2, height, halfW * 2);
      this.mobOutline.position.set(show.mob.pos[0] / 256, show.mob.pos[1] / 256 + height / 2, show.mob.pos[2] / 256);
      this.d.ui.target(`${MOB_NAMES[show.mob.kind] ?? "Mob"} · ${show.mob.hp} HP`);
    } else this.d.ui.target(null);
  }

  // ------------------------------------------------------------ mining

  private progressOf(m: Mining, now: number) {
    const gate = this.gateLocal(now);
    const end = Math.max(m.start + m.time, gate);
    return end <= m.start ? 1 : Math.min(1, (now - m.start) / (end - m.start));
  }

  /** Local time at which the onchain break cooldown (and our guard) has passed. */
  private gateLocal(now: number) {
    const chain = this.chainNow;
    const until = Math.max(this.d.state()?.s.breakUntilMs ?? 0, this.breakGuard);
    return chain === null ? now : now + Math.max(0, until - chain);
  }

  private mine(hit: BlockHit, now: number) {
    const key = hit.block.join(",");
    const { item } = this.heldItem();
    const time = breakTimeMs(hit.id, item);
    if (!time) {
      this.mining = null;
      return;
    }
    if (!this.mining || this.mining.key !== key || this.mining.id !== hit.id || this.mining.item !== item)
      this.mining = { key, block: hit.block, id: hit.id, item, start: now, time };
    const m = this.mining;
    if (now - m.start < m.time || now < this.gateLocal(now) || this.breaking.has(key)) return;
    this.mining = null;
    void this.breakBlock(m);
  }

  private async breakBlock(m: Mining) {
    const { app, world, view } = this.d;
    const key = m.key;
    this.breaking.add(key);
    try {
      // The onchain tool must be the selected one first (drops, durability, next cooldown).
      if (!(await this.select.sync())) return this.toast("Couldn't switch tools; try again.");
      if (!canHarvest(m.id, m.item)) {
        // The cheapest pickaxe that would harvest it (only pickaxe blocks have a tier rule).
        const pick = [256, 257, 258, 259].find((t) => canHarvest(m.id, t));
        this.toast(`No drop: ${BLOCK_NAMES[m.id]} needs ${pick ? `a ${itemName(pick).toLowerCase()}` : "another tool"}.`, "info");
      }
      // The next break is gated from the moment this one is sent (`break_until = now +
      // this block's time` onchain); restored if the break fails for good.
      const guard = this.breakGuard;
      const chain = this.chainNow;
      if (chain !== null) this.breakGuard = Math.max(guard, chain + m.time);
      const r = await optimisticEdit({
        store: view.store,
        at: m.block,
        block: 0,
        send: () => this.send(() => breakBlockIx(app.program, app.auth(), world, m.block, view.store)),
        onRetry: () => this.stats.cooldownRetries++,
      });
      if (r?.status === "confirmed") this.stats.breaks++;
      else if (r) {
        this.stats.breakFailures++;
        this.breakGuard = guard;
        if (r.status === "failed") this.fail(r.error, "Breaking");
      }
    } finally {
      this.breaking.delete(key);
    }
  }

  // ------------------------------------------------------------ attack

  /** Attacks mob slot `mob.idx` of chunk `(mob.cx, mob.cz)`. Race (accepted): the ix names
   *  a slot, not a mob id — if the mob dies or moves to another chunk before the tx lands,
   *  the program answers `NoMob` (silent here), or hits whichever mob took that slot in the
   *  meantime if it is in reach too (slots are only reused by spawns / mobs walking in).
   *  The tool is the onchain held slot, synced first (`SlotSelect.sync`). */
  private async attack(mob: LiveMob) {
    const chain = this.chainNow;
    const st = this.d.state();
    if (this.attacking || chain === null || !st) return;
    if (chain < Math.max(st.s.attackUntilMs, this.attackGuard)) return;
    this.attacking = true;
    const { app, world } = this.d;
    try {
      if (!(await this.select.sync())) return;
      this.attackGuard = (this.chainNow ?? chain) + this.d.account.params.attackCooldownMs;
      const r = await this.send(() => attackMobIx(app.program, app.auth(), world, mob.cx, mob.cz, mob.idx));
      if (r.status === "confirmed") this.stats.attacks++;
      else if (r.status === "failed") {
        if (r.error.kind !== "retry") this.attackGuard = 0;
        this.fail(r.error, "Attack");
      }
    } finally {
      this.attacking = false;
    }
  }

  // ------------------------------------------------------------ use (right click)

  private async use(t: Target | null) {
    const st = this.d.state();
    if (!st) return;
    const held = this.heldItem();
    const info = itemInfo(held.item);
    if (!info) return;
    if (info.food >= 0) {
      if (st.s.food >= 20) return this.toast(MESSAGES.FoodFull, "info");
      return this.eat(held.slot);
    }
    if (info.block < 0 || t?.kind !== "block") return;
    const target: V3 = [t.hit.block[0] + t.hit.face[0], t.hit.block[1] + t.hit.face[1], t.hit.block[2] + t.hit.face[2]];
    if (!t.hit.face.some((v) => v !== 0)) return;
    const pending = this.pendingPlace.get(held.slot) ?? 0;
    if (held.count - pending <= 0) return;
    await this.place(target, held.slot, info.block);
  }

  private blockedLocally(err: string) {
    this.stats.placeBlockedLocally[err] = (this.stats.placeBlockedLocally[err] ?? 0) + 1;
    this.toast(MESSAGES[err] ?? `Can't place (${err}).`, "info");
  }

  private async place(target: V3, slot: number, block: number) {
    const { app, world, view, session } = this.d;
    const prev = session.sync.prevState;
    if (!prev) return;
    const local = session.controller.phys?.body.pos;
    const base = {
      target,
      block,
      empty: false,
      pos: prev.pos,
      reach: this.d.account.params.reach,
      get: (x: number, y: number, z: number) => view.store.getBlock(x, y, z),
      flags: this.d.flags,
    };
    // Cheap checks first (no presence needed), then against the fresh presence entries.
    let err = placeError({ ...base, others: local ? [local as V3] : [] });
    if (err) return this.blockedLocally(err);
    if (this.d.flags[block] & SOLID) {
      let entries;
      try {
        entries = await this.presence.fresh(placePresenceChunks(target[0], target[2]), this.chainNow);
      } catch {
        entries = null;
      }
      if (!entries) return this.toast("Couldn't check for players there; try again.");
      err = placeError({ ...base, others: [...(local ? [local as V3] : []), ...entries.map((e) => e.pos)] });
      if (err) return this.blockedLocally(err);
    }
    this.pendingPlace.set(slot, (this.pendingPlace.get(slot) ?? 0) + 1);
    try {
      const r = await optimisticEdit({
        store: view.store,
        at: target,
        block,
        send: () => this.send(() => placeBlockIx(app.program, app.auth(), world, target, slot, view.store)),
        maxRetries: 0,
      });
      if (r?.status === "confirmed") this.stats.places++;
      else if (r) {
        this.stats.placeFailures++;
        if (r.status === "failed") this.fail(r.error, "Placing");
      }
    } finally {
      const n = (this.pendingPlace.get(slot) ?? 1) - 1;
      if (n > 0) this.pendingPlace.set(slot, n);
      else this.pendingPlace.delete(slot);
    }
  }

  private async eat(slot: number) {
    if (this.eating) return;
    this.eating = true;
    const { app, world } = this.d;
    try {
      const r = await this.send(() => eatIx(app.program, app.auth(), world, slot));
      if (r.status === "confirmed") {
        this.stats.eats++;
        this.toast(`Ate ${itemName(this.d.state()?.s.inventory[slot]?.item ?? 0)}.`, "info");
      } else if (r.status === "failed") this.fail(r.error, "Eating");
    } finally {
      this.eating = false;
    }
  }

  // ------------------------------------------------------------ crafting / respawn

  /** Crafting stations within reach of the onchain position (nearest of each). */
  stations(): { table: V3 | null; furnace: V3 | null } {
    const prev = this.d.session.sync.prevState;
    if (!prev) return { table: null, furnace: null };
    const get = (x: number, y: number, z: number) => this.d.view.store.getBlock(x, y, z);
    const reach = this.d.account.params.reach;
    return { table: nearestStation(prev.pos, reach, 15, get), furnace: nearestStation(prev.pos, reach, 16, get) };
  }

  /** Sends `craft(recipe, count)` with the stations the recipe needs; resolves to the result. */
  async craft(recipe: number, count: number): Promise<SendResult> {
    const r = coreRecipes()[recipe];
    const st = this.stations();
    const { app, world } = this.d;
    // The core's craft on the current inventory first: craftable counts are not contiguous
    // (a consumed stack frees a slot), so a count below the maximum can still fail.
    const inv = this.d.state()?.inv;
    if (inv) {
      const sim = simulateCraft(inv, recipe, count, !!st.table, !!st.furnace);
      if (!sim.ok) {
        const error: TxFailure = { kind: "other", name: sim.error, message: `craft ×${count} would fail (${sim.error})` };
        this.toast(sim.error === "InventoryFull" ? `No room for ×${count}; try another count.` : actionMessage(error, "Crafting"));
        return { status: "failed", error };
      }
    }
    const res = await this.send(() =>
      craftIx(app.program, app.auth(), world, recipe, count, { table: r?.station === 1 ? st.table : null, furnace: r?.station === 2 ? st.furnace : null }),
    );
    if (res.status === "confirmed") this.stats.crafts++;
    else if (res.status === "failed") this.fail(res.error, "Crafting");
    return res;
  }

  /** `respawn` (death screen). */
  async respawn(): Promise<SendResult> {
    const { app, world } = this.d;
    const r = await this.send(() => respawnIx(app.program, app.auth(), world));
    if (r.status === "failed" && r.error.name !== "NotDead") this.toast(actionMessage(r.error, "Respawn"));
    return r;
  }

  dispose() {
    for (const f of this.off) f();
    this.off = [];
    this.select.dispose();
    this.presence.dispose();
    for (const o of [this.outline, this.mobOutline]) {
      this.d.view.renderer.scene.remove(o);
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }
}

export const MOB_NAMES: Record<number, string> = { 1: "Pig", 2: "Cow", 3: "Sheep", 4: "Zombie" };
