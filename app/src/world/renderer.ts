// Three.js world renderer: one scene, a perspective camera, sky-colored fog that hides the
// edge of the loaded area, and three meshes per chunk (opaque, cutout, water). Lighting is
// shader uniforms shared by every material (`light`, `LIGHT_PARS`): ambient + one
// directional light (sun / moon, set by sky.ts) and up to 16 torch point lights (torches.ts).
// Water tops drift / ripple with `uTime`; torch flame pixels are emissive.
//
// The voxel shader samples a `DataArrayTexture` (one layer per 16×16 tile, atlas.ts) at
// `fract(uv)` so greedy quads repeat their tile; `textureGrad` with the unwrapped uv keeps
// mip selection continuous across block seams.
import * as THREE from "three";
import { buildAtlas } from "./atlas";
import { T } from "./blocks";
import type { ChunkMesh, MeshArrays } from "./mesher";

export const SKY = "#9cc7ee";

/** Max point lights (torches) fed to the shaders (uniform array size). */
export const MAX_TORCHES = 16;
/** Torch light quality: lights evaluated per fragment (`N_TORCHES` define; 0 = off). */
export const TORCH_QUALITIES = [0, 4, 8, 16] as const;
export type TorchQuality = (typeof TORCH_QUALITIES)[number];
/** Torch light reach, blocks. */
export const TORCH_RADIUS = 9;

/** Shared lighting GLSL: uniforms + `sceneLight(normal)` (ambient + one directional light,
 *  per vertex) and `torchLight(world pos, normal)` (≤ `N_TORCHES` point lights per
 *  fragment, a material define set by the torch quality; no occlusion — light passes
 *  through blocks). */
export const LIGHT_PARS = /* glsl */ `
uniform float uAmbient;
uniform vec3 uAmbientColor;
uniform float uSun;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec4 uTorch[${MAX_TORCHES}];
uniform int uTorchCount;
uniform float uTime;
vec3 sceneLight(vec3 n) {
  return uAmbient * uAmbientColor + uSun * uSunColor * max(dot(n, uSunDir), 0.0);
}
vec3 torchLight(vec3 p, vec3 n) {
#if N_TORCHES > 0
  float s = 0.0;
  for (int i = 0; i < N_TORCHES; i++) {
    if (i >= uTorchCount) break;
    vec3 d = uTorch[i].xyz - p;
    float d2 = dot(d, d);
    if (d2 >= ${(TORCH_RADIUS * TORCH_RADIUS).toFixed(1)}) continue;
    float dist = sqrt(d2);
    float a = 1.0 - dist / ${TORCH_RADIUS.toFixed(1)};
    s += a * (0.35 + 0.65 * a) * (0.55 + 0.45 * max(dot(n, d / max(dist, 1e-3)), 0.0)) * uTorch[i].w;
  }
  return s * vec3(1.35, 1.0, 0.62);
#else
  return vec3(0.0);
#endif
}`;

const VERT = /* glsl */ `
attribute vec3 tuv;
attribute vec3 shade;
${LIGHT_PARS}
varying vec3 vTuv;
varying vec3 vShade;
varying vec3 vLight;
varying vec3 vWorld;
varying vec3 vNormal;
#include <fog_pars_vertex>
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  vTuv = tuv;
  vShade = shade;
  vWorld = world.xyz;
  vNormal = normal;
  vLight = sceneLight(normal);
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uAtlas;
uniform float uAlphaTest;
uniform float uOpacity;
uniform float uWave;
${LIGHT_PARS}
varying vec3 vTuv;
varying vec3 vShade;
varying vec3 vLight;
varying vec3 vWorld;
varying vec3 vNormal;
#include <fog_pars_fragment>
void main() {
  vec2 uv = vTuv.xy;
  float ripple = 1.0;
  bool surface = uWave > 0.5 && vNormal.y > 0.5;
  if (surface) {
    // Water surface: drifting, gently wobbling texture + a soft moving brightness ripple.
    uv += vec2(uTime * 0.04 + 0.05 * sin(uTime * 0.7 + vWorld.z * 0.4), uTime * 0.025 + 0.05 * cos(uTime * 0.6 + vWorld.x * 0.35));
    ripple = 1.0 + 0.07 * sin(uTime * 1.6 + vWorld.x * 1.3 + vWorld.z * 0.7) * sin(uTime * 1.1 - vWorld.z * 1.2);
  }
  vec4 t = textureGrad(uAtlas, vec3(fract(uv), vTuv.z), dFdx(vTuv.xy), dFdy(vTuv.xy));
  if (t.a < uAlphaTest) discard;
  vec3 light = min(vLight + torchLight(vWorld, vNormal), vec3(1.35));
  // Torch flame pixels (torch side / top tiles, bright orange) are emissive.
  if (vTuv.z > ${T.TORCH - 0.5} && vTuv.z < ${T.TORCH_TOP + 0.5} && t.r > 0.85) light = vec3(1.2);
  gl_FragColor = vec4(t.rgb * vShade * light * ripple, uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export type RenderStats = {
  fps: number;
  /** Average wall time between frames, ms. */
  frameMs: number;
  /** Average CPU time of `render()`, ms. */
  renderMs: number;
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  chunks: number;
};

type ChunkObj = { group: THREE.Group; meshes: THREE.Mesh[] };

export class WorldRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly atlas: THREE.DataArrayTexture;
  private readonly mats: { opaque: THREE.ShaderMaterial; cutout: THREE.ShaderMaterial; water: THREE.ShaderMaterial };
  /** Lighting uniforms shared by every voxel / model material (`LIGHT_PARS`). */
  readonly light = {
    uAmbient: { value: 0.6 },
    uAmbientColor: { value: new THREE.Vector3(1, 1, 1) },
    uSun: { value: 0.55 },
    uSunColor: { value: new THREE.Vector3(1, 1, 1) },
    uSunDir: { value: new THREE.Vector3(0.45, 1, 0.3).normalize() },
    uTorch: { value: Array.from({ length: MAX_TORCHES }, () => new THREE.Vector4()) },
    uTorchCount: { value: 0 },
    uTime: { value: 0 },
  };
  private chunks = new Map<string, ChunkObj>();
  /** Materials using `LIGHT_PARS` (their `N_TORCHES` define follows `torchQuality`). */
  private readonly lit = new Set<THREE.ShaderMaterial>();
  torchQuality: TorchQuality = 8;
  private raf = 0;
  private last = 0;
  private avgFrame = 16.7;
  private avgRender = 1;
  private ro: ResizeObserver;
  private frameCb: ((dt: number) => void) | null = null;

  constructor(readonly canvas: HTMLCanvasElement, opts: { viewBlocks?: number } = {}) {
    const view = opts.viewBlocks ?? 72;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, view * 0.6, view);
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, view * 2);

    const { data, size, layers } = buildAtlas();
    const tex = new THREE.DataArrayTexture(data, size, size, layers);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    this.atlas = tex;
    this.mats = {
      opaque: this.material({ alphaTest: 0 }),
      cutout: this.material({ alphaTest: 0.5, side: THREE.DoubleSide }),
      water: this.material({ opacity: 0.72, transparent: true, side: THREE.DoubleSide, wave: true }),
    };

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
  }

  private material(o: { alphaTest?: number; opacity?: number; transparent?: boolean; side?: THREE.Side; wave?: boolean }) {
    const uniforms = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      ...this.light,
      uAtlas: { value: this.atlas },
      uAlphaTest: { value: o.alphaTest ?? 0 },
      uOpacity: { value: o.opacity ?? 1 },
      uWave: { value: o.wave ? 1 : 0 },
    };
    return this.registerLit(
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: VERT,
        fragmentShader: FRAG,
        fog: true,
        transparent: !!o.transparent,
        depthWrite: !o.transparent,
        side: o.side ?? THREE.FrontSide,
      }),
    );
  }

  /** Tracks a `LIGHT_PARS` material (sets its `N_TORCHES` define). */
  registerLit<M extends THREE.ShaderMaterial>(m: M): M {
    m.defines = { ...m.defines, N_TORCHES: this.torchQuality };
    this.lit.add(m);
    return m;
  }
  unregisterLit(m: THREE.ShaderMaterial) {
    this.lit.delete(m);
  }

  /** Torch lights per fragment (0 = off); recompiles the lit materials. */
  setTorchQuality(q: TorchQuality) {
    if (q === this.torchQuality) return;
    this.torchQuality = q;
    for (const m of this.lit) {
      m.defines.N_TORCHES = q;
      m.needsUpdate = true;
    }
    if (this.light.uTorchCount.value > q) this.light.uTorchCount.value = q;
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ chunks

  private geometry(m: MeshArrays): THREE.BufferGeometry | null {
    if (!m.indices.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
    g.setAttribute("tuv", new THREE.BufferAttribute(m.uvs, 3));
    g.setAttribute("shade", new THREE.BufferAttribute(m.colors, 3, true));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    g.computeBoundingSphere();
    return g;
  }

  /** Replaces chunk `key`'s meshes (chunk-local block units, placed at `(cx·16, 0, cz·16)`). */
  setChunk(key: string, cx: number, cz: number, mesh: ChunkMesh) {
    this.removeChunk(key);
    const group = new THREE.Group();
    group.position.set(cx * 16, 0, cz * 16);
    group.name = `chunk ${key}`;
    const meshes: THREE.Mesh[] = [];
    (["opaque", "cutout", "water"] as const).forEach((k, i) => {
      const g = this.geometry(mesh[k]);
      if (!g) return;
      const m = new THREE.Mesh(g, this.mats[k]);
      m.renderOrder = i;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      group.add(m);
      meshes.push(m);
    });
    group.updateMatrixWorld(true);
    this.scene.add(group);
    this.chunks.set(key, { group, meshes });
  }

  removeChunk(key: string) {
    const c = this.chunks.get(key);
    if (!c) return;
    this.scene.remove(c.group);
    for (const m of c.meshes) m.geometry.dispose();
    this.chunks.delete(key);
  }

  hasChunk(key: string) {
    return this.chunks.has(key);
  }
  get chunkCount() {
    return this.chunks.size;
  }

  // ------------------------------------------------------------ loop

  /** Starts the render loop; `onFrame(dt seconds)` runs before each render. */
  start(onFrame?: (dt: number) => void) {
    this.frameCb = onFrame ?? null;
    if (this.raf) return;
    this.last = performance.now();
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      // Real frame time (≤ 2 s): physics catches up in full; longer stalls snap back.
      const dtMs = Math.min(2000, t - this.last);
      this.last = t;
      this.avgFrame += (dtMs - this.avgFrame) * 0.05;
      this.frameCb?.(dtMs / 1000);
      const t0 = performance.now();
      this.render();
      this.avgRender += (performance.now() - t0 - this.avgRender) * 0.05;
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Sets the directional + ambient light (sky.ts; colors linear). */
  setLight(l: { dir: readonly number[]; intensity: number; color: readonly number[]; ambient: number; ambientColor: readonly number[] }) {
    const u = this.light;
    u.uSunDir.value.set(l.dir[0], l.dir[1], l.dir[2]).normalize();
    u.uSun.value = l.intensity;
    u.uSunColor.value.set(l.color[0], l.color[1], l.color[2]);
    u.uAmbient.value = l.ambient;
    u.uAmbientColor.value.set(l.ambientColor[0], l.ambientColor[1], l.ambientColor[2]);
  }

  /** Sets the point lights: `[x, y, z, intensity]` (world block units), ≤ the quality. */
  setTorches(ts: readonly (readonly number[])[], count = ts.length) {
    const n = Math.min(count, ts.length, this.torchQuality);
    for (let i = 0; i < n; i++) this.light.uTorch.value[i].set(ts[i][0], ts[i][1], ts[i][2], ts[i][3]);
    this.light.uTorchCount.value = n;
  }

  render() {
    this.light.uTime.value = (performance.now() / 1000) % 3600;
    this.renderer.render(this.scene, this.camera);
  }

  stats(): RenderStats {
    const i = this.renderer.info;
    return {
      fps: Math.round(1000 / this.avgFrame),
      frameMs: +this.avgFrame.toFixed(2),
      renderMs: +this.avgRender.toFixed(2),
      calls: i.render.calls,
      triangles: i.render.triangles,
      geometries: i.memory.geometries,
      textures: i.memory.textures,
      chunks: this.chunks.size,
    };
  }

  dispose() {
    this.stop();
    this.ro.disconnect();
    for (const k of [...this.chunks.keys()]) this.removeChunk(k);
    for (const m of Object.values(this.mats)) m.dispose();
    this.atlas.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
