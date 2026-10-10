// Day / night: sky color, sun + moon, directional light, ambient and fog from the World's
// `time_of_day_ms` / `day_length_secs`, plus the underwater look.
//
// Phase math mirrors the program: `time_of_day_ms` only moves when the day crank ticks
// (`World::advance_day`: by the chain time since `last_tick_ms`, at most
// `DAY_MAX_STEP_MS` per tick), and day is the **first half** of the cycle
// (`core::mobs::is_day`: `t % len < ceil(len / 2)` — zombies burn then). Between World
// updates the client estimates the time of day the same way the next tick would compute it
// (`estimateTimeOfDay`, chain clock), and the shown value slews toward that estimate so
// account updates never make the sun jump.
//
// The sun's elevation is `sin(2π · phase)`: it rises at phase 0 (= the instant `is_day`
// turns true), is highest at 0.25, sets at 0.5 (night starts) and the moon is highest at
// 0.75. Light / colors are smooth functions of that elevation, so dawn and dusk are a short
// twilight around the exact chain boundary.
import * as THREE from "three";
import type { WorldAccount } from "../chain";
import type { WorldRenderer } from "./renderer";

/** `state::DAY_MAX_STEP_MS` (= `STALE_MS`): the most one day tick advances, ms. */
export const DAY_MAX_STEP_MS = 10_000;

/** `core::mobs::is_day`: the first half of the cycle (`ceil(len / 2)` ms) is day. */
export function isDay(timeOfDayMs: number, dayLengthMs: number): boolean {
  if (dayLengthMs <= 0) return true;
  return timeOfDayMs % dayLengthMs < Math.ceil(dayLengthMs / 2);
}

/** The time of day the next day tick would store at chain time `chainMs` (null: unknown
 *  clock → the stored value). */
export function estimateTimeOfDay(w: Pick<WorldAccount, "timeOfDayMs" | "lastTickMs" | "params">, chainMs: number | null): number {
  const len = w.params.dayLengthSecs * 1000;
  if (len <= 0) return 0;
  const step = chainMs === null || w.lastTickMs <= 0 ? 0 : Math.min(DAY_MAX_STEP_MS, Math.max(0, chainMs - w.lastTickMs));
  return ((w.timeOfDayMs % len) + step) % len;
}

/** Signed shortest difference `a − b` on a circle of length `len`. */
export function wrapDiff(a: number, b: number, len: number): number {
  let d = (a - b) % len;
  if (d > len / 2) d -= len;
  if (d < -len / 2) d += len;
  return d;
}

type RGB = [number, number, number];

export type SkyState = {
  /** 0..1 position in the cycle (0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight). */
  phase: number;
  /** `is_day` (chain rule). */
  day: boolean;
  /** Sun elevation, −1..1 (`sin(2π · phase)`). */
  elevation: number;
  /** Unit vector toward the sun (the moon is opposite). */
  sunDir: RGB;
  /** 0 (night) .. 1 (full day). */
  daylight: number;
  /** sRGB 0..1 sky / fog color. */
  sky: RGB;
  /** Directional light: unit direction toward the light (sun or moon), intensity, linear color. */
  lightDir: RGB;
  light: number;
  lightColor: RGB;
  ambient: number;
  ambientColor: RGB;
  /** Star opacity 0..1. */
  stars: number;
};

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const DAY_SKY: RGB = [0.612, 0.78, 0.933]; // #9cc7ee
const NIGHT_SKY: RGB = [0.04, 0.06, 0.14];
const GLOW: RGB = [0.94, 0.6, 0.38];
/** Night floor of the ambient term (dark but playable). */
export const NIGHT_AMBIENT = 0.2;
export const DAY_AMBIENT = 0.6;
export const DAY_SUN = 0.55;
export const MOON = 0.12;

/** Sky / light state at `timeOfDayMs` of a `dayLengthMs` cycle. */
export function skyState(timeOfDayMs: number, dayLengthMs: number): SkyState {
  const len = dayLengthMs > 0 ? dayLengthMs : 1;
  const phase = (((timeOfDayMs % len) + len) % len) / len;
  const a = phase * 2 * Math.PI;
  const elevation = Math.sin(a);
  // Sun path: east (+x) → up → west (−x), tilted a little toward the south (+z).
  const sd: RGB = [Math.cos(a), elevation, 0.3];
  const n = Math.hypot(...sd);
  const sunDir: RGB = [sd[0] / n, sd[1] / n, sd[2] / n];
  const daylight = smooth(-0.18, 0.28, elevation);
  const glow = Math.exp(-((elevation / 0.16) ** 2)) * 0.6;
  const sky = mix(mix(NIGHT_SKY, DAY_SKY, daylight), GLOW, glow * (0.35 + 0.65 * Math.min(daylight * 2, 1)));
  const sun = DAY_SUN * smooth(-0.04, 0.22, elevation);
  const moon = MOON * smooth(0.04, -0.2, elevation);
  const up = sun >= moon;
  const lightDir: RGB = up ? sunDir : [-sunDir[0], -sunDir[1], -sunDir[2]];
  const sunColor = mix([1, 0.62, 0.38], [1, 0.97, 0.9], smooth(0, 0.35, elevation));
  return {
    phase,
    day: isDay(timeOfDayMs, dayLengthMs),
    elevation,
    sunDir,
    daylight,
    sky,
    lightDir,
    light: sun + moon,
    lightColor: up ? sunColor : [0.6, 0.7, 1],
    ambient: NIGHT_AMBIENT + (DAY_AMBIENT - NIGHT_AMBIENT) * daylight,
    ambientColor: mix([0.55, 0.62, 0.95], [1, 1, 1], daylight),
    stars: 1 - smooth(-0.25, 0.05, elevation),
  };
}

/** Underwater look: fog color (sRGB) and range, blocks. */
const WATER_FOG: RGB = [0.1, 0.28, 0.5];

export type SkySource = {
  /** The latest World account. */
  world(): Pick<WorldAccount, "timeOfDayMs" | "lastTickMs" | "params">;
  /** Chain-time estimate, ms (null: not calibrated yet). */
  now(): number | null;
};

/** Drives the renderer's sky, lights and fog every frame. */
export class Sky {
  /** Shown time of day, ms (slews toward the estimate). */
  shown: number | null = null;
  state: SkyState;
  /** Camera is inside water (set by the world each frame). */
  underwater = false;
  private readonly sunMesh: THREE.Mesh;
  private readonly moonMesh: THREE.Mesh;
  private readonly stars: THREE.Points;
  private readonly fogNear: number;
  private readonly fogFar: number;
  private readonly tmp = new THREE.Color();

  constructor(
    readonly renderer: WorldRenderer,
    public source: SkySource,
  ) {
    const fog = renderer.scene.fog as THREE.Fog;
    this.fogNear = fog.near;
    this.fogFar = fog.far;
    const disc = (color: number, size: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color, fog: false, depthWrite: false, transparent: true }));
      m.renderOrder = -10;
      m.frustumCulled = false;
      return m;
    };
    this.sunMesh = disc(0xfff2b0, 14);
    this.moonMesh = disc(0xdfe6ff, 9);
    // Stars: fixed random points on the upper sphere, rotating with the sky.
    const pts = new Float32Array(600 * 3);
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 600; i++) {
      const u = rnd() * 2 - 1;
      const t = rnd() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pts.set([r * Math.cos(t) * 100, u * 100, r * Math.sin(t) * 100], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, depthWrite: false }));
    this.stars.renderOrder = -11;
    this.stars.frustumCulled = false;
    renderer.scene.add(this.stars, this.sunMesh, this.moonMesh);
    this.state = skyState(0, 1);
  }

  /** Advances the shown time by `dt` seconds and applies it. */
  update(dt: number) {
    const w = this.source.world();
    const len = w.params.dayLengthSecs * 1000;
    if (len <= 0) return;
    const est = estimateTimeOfDay(w, this.source.now());
    if (this.shown === null) this.shown = est;
    else {
      const d = wrapDiff(est, this.shown + dt * 1000, len);
      // Far off (first anchor, long stall): jump; else converge within ~0.5 s.
      this.shown = Math.abs(d) > 5000 ? est : this.shown + dt * 1000 + d * Math.min(1, dt * 2);
      this.shown = ((this.shown % len) + len) % len;
    }
    this.apply(skyState(this.shown, len));
  }

  private apply(s: SkyState) {
    this.state = s;
    const r = this.renderer;
    const fog = r.scene.fog as THREE.Fog;
    const bg = r.scene.background as THREE.Color;
    const c = this.underwater ? WATER_FOG : s.sky;
    this.tmp.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
    bg.copy(this.tmp);
    fog.color.copy(this.tmp);
    fog.near = this.underwater ? 0.5 : this.fogNear;
    fog.far = this.underwater ? 14 : this.fogFar;
    r.setLight({
      dir: s.lightDir,
      intensity: s.light,
      color: s.lightColor,
      ambient: s.ambient * (this.underwater ? 0.8 : 1),
      ambientColor: s.ambientColor,
    });
    const cam = r.camera.position;
    const place = (m: THREE.Mesh, d: readonly number[], dist: number) => {
      m.position.set(cam.x + d[0] * dist, cam.y + d[1] * dist, cam.z + d[2] * dist);
      m.lookAt(cam);
    };
    place(this.sunMesh, s.sunDir, 90);
    place(this.moonMesh, s.sunDir.map((v) => -v), 90);
    this.sunMesh.visible = s.elevation > -0.15 && !this.underwater;
    this.moonMesh.visible = s.elevation < 0.15 && !this.underwater;
    this.stars.position.copy(cam);
    this.stars.rotation.z = s.phase * 2 * Math.PI;
    const sm = this.stars.material as THREE.PointsMaterial;
    sm.opacity = s.stars;
    this.stars.visible = s.stars > 0.02 && !this.underwater;
  }

  dispose() {
    for (const o of [this.sunMesh, this.moonMesh, this.stars]) {
      this.renderer.scene.remove(o);
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }
}
