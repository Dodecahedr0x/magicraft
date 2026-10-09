import { defineConfig } from "vitest/config";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// @solana/web3.js, @anchor-lang/core and the MagicBlock SDK expect Node's `Buffer` (the SDK
// uses the global without importing it) and occasionally `process`/`global`: the polyfill
// plugin injects them into app and dependency code in dev and build. Vitest runs in Node
// (real `Buffer`), so the plugin is off there.
/** Packages only the lazily loaded MagicBlock SDK uses. */
const LAZY = ["@magicblock-labs/ephemeral-rollups-sdk", "@phala/dcap-qvl", "@peculiar/asn1-schema", "@peculiar/asn1-x509", "@peculiar/utils", "asn1js", "pvtsutils", "pvutils"];

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
    // Maps are written for debugging but not referenced from the served bundle.
    sourcemap: "hidden",
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      output: {
        // Stable vendor chunks (cache across app deploys). The MagicBlock SDK and its
        // exclusive deps stay out of them: it is lazy-loaded for top-ups (`player.ts`).
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (LAZY.some((p) => id.includes(`/node_modules/${p}/`))) return undefined;
          if (id.includes("/node_modules/three/")) return "three";
          return "vendor";
        },
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
