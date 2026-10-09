import { defineConfig } from "vitest/config";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// @solana/web3.js, @anchor-lang/core and the MagicBlock SDK expect Node's `Buffer` (the SDK
// uses the global without importing it) and occasionally `process`/`global`: the polyfill
// plugin injects them into app and dependency code in dev and build. Vitest runs in Node
// (real `Buffer`), so the plugin is off there.
export default defineConfig({
  plugins: process.env.VITEST
    ? []
    : [
        nodePolyfills({
          include: ["buffer"],
          globals: { Buffer: true, global: true, process: true },
        }),
      ],
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 2048,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
