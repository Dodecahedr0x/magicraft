// The committed wasm (src/wasm/pkg) must be built from the current core sources: recompute
// crates/core-wasm/build.rs's hash (FNV-1a 64 over `path \0 bytes \0`, sorted paths relative
// to crates/) and compare with the one compiled into the wasm.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_WORLD_PARAMS, GROUND_HALF_W, LEAD_MS } from "../chain/layout";
import { coreSrcHash, physicsConstants } from ".";

const crates = fileURLToPath(new URL("../../../crates/", import.meta.url));

function walk(dir: string, out: string[]) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
}

function srcHash(): string {
  const files = [join(crates, "core/Cargo.toml")];
  walk(join(crates, "core/src"), files);
  walk(join(crates, "core-wasm/src"), files);
  const rel = files.map((p) => [relative(crates, p).split(sep).join("/"), p] as const);
  // Rust sorts the String by bytes (UTF-8); paths here are ASCII.
  rel.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const M = (1n << 64n) - 1n;
  let h = 0xcbf29ce484222325n;
  const feed = (b: Uint8Array) => {
    for (const x of b) h = ((h ^ BigInt(x)) * 0x100000001b3n) & M;
  };
  for (const [r, p] of rel) {
    feed(new TextEncoder().encode(r));
    feed(Uint8Array.of(0));
    feed(readFileSync(p));
    feed(Uint8Array.of(0));
  }
  return h.toString(16).padStart(16, "0");
}

describe("core wasm", () => {
  it("is built from the current core sources (else run `pnpm -C app build:wasm`)", () => {
    expect(coreSrcHash(), "src/wasm/pkg is stale: run `pnpm -C app build:wasm` and commit it").toBe(srcHash());
  });

  it("client constants match the core", () => {
    const [, , , groundHalfW, , lead] = physicsConstants();
    expect(groundHalfW).toBe(GROUND_HALF_W);
    expect(lead).toBe(LEAD_MS);
    expect(DEFAULT_WORLD_PARAMS.walkSpeed).toBe(1101);
  });
});
