import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { BoxBatch } from "./models";
import type { WorldRenderer } from "./renderer";

const fake = () => {
  const lit = new Set<THREE.ShaderMaterial>();
  const r = { scene: new THREE.Scene(), light: {}, registerLit: (m: THREE.ShaderMaterial) => (lit.add(m), m), unregisterLit: (m: THREE.ShaderMaterial) => lit.delete(m) };
  return { r: r as unknown as WorldRenderer, scene: r.scene, lit };
};

describe("BoxBatch", () => {
  it("grows on overflow (recreated, contents kept, logged once)", () => {
    const { r, scene, lit } = fake();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const b = new BoxBatch(r, 4, { name: "t" });
    const first = b.mesh;
    b.begin();
    const m = new THREE.Matrix4();
    for (let i = 0; i < 10; i++) b.box(m.makeTranslation(i, 0, 0), i / 10, 0, 0);
    b.end();
    expect(b.capacity).toBe(16);
    expect(b.mesh).not.toBe(first);
    expect(scene.children).toEqual([b.mesh]);
    expect(b.mesh.count).toBe(10);
    const out = new THREE.Matrix4();
    for (let i = 0; i < 10; i++) {
      b.mesh.getMatrixAt(i, out);
      expect(out.elements[12]).toBe(i);
    }
    expect(info).toHaveBeenCalledTimes(1);
    b.begin();
    for (let i = 0; i < 40; i++) b.box(m, 0, 0, 0);
    b.end();
    expect(b.capacity).toBe(64);
    expect(info).toHaveBeenCalledTimes(1);
    b.dispose();
    expect(lit.size).toBe(0);
    info.mockRestore();
  });
});
