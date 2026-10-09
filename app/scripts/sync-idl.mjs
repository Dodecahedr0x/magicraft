// Copies the program IDL + TS types from `../target/{idl,types}` (written by `anchor build`)
// into `src/idl/`. The copies are committed, so the app builds without an `anchor build`;
// this refreshes them when a newer build exists (no-op if unchanged or `target/` is absent).
// Note: `pnpm test` at the root leaves a `localnet` build in `target/` (debug ixs, test VRF
// queue address in the IDL); the client overrides cluster addresses from its config.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const pairs = [
  ["../target/idl/magicraft.json", "src/idl/magicraft.json"],
  ["../target/types/magicraft.ts", "src/idl/magicraft.ts"],
];
for (const [from, to] of pairs) {
  const src = join(app, from);
  const dst = join(app, to);
  if (!existsSync(src)) {
    if (!existsSync(dst)) {
      console.error(`sync-idl: ${from} missing and no committed ${to}; run \`anchor build\``);
      process.exit(1);
    }
    continue;
  }
  const data = readFileSync(src);
  if (existsSync(dst) && readFileSync(dst).equals(data)) continue;
  writeFileSync(dst, data);
  console.log(`sync-idl: updated ${to}`);
}
