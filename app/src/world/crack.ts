// Mining progress on the block itself: a crack texture over the block being mined, in 10
// stages like Minecraft's. The cracks are procedural (seeded random walks out from the
// center, so each stage extends the previous one) — no external assets.
import * as THREE from "three";
import { TILE } from "./atlas";

export const CRACK_STAGES = 10;

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reveal order of every crack pixel (0..1, lower shows earlier; −1 = never), 16×16 rows
 *  top-down. Branches wander out from near the center; later branches start later. */
export function crackOrder(seed = 7): Float32Array {
  const order = new Float32Array(TILE * TILE).fill(-1);
  const r = rng(seed);
  const branches = 7;
  for (let b = 0; b < branches; b++) {
    let x = 6 + r() * 4;
    let y = 6 + r() * 4;
    let ang = (b / branches) * Math.PI * 2 + r() * 0.8;
    const len = 6 + Math.floor(r() * 6);
    const start = (b / branches) * 0.45;
    for (let i = 0; i < len; i++) {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      if (xi < 0 || yi < 0 || xi >= TILE || yi >= TILE) break;
      const o = start + (1 - start) * (i / len) * 0.95;
      const k = yi * TILE + xi;
      if (order[k] < 0 || o < order[k]) order[k] = o;
      ang += (r() - 0.5) * 1.1;
      x += Math.cos(ang);
      y += Math.sin(ang);
    }
  }
  return order;
}

/** RGBA pixels of stage `s` (0..CRACK_STAGES−1), rows bottom-up (texture t axis up). */
export function crackPixels(order: Float32Array, s: number): Uint8Array {
  const out = new Uint8Array(TILE * TILE * 4);
  const shown = (s + 1) / CRACK_STAGES;
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      const v = order[y * TILE + x];
      if (v < 0 || v > shown) continue;
      const o = ((TILE - 1 - y) * TILE + x) * 4;
      // Darker toward the crack's origin (it has been open longer).
      out[o + 3] = Math.round(255 * (0.55 + 0.3 * (1 - v)));
    }
  return out;
}

export class CrackOverlay {
  private readonly mesh: THREE.Mesh;
  private readonly mats: THREE.MeshBasicMaterial[];
  private stage = -1;

  constructor(private readonly scene: THREE.Scene) {
    const order = crackOrder();
    this.mats = Array.from({ length: CRACK_STAGES }, (_, s) => {
      const tex = new THREE.DataTexture(crackPixels(order, s), TILE, TILE, THREE.RGBAFormat);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.needsUpdate = true;
      return new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        // Drawn on the block's faces: pull it toward the camera to win the depth test.
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
      });
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1.002, 1.002, 1.002), this.mats[0]);
    this.mesh.name = "crack";
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** Shows the crack of mining progress `frac` (0..1) on `block`; null hides it. */
  set(block: readonly number[] | null, frac = 0) {
    if (!block) {
      this.mesh.visible = false;
      return;
    }
    const s = Math.max(0, Math.min(CRACK_STAGES - 1, Math.floor(frac * CRACK_STAGES)));
    if (s !== this.stage) {
      this.stage = s;
      this.mesh.material = this.mats[s];
    }
    this.mesh.position.set(block[0] + 0.5, block[1] + 0.5, block[2] + 0.5);
    this.mesh.visible = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    for (const m of this.mats) {
      m.map?.dispose();
      m.dispose();
    }
  }
}
