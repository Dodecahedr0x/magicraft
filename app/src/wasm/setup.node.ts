// Vitest setup: Node can't fetch the wasm asset, so initialize the core from the file.
import { readFileSync } from "node:fs";
import { initCoreSync } from "./index";

initCoreSync(readFileSync(new URL("./pkg/core_bg.wasm", import.meta.url)));
