// Box models (mobs, other players, particles) drawn as one instanced mesh per batch: every
// box of every model is an instance of a unit cube (instance matrix + RGBA + pattern), so
// all mobs cost one draw call. The shader shares the voxel lighting (`LIGHT_PARS`: sky +
// torches + fog) and adds a per-pixel procedural texture (8 × 8 "pixels" per box face:
// noise, cow spots, wool tufts).
//
// Models face +z in model space with the feet at the origin; their footprint matches
// `rules.mobBox` (the hit boxes the interaction layer picks / outlines).
import * as THREE from "three";
import { LIGHT_PARS, type WorldRenderer } from "./renderer";

export const PATTERN = { NONE: 0, SPOTS: 1, WOOL: 2, FACE: 3 } as const;

const VERT = /* glsl */ `
attribute vec4 iColor;
attribute float iPattern;
${LIGHT_PARS}
varying vec4 vColor;
varying float vPattern;
varying vec3 vLight;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
#include <fog_pars_vertex>
void main() {
  vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vWorld = world.xyz;
  vNormal = n;
  vLocal = position;
  vColor = iColor;
  vPattern = iPattern;
  // Same face shading as the voxel mesher (top 1, sides 0.8 / 0.7, bottom 0.55).
  float face = n.y > 0.5 ? 1.0 : n.y < -0.5 ? 0.55 : abs(n.x) > abs(n.z) ? 0.8 : 0.7;
  vLight = sceneLight(n) * face;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
${LIGHT_PARS}
varying vec4 vColor;
varying float vPattern;
varying vec3 vLight;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
#include <fog_pars_fragment>
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  vec3 px = floor((vLocal + 0.5) * 8.0 - vNormal * 0.5);
  float h = hash(px);
  vec3 c = vColor.rgb * (0.9 + 0.2 * h);
  if (vPattern > 0.5 && vPattern < 1.5) {
    // Cow: big dark patches (coarse cells).
    if (hash(floor(px / 3.0) + 7.0) > 0.55) c = vec3(0.09, 0.07, 0.06) * (0.9 + 0.2 * h);
  } else if (vPattern > 1.5 && vPattern < 2.5) {
    c *= 0.88 + 0.24 * hash(floor(px / 2.0));
  }
  vec3 light = min(vLight + torchLight(vWorld, vNormal), vec3(1.35));
  gl_FragColor = vec4(c * light, vColor.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** One instanced batch of boxes, refilled every frame (`begin` → `box`… → `end`); grows
 *  (recreated at twice the capacity, logged once) when a frame needs more boxes. */
export class BoxBatch {
  mesh: THREE.InstancedMesh;
  private color!: THREE.InstancedBufferAttribute;
  private pattern!: THREE.InstancedBufferAttribute;
  private n = 0;
  private readonly mat: THREE.ShaderMaterial;
  private warned = false;

  constructor(
    private readonly renderer: WorldRenderer,
    public capacity = 1024,
    opts: { transparent?: boolean; name?: string } = {},
  ) {
    this.mat = renderer.registerLit(
      new THREE.ShaderMaterial({
        uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...renderer.light },
        vertexShader: VERT,
        fragmentShader: FRAG,
        fog: true,
        transparent: !!opts.transparent,
      }),
    );
    this.mesh = this.build(capacity);
    this.mesh.name = opts.name ?? "boxes";
    renderer.scene.add(this.mesh);
  }

  private build(capacity: number) {
    const g = new THREE.BoxGeometry(1, 1, 1);
    const color = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    const pattern = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    color.setUsage(THREE.DynamicDrawUsage);
    pattern.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("iColor", color);
    g.setAttribute("iPattern", pattern);
    const mesh = new THREE.InstancedMesh(g, this.mat, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.renderOrder = 3;
    this.color = color;
    this.pattern = pattern;
    return mesh;
  }

  /** Overflow: a mesh with twice the capacity, the boxes so far copied over. */
  private grow() {
    const old = this.mesh;
    const cap = this.capacity * 2;
    if (!this.warned) {
      this.warned = true;
      console.info(`[models] ${old.name}: ${this.capacity} boxes exceeded, growing to ${cap}`);
    }
    const [oc, op] = [this.color, this.pattern];
    const mesh = this.build(cap);
    (mesh.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    (this.color.array as Float32Array).set(oc.array as Float32Array);
    (this.pattern.array as Float32Array).set(op.array as Float32Array);
    mesh.name = old.name;
    mesh.renderOrder = old.renderOrder;
    this.renderer.scene.remove(old);
    old.geometry.dispose();
    old.dispose();
    this.renderer.scene.add(mesh);
    this.mesh = mesh;
    this.capacity = cap;
  }

  begin() {
    this.n = 0;
  }

  get size() {
    return this.n;
  }

  /** Adds a box (`m` maps the unit cube centered at the origin); linear RGB + alpha. */
  box(m: THREE.Matrix4, r: number, g: number, b: number, a = 1, pattern = 0) {
    if (this.n >= this.capacity) this.grow();
    const i = this.n++;
    this.mesh.setMatrixAt(i, m);
    this.color.setXYZW(i, r, g, b, a);
    this.pattern.setX(i, pattern);
  }

  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.color.needsUpdate = true;
    this.pattern.needsUpdate = true;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.renderer.unregisterLit(this.mat);
    this.mat.dispose();
    this.mesh.dispose();
  }
}

// ---------------------------------------------------------------- models

/** Limb animation of a part: legs / arms swing in opposite pairs. */
export type Swing = "none" | "legA" | "legB" | "armA" | "armB";

export type Part = {
  /** Size (x, y, z) in blocks. */
  size: [number, number, number];
  /** Pivot (hip / shoulder / neck) in model space, feet at the origin, facing +z. */
  pivot: [number, number, number];
  /** Box center relative to the pivot (before the swing rotation). */
  offset: [number, number, number];
  /** sRGB hex. */
  color: number;
  swing?: Swing;
  /** Fixed pitch (rad, about x) applied at the pivot (zombie arms forward). */
  pitch?: number;
  pattern?: number;
  /** Head: pitched by the model's look (unused for now). */
  head?: boolean;
};

const box = (size: Part["size"], center: [number, number, number], color: number, extra: Partial<Part> = {}): Part => ({ size, pivot: center, offset: [0, 0, 0], color, ...extra });
const leg = (size: Part["size"], hip: [number, number, number], color: number, swing: Swing, extra: Partial<Part> = {}): Part => ({ size, pivot: hip, offset: [0, -size[1] / 2, 0], color, swing, ...extra });

/** Humanoid (players, zombies): 0.78 wide with arms (body + legs 0.42 — the zombie's 0.6
 *  hit box holds all but the arms), 1.88 tall. */
export function humanoid(skin: number, shirt: number, pants: number, zombie: boolean): Part[] {
  const armPitch = zombie ? -Math.PI / 2 : 0;
  return [
    leg([0.21, 0.72, 0.22], [-0.105, 0.72, 0], pants, "legA"),
    leg([0.21, 0.72, 0.22], [0.105, 0.72, 0], pants, "legB"),
    box([0.42, 0.72, 0.24], [0, 1.08, 0], shirt),
    leg([0.18, 0.68, 0.2], [-0.3, 1.42, 0], zombie ? skin : shirt, "armB", { pitch: armPitch }),
    leg([0.18, 0.68, 0.2], [0.3, 1.42, 0], zombie ? skin : shirt, "armA", { pitch: armPitch }),
    box([0.44, 0.44, 0.44], [0, 1.66, 0], skin, { head: true }),
    // Eyes.
    box([0.09, 0.06, 0.02], [-0.1, 1.7, 0.225], zombie ? 0x1a1a1a : 0x2b3a67, { head: true }),
    box([0.09, 0.06, 0.02], [0.1, 1.7, 0.225], zombie ? 0x1a1a1a : 0x2b3a67, { head: true }),
  ];
}

/** Part lists per mob kind (`MOB`: 1 pig, 2 cow, 3 sheep, 4 zombie). */
export const MOB_MODELS: Record<number, Part[]> = {
  // Pig: hit box 0.9 × 0.9 (everything within ±0.45 in x / z, top 0.82).
  1: [
    leg([0.2, 0.3, 0.2], [-0.16, 0.3, 0.08], 0xe89a9a, "legA"),
    leg([0.2, 0.3, 0.2], [0.16, 0.3, 0.08], 0xe89a9a, "legB"),
    leg([0.2, 0.3, 0.2], [-0.16, 0.3, -0.32], 0xe89a9a, "legB"),
    leg([0.2, 0.3, 0.2], [0.16, 0.3, -0.32], 0xe89a9a, "legA"),
    box([0.56, 0.46, 0.6], [0, 0.53, -0.12], 0xf0a8a8),
    box([0.44, 0.42, 0.28], [0, 0.6, 0.29], 0xf0a8a8, { head: true }),
    box([0.22, 0.14, 0.04], [0, 0.54, 0.45], 0xe07f86, { head: true }),
    box([0.07, 0.07, 0.02], [-0.13, 0.7, 0.44], 0x202020, { head: true }),
    box([0.07, 0.07, 0.02], [0.13, 0.7, 0.44], 0x202020, { head: true }),
  ],
  // Cow: hit box 0.9 × 1.4.
  2: [
    leg([0.2, 0.6, 0.2], [-0.19, 0.6, 0.06], 0x3a2a20, "legA"),
    leg([0.2, 0.6, 0.2], [0.19, 0.6, 0.06], 0x3a2a20, "legB"),
    leg([0.2, 0.6, 0.2], [-0.19, 0.6, -0.33], 0x3a2a20, "legB"),
    leg([0.2, 0.6, 0.2], [0.19, 0.6, -0.33], 0x3a2a20, "legA"),
    box([0.62, 0.56, 0.62], [0, 0.88, -0.13], 0xf2efe8, { pattern: PATTERN.SPOTS }),
    box([0.42, 0.4, 0.28], [0, 1.1, 0.3], 0x4a3528, { head: true }),
    box([0.28, 0.15, 0.04], [0, 0.98, 0.45], 0xd9a8a0, { head: true }),
    box([0.07, 0.12, 0.07], [-0.24, 1.34, 0.3], 0xe8e2d0, { head: true }),
    box([0.07, 0.12, 0.07], [0.24, 1.34, 0.3], 0xe8e2d0, { head: true }),
    box([0.07, 0.07, 0.02], [-0.13, 1.18, 0.445], 0x111111, { head: true }),
    box([0.07, 0.07, 0.02], [0.13, 1.18, 0.445], 0x111111, { head: true }),
  ],
  // Sheep: hit box 0.9 × 1.3.
  3: [
    leg([0.18, 0.52, 0.18], [-0.17, 0.52, 0.06], 0xd8c8b0, "legA"),
    leg([0.18, 0.52, 0.18], [0.17, 0.52, 0.06], 0xd8c8b0, "legB"),
    leg([0.18, 0.52, 0.18], [-0.17, 0.52, -0.3], 0xd8c8b0, "legB"),
    leg([0.18, 0.52, 0.18], [0.17, 0.52, -0.3], 0xd8c8b0, "legA"),
    box([0.68, 0.6, 0.62], [0, 0.82, -0.12], 0xf4f2ec, { pattern: PATTERN.WOOL }),
    box([0.36, 0.36, 0.26], [0, 1.06, 0.29], 0xf4f2ec, { head: true, pattern: PATTERN.WOOL }),
    box([0.26, 0.24, 0.04], [0, 1.02, 0.43], 0xd8c8b0, { head: true }),
    box([0.06, 0.06, 0.02], [-0.07, 1.07, 0.45], 0x111111, { head: true }),
    box([0.06, 0.06, 0.02], [0.07, 1.07, 0.45], 0x111111, { head: true }),
  ],
  // Zombie: hit box 0.6 × 1.95.
  4: humanoid(0x5a8f4e, 0x2f8f9a, 0x3a3f8f, true),
};

const tmpM = new THREE.Matrix4();
const tmpP = new THREE.Matrix4();
const tmpS = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpV = new THREE.Vector3();
const tmpC = new THREE.Color();

/** Linear RGB of an sRGB hex color. */
export function linear(hex: number): [number, number, number] {
  tmpC.setHex(hex, THREE.SRGBColorSpace);
  return [tmpC.r, tmpC.g, tmpC.b];
}
const linCache = new Map<number, [number, number, number]>();
const lin = (hex: number) => {
  let c = linCache.get(hex);
  if (!c) linCache.set(hex, (c = linear(hex)));
  return c;
};

export type Pose = {
  /** Feet position, blocks. */
  pos: readonly number[];
  /** Rotation about y (rad); 0 faces +z. */
  yaw: number;
  /** Limb swing angle (rad). */
  swing: number;
  /** Tint toward `tint` color by `tintAmount` (hurt flash, fire). */
  tint?: readonly number[];
  tintAmount?: number;
  alpha?: number;
  /** Uniform scale (death shrink). */
  scale?: number;
};

/** Writes `parts` posed by `p` into `batch`. */
export function drawModel(batch: BoxBatch, parts: readonly Part[], p: Pose) {
  const s = p.scale ?? 1;
  tmpE.set(0, p.yaw, 0);
  tmpQ.setFromEuler(tmpE);
  const root = tmpM.compose(tmpV.set(p.pos[0], p.pos[1], p.pos[2]), tmpQ, tmpScale.set(s, s, s));
  const k = p.tintAmount ?? 0;
  for (const part of parts) {
    const sw = part.swing === "legA" || part.swing === "armA" ? p.swing : part.swing === "legB" || part.swing === "armB" ? -p.swing : 0;
    const ang = (part.pitch ?? 0) + (part.swing?.startsWith("arm") ? sw * 0.6 : sw);
    tmpE.set(ang, 0, 0);
    tmpQ.setFromEuler(tmpE);
    // root · T(pivot) · R(ang) · T(offset) · S(size)
    tmpP.compose(tmpV.set(part.pivot[0], part.pivot[1], part.pivot[2]), tmpQ, ONE);
    tmpS.makeTranslation(part.offset[0], part.offset[1], part.offset[2]);
    tmpP.multiply(tmpS);
    tmpS.makeScale(part.size[0], part.size[1], part.size[2]);
    tmpP.multiply(tmpS);
    tmpP.premultiply(root);
    const c = lin(part.color);
    const t = p.tint;
    const [r, g, b] = t && k > 0 ? [c[0] + (t[0] - c[0]) * k, c[1] + (t[1] - c[1]) * k, c[2] + (t[2] - c[2]) * k] : c;
    batch.box(tmpP, r, g, b, p.alpha ?? 1, part.pattern ?? 0);
  }
}
const ONE = new THREE.Vector3(1, 1, 1);
const tmpScale = new THREE.Vector3();

/** A plain axis-aligned cube (particles): center, edge, linear color. */
export function drawCube(batch: BoxBatch, c: readonly number[], size: number, color: readonly number[], alpha = 1) {
  tmpP.makeScale(size, size, size).setPosition(c[0], c[1], c[2]);
  batch.box(tmpP, color[0], color[1], color[2], alpha);
}
