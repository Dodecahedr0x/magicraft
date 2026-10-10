// Create-world form (WorldParams in human units, ranges checked as the program does) and the
// setup pipeline: create_world (arms the day crank) → request_seed (retried while the seed is
// unset) → seed → create + grow (0,0) (gen tx) → populate → set_spawn. The pipeline reads
// the chain before each step, so it also resumes a world whose setup was interrupted.
import type { PublicKey } from "@solana/web3.js";
import {
  CHUNK_FULL_LEN,
  CHUNK_TOTAL_RENT,
  DEFAULT_WORLD_PARAMS,
  GEN_DONE,
  WORLD_LEN,
  chunkPda,
  createAndGrowIxs,
  createWorldIx,
  decodeWorld,
  ephemeralRent,
  freshNonce,
  measureUsPerSlot,
  populateChunkIx,
  requestSeedIx,
  setSpawnIx,
  viewOf,
  worldPda,
  type IxSource,
  type SendOptions,
  type WorldAccount,
  type WorldParams,
} from "../chain";
import type { App } from "../state";
import { busy, errText, h, sendResultMessage, sleep, sol, stepList } from "./dom";
import { PARAM_FIELDS, fromForm, jumpHeight, toForm, validateForm, validateName, type ParamField, type ParamForm } from "./params";

export const SETUP_STEPS = [
  "Create the world and start its day clock",
  "Request a random seed (VRF)",
  "Receive the seed",
  "Generate the spawn chunk (0, 0)",
  "Populate it: caves, ores, trees, animals",
  "Set the spawn point",
];

type Steps = ReturnType<typeof stepList>;

/** Sends through the session sender; throws a readable error on failure. */
async function send(app: App, src: IxSource, opts: SendOptions = {}): Promise<number> {
  const sender = app.state.sender;
  if (!sender) throw new Error("No play session. Start one first.");
  const r = await sender.send(src, opts);
  const msg = sendResultMessage(r);
  if (msg !== null || r.status !== "confirmed") throw new Error(msg ?? "Not confirmed.");
  return r.ms;
}

async function readWorld(app: App, world: PublicKey): Promise<WorldAccount | null> {
  const i = await app.conns.er.getAccountInfo(world, "confirmed");
  return i ? decodeWorld(i.data) : null;
}

async function until<T>(f: () => Promise<T | null | false | undefined>, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(100);
  }
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Runs (or resumes) world setup up to a set spawn. `create` is needed only if the World
 *  does not exist yet. Throws on the first failing step (marked `error`). */
export async function runSetup(
  app: App,
  world: PublicKey,
  steps: Steps,
  create: { nonce: bigint; name: string; params: WorldParams } | null,
): Promise<WorldAccount> {
  const pid = app.cfg.programId;
  const auth = app.auth();
  let i = 0;
  const step = async <T>(idx: number, run: () => Promise<T>): Promise<T> => {
    i = idx;
    steps.set(idx, "active");
    const t0 = performance.now();
    const v = await run();
    steps.set(idx, "done", secs(performance.now() - t0));
    return v;
  };
  try {
    let w0 = await readWorld(app, world);
    if (!w0) {
      if (!create) throw new Error("World not found.");
      w0 = await step(0, async () => {
        // The ER's slot rate seeds the World clock (devnet ERs run ~10 ms slots, not 50).
        steps.set(0, "active", "measuring the rollup's slot rate…");
        const hint = await measureUsPerSlot(app.conns.er);
        steps.set(0, "active");
        await send(app, async () => [await createWorldIx(app.program, auth, create.nonce, create.name, create.params, hint)]);
        const x = await until(() => readWorld(app, world), 5_000);
        if (!x) throw new Error("World not visible after creation.");
        return x;
      });
    } else steps.set(0, "done", "exists");
    let w: WorldAccount = w0;

    if (!w.seedSet) {
      for (let attempt = 1; !w.seedSet; attempt++) {
        if (attempt > 4) throw new Error("No seed after 4 requests. The VRF oracle may be down; retry later.");
        await step(1, () => send(app, async () => [await requestSeedIx(app.program, auth, world)]));
        if (attempt > 1) steps.set(1, "done", `attempt ${attempt}`);
        i = 2;
        steps.set(2, "active", "waiting for the oracle…");
        const t0 = performance.now();
        const seeded = await until(async () => {
          const x = await readWorld(app, world);
          return x?.seedSet ? x : null;
        }, 8_000);
        if (seeded) {
          w = seeded;
          steps.set(2, "done", secs(performance.now() - t0));
        } else steps.set(2, "pending", "no answer yet; requesting again");
      }
    } else {
      steps.set(1, "done", "already seeded");
      steps.set(2, "done");
    }

    const chunk = chunkPda(pid, world, 0, 0);
    const readChunk = async () => (await app.conns.er.getAccountInfo(chunk, "confirmed"))?.data ?? null;
    let c = await readChunk();
    if (!c) {
      await step(3, () => send(app, async () => createAndGrowIxs(app.program, auth, world, 0, 0, viewOf(new Set())), { gen: true }));
      c = await until(readChunk, 5_000);
    } else steps.set(3, "done", "exists");
    if (!c || c.length !== CHUNK_FULL_LEN) throw new Error("Chunk (0, 0) exists but was not generated.");

    if (c[82] !== GEN_DONE) await step(4, () => send(app, async () => [await populateChunkIx(app.program, world, 0, 0)], { gen: true }));
    else steps.set(4, "done", "already populated");

    if (!w.spawnSet) {
      await step(5, () => send(app, async () => [await setSpawnIx(app.program, world)]));
      const set = await until(async () => {
        const x = await readWorld(app, world);
        return x?.spawnSet ? x : null;
      }, 5_000);
      if (!set) throw new Error("The spawn point is not visible yet. Retry to check again.");
      w = set;
    } else steps.set(5, "done", "already set");
    return w;
  } catch (e) {
    steps.set(i, "error", errText(e));
    throw e;
  }
}

function field(d: ParamField, value: number, onInput: () => void) {
  const id = `p-${d.key}`;
  if (d.kind === "bool") {
    const input = h("input", { id, type: "checkbox", name: d.key, checked: value === 1 });
    input.addEventListener("change", onInput);
    return { row: h("div", { class: "field check" }, input, h("label", { for: id }, d.label)), input, err: null as HTMLElement | null };
  }
  const err = h("p", { id: `${id}-err`, class: "field-error", role: "alert" });
  const help = d.help ? h("p", { id: `${id}-help`, class: "field-help" }, d.help) : null;
  const input = h("input", {
    id,
    name: d.key,
    class: "input",
    type: "number",
    inputmode: "decimal",
    min: d.min,
    max: d.max,
    step: d.step,
    value,
    "aria-describedby": `${help ? `${id}-help ` : ""}${id}-err`,
  });
  input.addEventListener("input", onInput);
  const row = h(
    "div",
    { class: "field" },
    h("label", { for: id }, d.label, d.unit ? h("span", { class: "unit" }, ` ${d.unit}`) : null),
    input,
    help,
    err,
  );
  return { row, input, err };
}

/** The create-world panel. `onDone(world)` runs once its spawn is set ("Enter world"). */
export function createWorldPanel(app: App, onDone: (world: PublicKey) => void, onCancel: () => void, onReady?: (world: PublicKey) => void): HTMLElement {
  const defaults = toForm(DEFAULT_WORLD_PARAMS);
  const fields = new Map<ParamField["key"], ReturnType<typeof field>>();
  const name = h("input", { id: "world-name", class: "input", maxlength: 32, autocomplete: "off", value: "", placeholder: "e.g. Pine Hollow", "aria-describedby": "world-name-err" });
  const nameErr = h("p", { id: "world-name-err", class: "field-error", role: "alert" });
  const jumpNote = h("p", { class: "field-help" });
  const read = (): ParamForm => {
    const f = {} as ParamForm;
    for (const d of PARAM_FIELDS) {
      const x = fields.get(d.key)!.input;
      f[d.key] = d.kind === "bool" ? (x.checked ? 1 : 0) : x.value.trim() === "" ? NaN : Number(x.value);
    }
    return f;
  };
  const check = (show: boolean) => {
    const f = read();
    const errs = validateForm(f);
    for (const d of PARAM_FIELDS) {
      const fl = fields.get(d.key)!;
      const m = errs[d.key] ?? "";
      if (fl.err && (show || !m)) fl.err.textContent = m;
      if (m && show) fl.input.setAttribute("aria-invalid", "true");
      else if (!m) fl.input.removeAttribute("aria-invalid");
    }
    const jh = jumpHeight(f);
    jumpNote.textContent = Number.isFinite(jh) ? `Jump height ≈ ${jh} blocks.` : "";
    const ne = validateName(name.value);
    if (show || !ne) nameErr.textContent = ne ?? "";
    return { f, errs, nameError: ne };
  };
  const group = (g: ParamField["group"]) =>
    PARAM_FIELDS.filter((d) => d.group === g).map((d) => {
      const fl = field(d, defaults[d.key], () => check(false));
      fields.set(d.key, fl);
      return fl.row;
    });

  const movement = group("movement");
  const combat = group("combat");
  const worldG = group("world");
  const reset = h("button", { class: "btn ghost small", type: "button" }, "Reset to defaults");
  reset.addEventListener("click", () => {
    for (const d of PARAM_FIELDS) {
      const x = fields.get(d.key)!.input;
      if (d.kind === "bool") x.checked = defaults[d.key] === 1;
      else x.value = String(defaults[d.key]);
    }
    check(true);
  });

  const cost = ephemeralRent(WORLD_LEN) + CHUNK_TOTAL_RENT;
  const submit = h("button", { class: "btn primary", type: "submit" }, "Create world");
  const cancel = h("button", { class: "btn ghost", type: "button" }, "Cancel");
  cancel.addEventListener("click", onCancel);
  const formErr = h("p", { class: "form-error", role: "alert" });
  const form = h(
    "form",
    { class: "create-form", novalidate: true, "aria-labelledby": "create-title" },
    h("div", { class: "panel-head" }, h("h2", { id: "create-title" }, "New world"), cancel),
    h("div", { class: "field" }, h("label", { for: "world-name" }, "Name"), name, nameErr),
    h("fieldset", { class: "group" }, h("legend", {}, "Rules"), ...combat),
    h(
      "details",
      { class: "group" },
      h("summary", {}, "Physics and timing"),
      h("fieldset", { class: "plain" }, h("legend", { class: "sr-only" }, "Movement"), ...movement, jumpNote),
      h("fieldset", { class: "plain" }, h("legend", { class: "sr-only" }, "Timing"), ...worldG),
      reset,
    ),
    h("p", { class: "hint" }, `Your player pays ≈ ${sol(cost, 5)} SOL: the world (${sol(ephemeralRent(WORLD_LEN), 5)}) and its spawn chunk (${sol(CHUNK_TOTAL_RENT, 5)}). The settings are permanent.`),
    formErr,
    h("div", { class: "actions" }, submit),
  );
  check(false);

  const wrap = h("div", { class: "create" }, form);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const { f, errs, nameError } = check(true);
    const firstBad = nameError ? name : PARAM_FIELDS.map((d) => (errs[d.key] ? fields.get(d.key)!.input : null)).find(Boolean);
    if (firstBad) {
      // Open the collapsed group if the problem is inside it.
      const det = firstBad.closest("details");
      if (det) det.open = true;
      return firstBad.focus();
    }
    const params = fromForm(f);
    const nonce = freshNonce();
    const world = worldPda(app.cfg.programId, app.state.wallet!.publicKey, nonce);
    void busy(submit, "Creating…", () => progress(app, wrap, world, { nonce, name: name.value.trim(), params }, onDone, onReady));
  });
  return wrap;
}

/** Replaces `wrap`'s content with the setup progress for `world` and runs it. */
export async function progress(
  app: App,
  wrap: HTMLElement,
  world: PublicKey,
  create: { nonce: bigint; name: string; params: WorldParams } | null,
  onDone: (world: PublicKey) => void,
  onReady?: (world: PublicKey) => void,
) {
  const steps = stepList(SETUP_STEPS);
  const actions = h("div", { class: "actions" });
  const title = create ? `Creating “${create.name}”` : "Finishing world setup";
  const status = h("p", { class: "muted", role: "status" }, "Each step is a rollup transaction signed by your session key.");
  wrap.replaceChildren(h("div", { class: "panel-head" }, h("h2", { tabindex: -1 }, title)), status, steps.el, actions);
  (wrap.querySelector("h2") as HTMLElement).focus();
  const attempt = async () => {
    actions.replaceChildren();
    try {
      await runSetup(app, world, steps, create);
      status.textContent = "World ready. Your spawn chunk is generated.";
      onReady?.(world);
      const enter = h("button", { class: "btn primary", type: "button" }, "Enter world");
      enter.addEventListener("click", () => onDone(world));
      actions.append(enter);
      enter.focus();
    } catch {
      status.textContent = "Setup stopped. Fix the problem and retry: finished steps are skipped.";
      const retry = h("button", { class: "btn", type: "button" }, "Retry");
      retry.addEventListener("click", () => void attempt());
      actions.append(retry);
      retry.focus();
    }
  };
  await attempt();
}
