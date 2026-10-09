// Three.js world renderer: one scene, a perspective camera, sky-colored fog that hides the
// edge of the loaded area, ambient + one directional light (fed into the voxel shader;
// day/night arrives in Task 27), and three meshes per chunk (opaque, cutout, water).
//
// The voxel shader samples a `DataArrayTexture` (one layer per 16×16 tile, atlas.ts) at
// `fract(uv)` so greedy quads repeat their tile; `textureGrad` with the unwrapped uv keeps
// mip selection continuous across block seams.
import * as THREE from "three";
import { buildAtlas } from "./atlas";
import type { ChunkMesh, MeshArrays } from "./mesher";

export const SKY = "#9cc7ee";

const VERT = /* glsl */ `
attribute vec3 tuv;
attribute vec3 shade;
uniform float uAmbient;
uniform float uSun;
uniform vec3 uSunDir;
varying vec3 vTuv;
varying vec3 vShade;
varying float vLight;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vTuv = tuv;
  vShade = shade;
  vLight = uAmbient + uSun * max(dot(normal, uSunDir), 0.0);
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uAtlas;
uniform float uAlphaTest;
uniform float uOpacity;
varying vec3 vTuv;
varying vec3 vShade;
varying float vLight;
#include <fog_pars_fragment>
void main() {
  vec4 t = textureGrad(uAtlas, vec3(fract(vTuv.xy), vTuv.z), dFdx(vTuv.xy), dFdy(vTuv.xy));
  if (t.a < uAlphaTest) discard;
  gl_FragColor = vec4(t.rgb * vShade * vLight, uOpacity);
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
  readonly sun = new THREE.DirectionalLight(0xffffff, 0.55);
  readonly ambient = new THREE.AmbientLight(0xffffff, 0.6);
  private readonly atlas: THREE.DataArrayTexture;
  private readonly mats: { opaque: THREE.ShaderMaterial; cutout: THREE.ShaderMaterial; water: THREE.ShaderMaterial };
  private readonly light = { uAmbient: { value: 0.6 }, uSun: { value: 0.55 }, uSunDir: { value: new THREE.Vector3() } };
  private chunks = new Map<string, ChunkObj>();
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
    this.sun.position.set(0.45, 1, 0.3);
    this.scene.add(this.sun, this.ambient);

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
      water: this.material({ opacity: 0.72, transparent: true, side: THREE.DoubleSide }),
    };

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
  }

  private material(o: { alphaTest?: number; opacity?: number; transparent?: boolean; side?: THREE.Side }) {
    const uniforms = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      ...this.light,
      uAtlas: { value: this.atlas },
      uAlphaTest: { value: o.alphaTest ?? 0 },
      uOpacity: { value: o.opacity ?? 1 },
    };
    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      fog: true,
      transparent: !!o.transparent,
      depthWrite: !o.transparent,
      side: o.side ?? THREE.FrontSide,
    });
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

  render() {
    this.light.uAmbient.value = this.ambient.intensity;
    this.light.uSun.value = this.sun.intensity;
    this.light.uSunDir.value.copy(this.sun.position).normalize();
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
