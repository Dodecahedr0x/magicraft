// Regenerates the `layout.test.ts` fixture from the magicraft-core reference generator
// (`crates/core/examples/gen.rs`, the same binary `tests/helpers/chunk.ts` runs).
// Output format: see gen.rs (stage-1 blocks, biomes, final blocks, spawns, spawn point).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(app, "..");
export const FIXTURE_SEED = "6d61676963726166742d6669787475726500000000000000000000000000002a";
execFileSync("cargo", ["build", "--release", "-q", "-p", "magicraft-core", "--example", "gen"], {
  cwd: root,
  stdio: "inherit",
});
const bin = join(root, "target/release/examples/gen");
for (const [cx, cz] of [[0, 0]]) {
  const out = execFileSync(bin, [FIXTURE_SEED, String(cx), String(cz)], { maxBuffer: 1 << 20 });
  const file = join(app, `src/chain/__fixtures__/gen_${cx}_${cz}.bin`);
  writeFileSync(file, out);
  console.log(`wrote ${file} (${out.length} bytes)`);
}
