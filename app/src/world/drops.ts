// Ground items (the drops of broken blocks, stored onchain in the chunk accounts): drawn
// floating where the block was, bobbing and spinning like Minecraft's dropped items.
// - Block items: a quarter-size cube textured from the block atlas (the chunks' cutout
//   material, so day / night and torch light apply).
// - Other items (coal, diamonds, …): the 16×16 item sprite extruded into one-pixel boxes
//   (a `BoxBatch`, lit too).
// - An item being picked up flies to the player and shrinks (`collecting`), then hides.
import * as THREE from "three";
import type { GroundItem } from "../chain";
import { itemInfo, itemSprite } from "../ui/items";
import { FACE_TILES } from "./blocks";
import { BoxBatch } from "./models";
import type { WorldRenderer } from "./renderer";

/** A ground item to draw: chunk-unique `key` (`cx,cz:idx`). */
export type ShownItem = GroundItem & { key: string };

/** Edge of a dropped block cube / a sprite item, blocks. */
const CUBE = 0.25;
const SPRITE = 0.4;
/** Items farther than this from the camera are not drawn, blocks. */
const DRAW_DIST = 40;
/** Pickup flight duration, ms. */
export const FLY_MS = 180;

/** Cube geometry of block `b`: `BoxGeometry` faces are +x, −x, +y, −y, +z, −z, the same
 *  order as `FACE_TILES`. */
function blockGeometry(b: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const uv = g.getAttribute("uv");
  const n = uv.count;
  const tuv = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    tuv[i * 3] = uv.getX(i);
    tuv[i * 3 + 1] = uv.getY(i);
    tuv[i * 3 + 2] = FACE_TILES[b * 6 + Math.floor(i / 4)];
  }
  g.setAttribute("tuv", new THREE.BufferAttribute(tuv, 3));
  g.setAttribute("shade", new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  return g;
}

type Pixel = { x: number; y: number; rgb: [number, number, number] };

/** The opaque pixels of item `id`'s sprite (x, y centered, in pixels; linear rgb). */
function spritePixels(id: number): Pixel[] {
  const px = itemSprite(id, itemInfo(id));
  const out: Pixel[] = [];
  const lin = (v: number) => Math.pow(v / 255, 2.2);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const o = (y * 16 + x) * 4;
      if (px[o + 3] < 128) continue;
      out.push({ x: x - 7.5, y: 7.5 - y, rgb: [lin(px[o]), lin(px[o + 1]), lin(px[o + 2])] });
    }
  return out;
}

const tmpM = new THREE.Matrix4();
const tmpP = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpK = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

export class GroundLayer {
  private readonly geoms = new Map<number, THREE.BufferGeometry>();
  private readonly pixels = new Map<number, Pixel[]>();
  private readonly cubes = new Map<string, THREE.Mesh>();
  private readonly batch: BoxBatch;
  private readonly group = new THREE.Group();

  constructor(private readonly renderer: WorldRenderer) {
    this.group.name = "ground items";
    renderer.scene.add(this.group);
    this.batch = new BoxBatch(renderer, 256, { name: "ground item sprites" });
  }

  /** Draws `items` at time `t` (ms); `collecting`: key → pickup start (ms), flying to `to`. */
  update(items: readonly ShownItem[], t: number, collecting: ReadonlyMap<string, number>, to: THREE.Vector3) {
    const cam = this.renderer.camera.position;
    const seen = new Set<string>();
    this.batch.begin();
    for (const it of items) {
      const x = it.pos[0] / 256;
      const z = it.pos[2] / 256;
      if (Math.abs(x - cam.x) > DRAW_DIST || Math.abs(z - cam.z) > DRAW_DIST) continue;
      // Per-item phase so neighbors don't move in lockstep.
      const ph = (it.idx * 1.7 + it.pos[0] * 0.013 + it.pos[2] * 0.007) % (Math.PI * 2);
      const pos = tmpV.set(x, it.pos[1] / 256 + 0.12 + 0.07 * Math.sin(t / 450 + ph), z);
      let scale = 1;
      const start = collecting.get(it.key);
      if (start !== undefined) {
        const k = Math.min(1, (t - start) / FLY_MS);
        if (k >= 1) continue;
        pos.lerp(to, k * k);
        scale = 1 - 0.6 * k;
      }
      tmpQ.setFromAxisAngle(Y, t / 900 + ph);
      const info = itemInfo(it.item);
      if (info && info.block >= 0) {
        seen.add(it.key);
        let m = this.cubes.get(it.key);
        if (!m || m.userData.block !== info.block) {
          if (m) this.group.remove(m);
          m = new THREE.Mesh(this.geom(info.block), this.renderer.blockMaterial);
          m.userData.block = info.block;
          m.renderOrder = 1;
          this.cubes.set(it.key, m);
          this.group.add(m);
        }
        m.position.copy(pos).y += (CUBE / 2) * scale;
        m.quaternion.copy(tmpQ);
        m.scale.setScalar(CUBE * scale);
      } else this.sprite(it.item, pos, scale);
    }
    for (const [k, m] of this.cubes)
      if (!seen.has(k)) {
        this.group.remove(m);
        this.cubes.delete(k);
      }
    this.batch.end();
  }

  /** The extruded sprite of `item`, standing on `pos`, facing `tmpQ`. */
  private sprite(item: number, pos: THREE.Vector3, scale: number) {
    let px = this.pixels.get(item);
    if (!px) this.pixels.set(item, (px = spritePixels(item)));
    const s = (SPRITE / 16) * scale;
    tmpM.compose(tmpS.set(pos.x, pos.y + (SPRITE / 2) * scale, pos.z), tmpQ, tmpK.set(s, s, s));
    for (const p of px) {
      tmpP.makeTranslation(p.x, p.y, 0).premultiply(tmpM);
      this.batch.box(tmpP, p.rgb[0], p.rgb[1], p.rgb[2]);
    }
  }

  private geom(b: number) {
    let g = this.geoms.get(b);
    if (!g) this.geoms.set(b, (g = blockGeometry(b)));
    return g;
  }

  get count() {
    return this.cubes.size;
  }

  dispose() {
    this.renderer.scene.remove(this.group);
    for (const g of this.geoms.values()) g.dispose();
    this.geoms.clear();
    this.cubes.clear();
    this.batch.dispose();
  }
}
