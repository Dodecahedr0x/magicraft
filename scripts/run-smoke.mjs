// Runs scripts/devnet-smoke.ts (TypeScript importing app/src/chain) with the app's Vite
// SSR module runner, so no extra TS runner dependency is needed:
//   SMOKE_WALLET=/path/to/throwaway.json node scripts/run-smoke.mjs
// Bare imports from scripts/ resolve against app/ (the root package has no web3.js);
// dependencies stay external (plain Node modules), as in Vite SSR.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "app");
const ANCHOR_SHIM = "\0anchor-shim";
const vite = await import(createRequire(join(app, "package.json")).resolve("vite"));
const server = await vite.createServer({
  root: app,
  configFile: false,
  logLevel: "warn",
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
  ssr: { noExternal: ["@anchor-lang/core"] },
  server: { middlewareMode: true, hmr: false, ws: false, fs: { allow: [root] } },
  plugins: [
    {
      // Node's CJS named-export detection misses some of @anchor-lang/core's exports (`BN`,
      // `utils`), which Vitest papers over with its interop: re-export them from the default.
      name: "anchor-interop",
      enforce: "pre",
      resolveId: (source) => (source === "@anchor-lang/core" ? ANCHOR_SHIM : null),
      load: (id) =>
        id === ANCHOR_SHIM
          ? `import { createRequire } from "node:module";
const pkg = createRequire(${JSON.stringify(join(app, "package.json"))})("@anchor-lang/core");
export default pkg;
export const { BN, utils, Program, LangErrorCode, LangErrorMessage } = pkg;`
          : null,
    },
    {
      name: "scripts-resolve-from-app",
      enforce: "pre",
      async resolveId(source, importer, opts) {
        if (!importer?.includes("/scripts/") || /^[./\0]/.test(source) || source.startsWith("node:")) return null;
        return this.resolve(source, join(app, "src/main.ts"), { ...opts, skipSelf: true });
      },
    },
  ],
});
const runner = vite.createServerModuleRunner(server.environments.ssr, { hmr: false });
try {
  await runner.import(join(root, "scripts/" + (process.env.SMOKE_ENTRY ?? "devnet-smoke.ts")));
} finally {
  await runner.close();
  await server.close();
}
