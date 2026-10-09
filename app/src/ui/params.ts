// WorldParams in human units for the create-world form (blocks/s, seconds) and back, with
// per-field range checks mirroring `core::physics::WorldParams::validate`
// (`layout.validateWorldParams` is the final word: the form never submits what it rejects).
import { DEFAULT_WORLD_PARAMS, FP, MOB_SLOTS, validateWorldParams, type WorldParams } from "../chain";

/** How a field is shown: `fp` = fixed-point (÷ 256, blocks), `ms` = milliseconds shown in
 *  seconds, `int` = plain integer, `bool` = 0/1 checkbox. */
export type FieldKind = "fp" | "ms" | "int" | "bool";

export type ParamField = {
  key: Exclude<keyof WorldParams, "pad">;
  label: string;
  unit: string;
  kind: FieldKind;
  /** Range in display units (inclusive); `sprintSpeed`'s minimum is the walk speed. */
  min: number;
  max: number;
  step: number;
  group: "movement" | "combat" | "world";
  help?: string;
};

export const PARAM_FIELDS: readonly ParamField[] = [
  { key: "walkSpeed", label: "Walk speed", unit: "blocks/s", kind: "fp", min: 1, max: 50, step: 0.1, group: "movement" },
  { key: "sprintSpeed", label: "Sprint speed", unit: "blocks/s", kind: "fp", min: 1, max: 50, step: 0.1, group: "movement", help: "At least the walk speed." },
  { key: "swimSpeed", label: "Swim speed", unit: "blocks/s", kind: "fp", min: 1, max: 50, step: 0.1, group: "movement" },
  { key: "jumpVelocity", label: "Jump velocity", unit: "blocks/s", kind: "fp", min: 1, max: 50, step: 0.05, group: "movement", help: "Jump height v²/2g stays ≤ 8 blocks." },
  { key: "gravity", label: "Gravity", unit: "blocks/s²", kind: "fp", min: 1, max: 100, step: 0.5, group: "movement" },
  { key: "maxFallSpeed", label: "Max fall speed", unit: "blocks/s", kind: "fp", min: 1, max: 200, step: 1, group: "movement" },
  { key: "reach", label: "Reach", unit: "blocks", kind: "fp", min: 1, max: 16, step: 0.5, group: "combat" },
  { key: "attackCooldownMs", label: "Attack cooldown", unit: "s", kind: "ms", min: 0, max: 10, step: 0.05, group: "combat" },
  { key: "zombieCapPerChunk", label: "Max zombies per chunk", unit: "", kind: "int", min: 0, max: MOB_SLOTS, step: 1, group: "combat", help: "0 = peaceful." },
  { key: "fallDamage", label: "Fall damage", unit: "", kind: "bool", min: 0, max: 1, step: 1, group: "combat" },
  { key: "hunger", label: "Hunger", unit: "", kind: "bool", min: 0, max: 1, step: 1, group: "combat" },
  { key: "dayLengthSecs", label: "Day length", unit: "s", kind: "int", min: 60, max: 86_400, step: 60, group: "world", help: "A full day–night cycle." },
  { key: "mobTickMs", label: "Mob tick", unit: "s", kind: "ms", min: 0.1, max: 60, step: 0.001, group: "world" },
  { key: "fluidTickMs", label: "Water tick", unit: "s", kind: "ms", min: 0.1, max: 60, step: 0.001, group: "world" },
];

/** Display values (numbers; booleans as 0/1) keyed like `WorldParams`. */
export type ParamForm = Record<ParamField["key"], number>;

/** Up to 3 decimals, trailing zeros trimmed (3 decimals of a ÷256 value round-trip). */
const trim = (v: number) => Number(v.toFixed(3));

export function toForm(p: Readonly<WorldParams>): ParamForm {
  const f = {} as ParamForm;
  for (const d of PARAM_FIELDS) {
    const raw = p[d.key];
    f[d.key] = d.kind === "fp" ? trim(raw / FP) : d.kind === "ms" ? trim(raw / 1000) : raw;
  }
  return f;
}

/** Display value → onchain integer. */
export function toRaw(d: ParamField, v: number): number {
  if (d.kind === "fp") return Math.round(v * FP);
  if (d.kind === "ms") return Math.round(v * 1000);
  if (d.kind === "bool") return v ? 1 : 0;
  return Math.round(v);
}

export function fromForm(f: ParamForm): WorldParams {
  const p = { ...DEFAULT_WORLD_PARAMS } as WorldParams;
  for (const d of PARAM_FIELDS) p[d.key] = toRaw(d, f[d.key]);
  p.pad = 0;
  return p;
}

const fmt = (v: number) => String(trim(v));

/** Field key → error message for every out-of-range field (empty when valid). Covers the
 *  core rules (incl. sprint ≥ walk and the jump-height cap), then `validateWorldParams`
 *  as a backstop so the form can never submit what the program rejects. */
export function validateForm(f: ParamForm): Partial<Record<ParamField["key"], string>> {
  const errs: Partial<Record<ParamField["key"], string>> = {};
  for (const d of PARAM_FIELDS) {
    const v = f[d.key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      errs[d.key] = "Enter a number.";
      continue;
    }
    if (d.kind === "int" && !Number.isInteger(v)) errs[d.key] = "Whole numbers only.";
    else if (v < d.min || v > d.max) errs[d.key] = `Between ${fmt(d.min)} and ${fmt(d.max)}${d.unit && d.kind !== "bool" ? ` ${d.unit}` : ""}.`;
  }
  if (Object.keys(errs).length) return errs;
  const p = fromForm(f);
  if (p.sprintSpeed < p.walkSpeed) errs.sprintSpeed = `At least the walk speed (${fmt(f.walkSpeed)} blocks/s).`;
  const jumpH = Math.floor((p.jumpVelocity * p.jumpVelocity) / (2 * p.gravity)) / FP;
  if (jumpH > 8) errs.jumpVelocity = `Jump height ${fmt(jumpH)} blocks; at most 8 (lower the velocity or raise gravity).`;
  if (Object.keys(errs).length) return errs;
  const bad = validateWorldParams(p);
  if (bad) {
    const key = (bad === "jumpHeight" ? "jumpVelocity" : bad) as ParamField["key"];
    errs[key] = "Out of range.";
  }
  return errs;
}

/** Jump height in blocks for display. */
export const jumpHeight = (f: Pick<ParamForm, "jumpVelocity" | "gravity">) =>
  f.gravity > 0 ? trim((f.jumpVelocity * f.jumpVelocity) / (2 * f.gravity)) : Infinity;

/** World names are stored in 32 bytes (UTF-8). */
export function validateName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Give the world a name.";
  if (new TextEncoder().encode(n).length > 32) return "At most 32 bytes (about 32 letters).";
  return null;
}
