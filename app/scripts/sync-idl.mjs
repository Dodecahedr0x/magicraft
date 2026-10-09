// Program IDL + TS types: committed copies in `src/idl/`, source of truth `../target/{idl,types}`
// (written by `anchor build`; `pnpm test` at the root leaves a `localnet` build there: debug
// ixs, test VRF queue address — the client overrides cluster addresses from its config).
//
// - `node scripts/sync-idl.mjs --write` (`pnpm -C app sync-idl`): copy target → src/idl.
// - `node scripts/sync-idl.mjs` (pre-dev/build/test): only **warn** if they differ, never
//   overwrite (a stale or feature-specific `target/` must not silently change the client).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const write = process.argv.includes("--write");
const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const pairs = [
  ["../target/idl/magicraft.json", "src/idl/magicraft.json"],
  ["../target/types/magicraft.ts", "src/idl/magicraft.ts"],
];
for (const [from, to] of pairs) {
  const src = join(app, from);
  const dst = join(app, to);
  if (!existsSync(dst) && !write) {
    console.error(`sync-idl: ${to} missing; run \`pnpm -C app sync-idl\` after \`anchor build\``);
    process.exit(1);
  }
  if (!existsSync(src)) {
    if (write) {
      console.error(`sync-idl: ${from} missing; run \`anchor build\``);
      process.exit(1);
    }
    continue;
  }
  const data = readFileSync(src);
  if (existsSync(dst) && readFileSync(dst).equals(data)) continue;
  if (write) {
    writeFileSync(dst, data);
    console.log(`sync-idl: updated ${to}`);
  } else {
    console.warn(`sync-idl: WARNING ${to} differs from ${from}; run \`pnpm -C app sync-idl\` to update`);
  }
}
