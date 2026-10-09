/* tslint:disable */
/* eslint-disable */

/**
 * `blocks::BLOCK_FLAGS` (256 B; bit 1 solid, 2 transparent, 4 fluid).
 */
export function block_flags(): Uint8Array;

/**
 * `blocks::break_time_ms(block, tool of item)` in ms; 0 = not breakable (air, water,
 * bedrock, unknown byte). `item` 0 = bare hand.
 */
export function break_time_ms(block: number, item: number): number;

/**
 * `blocks::can_harvest(block, tool of item)` (false for unknown bytes).
 */
export function can_harvest(block: number, item: number): boolean;

/**
 * Runs `physics::check_move` on a 2×2 chunk window.
 *
 * - `params`: 48 B `WorldParams`; `prev`: 72 B `MoveState` (the last accepted state).
 * - `pos`, `vel`: 3 × i32 (FP feet center, FP/s).
 * - `client_ms`, `chain_ms`: ms as f64 (integral; cast to i64, saturating).
 * - `(cx0, cz0)`: window origin (`physics::move_window(prev.pos, pos)`); `quad`: 4 ×
 *   16 384 block bytes in slot order `(cx0, cz0)`, `(cx0+1, cz0)`, `(cx0, cz0+1)`,
 *   `(cx0+1, cz0+1)`; bit `i` of `mask` set = slot `i` present (absent slots read as
 *   Stone, like chunks the program is not passed).
 *
 * Returns `[code, fall_damage, new state (72 B)]`: code [`OK`], `1 + MoveError`
 * discriminant (1 MoveTooFast, 2 Collision, 3 NotOnGround, 4 Flying, 5 InvalidState,
 * 6 TimeSkew) or [`BAD_INPUT`]; state bytes are zero unless accepted.
 */
export function check_move(params: Uint8Array, prev: Uint8Array, pos: Int32Array, vel: Int32Array, on_ground: boolean, client_ms: number, chain_ms: number, cx0: number, cz0: number, quad: Uint8Array, mask: number): Uint8Array;

/**
 * [`check_move`] against the stored window (see [`set_quad_slot`]); `mask` bit `i` =
 * slot `i` holds a chunk.
 */
export function check_move_stored(params: Uint8Array, prev: Uint8Array, pos: Int32Array, vel: Int32Array, on_ground: boolean, client_ms: number, chain_ms: number, cx0: number, cz0: number, mask: number): Uint8Array;

/**
 * FNV-1a 64 (hex) of the core + wrapper sources this build was made from (`build.rs`).
 */
export function core_src_hash(): string;

/**
 * Rules version of the core this build wraps (`magicraft_core::version`).
 */
export function core_version(): number;

/**
 * `recipes::craft` on a copy of `inv` (216 B, the `PlayerState` inventory bytes):
 * `[code, inventory after (216 B)]`; code 0 = ok, `1 + CraftError` discriminant
 * (1 UnknownRecipe, 2 WrongStation, 3 MissingInputs, 4 MissingFuel, 5 NoSpace,
 * 6 InvalidCount) or [`BAD_INPUT`] (then no inventory follows).
 */
export function craft(inv: Uint8Array, recipe_id: number, count: number, table: boolean, furnace: boolean): Uint8Array;

/**
 * `WorldParams::default()` bytes (48 B).
 */
export function default_params(): Uint8Array;

/**
 * `blocks::drop_item(block)` as `[item, count]`, or empty if it drops nothing.
 */
export function drop_item(block: number): Uint16Array;

/**
 * Every item id (`Item::ALL`).
 */
export function item_ids(): Uint16Array;

/**
 * Properties of item `id`: `[block (−1 = not placeable), tool kind (−1 none; 0 pickaxe,
 * 1 axe, 2 shovel, 3 sword), tier (0 none, 1..=4), attack damage (1 = fist for
 * non-tools), max stack, max durability, food value (−1 not edible)]`; empty if unknown.
 */
export function item_info(id: number): Int32Array;

/**
 * The largest `count` (0..=[`MAX_CRAFT_COUNT`]) for which [`craft`] succeeds (a craft that
 * works for `n` works for every smaller `n`: inputs, fuel and output space all scale).
 */
export function max_crafts(inv: Uint8Array, recipe_id: number, table: boolean, furnace: boolean): number;

/**
 * `physics::move_window(a, b)` → `[cx0, cz0]`, or empty if the move spans more chunks.
 */
export function move_window(a: Int32Array, b: Int32Array): Int32Array;

/**
 * Physics constants the client mirrors: `[HALF_W, FEET_EPS, BODY_H, GROUND_HALF_W,
 * GROUND_EPS, LEAD_MS, LAG_MS]`.
 */
export function physics_constants(): Int32Array;

/**
 * `recipes::RECIPES` flattened, in id order: per recipe `[n_inputs, (item, amount) ×
 * n_inputs, output item, output amount, station (0 none, 1 table, 2 furnace), fuel]`.
 */
export function recipe_table(): Uint16Array;

/**
 * Copies `blocks` (16 384 B) into slot `i` (0..4) of the stored window; false on bad input.
 */
export function set_quad_slot(i: number, blocks: Uint8Array): boolean;

/**
 * `MoveState::spawn(pos, now_ms)` bytes (72 B), optionally on ground.
 */
export function spawn_state(pos: Int32Array, now_ms: number, on_ground: boolean): Uint8Array;

/**
 * `WorldParams::validate`: −1 if valid, else the `ParamError` discriminant
 * (BAD_INPUT as i32 for a wrong length).
 */
export function validate_params(params: Uint8Array): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly block_flags: () => [number, number];
    readonly break_time_ms: (a: number, b: number) => number;
    readonly can_harvest: (a: number, b: number) => number;
    readonly check_move: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => [number, number];
    readonly check_move_stored: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => [number, number];
    readonly core_src_hash: () => [number, number];
    readonly core_version: () => number;
    readonly craft: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly default_params: () => [number, number];
    readonly drop_item: (a: number) => [number, number];
    readonly item_ids: () => [number, number];
    readonly item_info: (a: number) => [number, number];
    readonly max_crafts: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly move_window: (a: number, b: number, c: number, d: number) => [number, number];
    readonly physics_constants: () => [number, number];
    readonly recipe_table: () => [number, number];
    readonly set_quad_slot: (a: number, b: number, c: number) => number;
    readonly spawn_state: (a: number, b: number, c: number, d: number) => [number, number];
    readonly validate_params: (a: number, b: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
