// Free-fly debug camera until the player controller (Task 25): drag with the mouse to look,
// WASD to move, Space / Shift (or E / Q) up / down, Ctrl for speed. Keys are ignored while
// typing in a form field.
import type { PerspectiveCamera } from "three";

export class FlyCam {
  yaw = 0;
  pitch = -0.35;
  speed = 10;
  private keys = new Set<string>();
  private drag: { x: number; y: number } | null = null;
  private off: (() => void)[] = [];

  constructor(
    readonly camera: PerspectiveCamera,
    readonly el: HTMLElement,
  ) {
    const on = <K extends keyof WindowEventMap>(t: EventTarget, type: K, f: (e: WindowEventMap[K]) => void) => {
      t.addEventListener(type, f as EventListener);
      this.off.push(() => t.removeEventListener(type, f as EventListener));
    };
    const typing = (e: Event) => e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    on(window, "keydown", (e) => {
      if (typing(e) || e.metaKey) return;
      this.keys.add(e.code);
      if (e.code === "Space") e.preventDefault();
    });
    on(window, "keyup", (e) => this.keys.delete(e.code));
    on(window, "blur", () => this.keys.clear());
    on(el, "pointerdown", (e) => {
      if (e.button !== 0) return;
      this.drag = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    on(el, "pointermove", (e) => {
      if (!this.drag) return;
      this.yaw -= (e.clientX - this.drag.x) * 0.005;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - (e.clientY - this.drag.y) * 0.005));
      this.drag = { x: e.clientX, y: e.clientY };
    });
    on(el, "pointerup", () => (this.drag = null));
    on(el, "pointercancel", () => (this.drag = null));
  }

  setPosition(x: number, y: number, z: number) {
    this.camera.position.set(x, y, z);
    this.apply();
  }

  private apply() {
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
  }

  update(dt: number) {
    const k = this.keys;
    const f = (k.has("KeyW") ? 1 : 0) - (k.has("KeyS") ? 1 : 0);
    const s = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
    const u = (k.has("Space") || k.has("KeyE") ? 1 : 0) - (k.has("ShiftLeft") || k.has("ShiftRight") || k.has("KeyQ") ? 1 : 0);
    const v = this.speed * (k.has("ControlLeft") || k.has("ControlRight") ? 3 : 1) * dt;
    if (f || s || u) {
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      // Forward is −z rotated by yaw; right is +x rotated by yaw.
      this.camera.position.x += (-sin * f + cos * s) * v;
      this.camera.position.z += (-cos * f - sin * s) * v;
      this.camera.position.y += u * v;
    }
    this.apply();
  }

  dispose() {
    for (const f of this.off) f();
    this.off = [];
  }
}
