/* @ts-self-types="./core.d.ts" */

/**
 * `blocks::BLOCK_FLAGS` (256 B; bit 1 solid, 2 transparent, 4 fluid).
 * @returns {Uint8Array}
 */
export function block_flags() {
    const ret = wasm.block_flags();
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * `blocks::break_time_ms(block, tool of item)` in ms; 0 = not breakable (air, water,
 * bedrock, unknown byte). `item` 0 = bare hand.
 * @param {number} block
 * @param {number} item
 * @returns {number}
 */
export function break_time_ms(block, item) {
    const ret = wasm.break_time_ms(block, item);
    return ret >>> 0;
}

/**
 * `blocks::can_harvest(block, tool of item)` (false for unknown bytes).
 * @param {number} block
 * @param {number} item
 * @returns {boolean}
 */
export function can_harvest(block, item) {
    const ret = wasm.can_harvest(block, item);
    return ret !== 0;
}

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
 * @param {Uint8Array} params
 * @param {Uint8Array} prev
 * @param {Int32Array} pos
 * @param {Int32Array} vel
 * @param {boolean} on_ground
 * @param {number} client_ms
 * @param {number} chain_ms
 * @param {number} cx0
 * @param {number} cz0
 * @param {Uint8Array} quad
 * @param {number} mask
 * @returns {Uint8Array}
 */
export function check_move(params, prev, pos, vel, on_ground, client_ms, chain_ms, cx0, cz0, quad, mask) {
    const ptr0 = passArray8ToWasm0(params, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(prev, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray32ToWasm0(pos, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray32ToWasm0(vel, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray8ToWasm0(quad, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ret = wasm.check_move(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, on_ground, client_ms, chain_ms, cx0, cz0, ptr4, len4, mask);
    var v6 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v6;
}

/**
 * [`check_move`] against the stored window (see [`set_quad_slot`]); `mask` bit `i` =
 * slot `i` holds a chunk.
 * @param {Uint8Array} params
 * @param {Uint8Array} prev
 * @param {Int32Array} pos
 * @param {Int32Array} vel
 * @param {boolean} on_ground
 * @param {number} client_ms
 * @param {number} chain_ms
 * @param {number} cx0
 * @param {number} cz0
 * @param {number} mask
 * @returns {Uint8Array}
 */
export function check_move_stored(params, prev, pos, vel, on_ground, client_ms, chain_ms, cx0, cz0, mask) {
    const ptr0 = passArray8ToWasm0(params, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(prev, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray32ToWasm0(pos, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray32ToWasm0(vel, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.check_move_stored(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, on_ground, client_ms, chain_ms, cx0, cz0, mask);
    var v5 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v5;
}

/**
 * FNV-1a 64 (hex) of the core + wrapper sources this build was made from (`build.rs`).
 * @returns {string}
 */
export function core_src_hash() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.core_src_hash();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Rules version of the core this build wraps (`magicraft_core::version`).
 * @returns {number}
 */
export function core_version() {
    const ret = wasm.core_version();
    return ret >>> 0;
}

/**
 * `recipes::craft` on a copy of `inv` (216 B, the `PlayerState` inventory bytes):
 * `[code, inventory after (216 B)]`; code 0 = ok, `1 + CraftError` discriminant
 * (1 UnknownRecipe, 2 WrongStation, 3 MissingInputs, 4 MissingFuel, 5 NoSpace,
 * 6 InvalidCount) or [`BAD_INPUT`] (then no inventory follows).
 * @param {Uint8Array} inv
 * @param {number} recipe_id
 * @param {number} count
 * @param {boolean} table
 * @param {boolean} furnace
 * @returns {Uint8Array}
 */
export function craft(inv, recipe_id, count, table, furnace) {
    const ptr0 = passArray8ToWasm0(inv, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.craft(ptr0, len0, recipe_id, count, table, furnace);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * `WorldParams::default()` bytes (48 B).
 * @returns {Uint8Array}
 */
export function default_params() {
    const ret = wasm.default_params();
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * `blocks::drop_item(block)` as `[item, count]`, or empty if it drops nothing.
 * @param {number} block
 * @returns {Uint16Array}
 */
export function drop_item(block) {
    const ret = wasm.drop_item(block);
    var v1 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
    return v1;
}

/**
 * Every item id (`Item::ALL`).
 * @returns {Uint16Array}
 */
export function item_ids() {
    const ret = wasm.item_ids();
    var v1 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
    return v1;
}

/**
 * Properties of item `id`: `[block (−1 = not placeable), tool kind (−1 none; 0 pickaxe,
 * 1 axe, 2 shovel, 3 sword), tier (0 none, 1..=4), attack damage (1 = fist for
 * non-tools), max stack, max durability, food value (−1 not edible)]`; empty if unknown.
 * @param {number} id
 * @returns {Int32Array}
 */
export function item_info(id) {
    const ret = wasm.item_info(id);
    var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * The largest `count` (0..=[`MAX_CRAFT_COUNT`]) for which [`craft`] succeeds (a craft that
 * works for `n` works for every smaller `n`: inputs, fuel and output space all scale).
 * @param {Uint8Array} inv
 * @param {number} recipe_id
 * @param {boolean} table
 * @param {boolean} furnace
 * @returns {number}
 */
export function max_crafts(inv, recipe_id, table, furnace) {
    const ptr0 = passArray8ToWasm0(inv, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.max_crafts(ptr0, len0, recipe_id, table, furnace);
    return ret;
}

/**
 * `physics::move_window(a, b)` → `[cx0, cz0]`, or empty if the move spans more chunks.
 * @param {Int32Array} a
 * @param {Int32Array} b
 * @returns {Int32Array}
 */
export function move_window(a, b) {
    const ptr0 = passArray32ToWasm0(a, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(b, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.move_window(ptr0, len0, ptr1, len1);
    var v3 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v3;
}

/**
 * Physics constants the client mirrors: `[HALF_W, FEET_EPS, BODY_H, GROUND_HALF_W,
 * GROUND_EPS, LEAD_MS, LAG_MS]`.
 * @returns {Int32Array}
 */
export function physics_constants() {
    const ret = wasm.physics_constants();
    var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * `recipes::RECIPES` flattened, in id order: per recipe `[n_inputs, (item, amount) ×
 * n_inputs, output item, output amount, station (0 none, 1 table, 2 furnace), fuel]`.
 * @returns {Uint16Array}
 */
export function recipe_table() {
    const ret = wasm.recipe_table();
    var v1 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
    return v1;
}

/**
 * Copies `blocks` (16 384 B) into slot `i` (0..4) of the stored window; false on bad input.
 * @param {number} i
 * @param {Uint8Array} blocks
 * @returns {boolean}
 */
export function set_quad_slot(i, blocks) {
    const ptr0 = passArray8ToWasm0(blocks, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.set_quad_slot(i, ptr0, len0);
    return ret !== 0;
}

/**
 * `MoveState::spawn(pos, now_ms)` bytes (72 B), optionally on ground.
 * @param {Int32Array} pos
 * @param {number} now_ms
 * @param {boolean} on_ground
 * @returns {Uint8Array}
 */
export function spawn_state(pos, now_ms, on_ground) {
    const ptr0 = passArray32ToWasm0(pos, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.spawn_state(ptr0, len0, now_ms, on_ground);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * `WorldParams::validate`: −1 if valid, else the `ParamError` discriminant
 * (BAD_INPUT as i32 for a wrong length).
 * @param {Uint8Array} params
 * @returns {number}
 */
export function validate_params(params) {
    const ptr0 = passArray8ToWasm0(params, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.validate_params(ptr0, len0);
    return ret;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./core_bg.js": import0,
    };
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU16FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
    if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
        cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
    }
    return cachedUint16ArrayMemory0;
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedInt32ArrayMemory0 = null;
    cachedUint16ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('core_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
