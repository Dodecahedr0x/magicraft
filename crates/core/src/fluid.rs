//! Flowing water: a per-chunk update queue and a budgeted, never-failing step.
//!
//! Runs onchain inside the permissionless `tick_chunk` crank, so every function here is
//! total: no panics for any chunk bytes or queue contents, no overflow, no heap.
//!
//! # Model (pull, center-writes-only)
//! Each chunk owns a [`FluidQueue`] of *local* block indices. [`step`] pops up to `budget`
//! entries from the **center** chunk's queue, recomputes that voxel's *desired state* from
//! its surroundings (rules below) and, if it differs, writes it **into the center chunk
//! only**. On a change, the voxels whose desired state depends on the changed one are pushed
//! into the queue of the chunk that owns them (center or one of the 4 orthogonal neighbors).
//! A neighbor never gets written by another chunk's tick; it continues the flow in its own
//! tick. So the program must keep a chunk's crank armed while its queue is non-empty, also
//! when entries arrived from a neighbor's tick.
//!
//! # Neighborhood
//! [`ChunkNeighborhood`] = center chunk + optional N (`cz-1`), S (`cz+1`), E (`cx+1`),
//! W (`cx-1`) chunks. Missing neighbors, diagonal chunks and anything further read as
//! **Stone** and are not writable; `y < 0` reads as **Bedrock**, `y >= 64` as **Air**
//! (neither writable). Nothing is ever enqueued for a missing chunk.
//!
//! # Rules
//! Terms: *water* = `WaterSource..=Water7` (level 0..=7, source = 0); *flowing* =
//! `Water1..=Water7`; *open* = `Air` (the only block water flows into; torches, ice and
//! every other byte, including out-of-palette bytes, block flow); *support* = anything
//! that is neither Air nor flowing water (solid blocks, sources, unknown bytes).
//!
//! A water block **spreads sideways** iff the block below it is support. So water over
//! Air or over flowing water (a falling column) only goes down. Only Air and flowing
//! voxels are ever updated; sources and non-water blocks are never changed by fluid
//! (sources are only created/removed by player edits, or created by rule 1).
//!
//! The desired state of an Air or flowing voxel `P` is the first rule that applies:
//! 1. **Infinite source:** ≥ 2 of the 4 horizontal neighbors are sources and the block
//!    below `P` is support → `WaterSource`.
//! 2. **Fed from above:** the block above `P` is water → `Water1` (falling water; a column
//!    of Water1 below any water down to the first non-Air block).
//! 3. **Fed sideways:** `min(L + 1)` over *feeders* → `Water(min)`. A feeder is a
//!    horizontal water neighbor with level `L <= 6` that spreads sideways, and, if `P` is
//!    currently flowing at level `c`, with `L <= c` (Air accepts any feeder). Levels grow
//!    by one per block: radius 7 from a source on a flat floor, radius 6 from where a fall
//!    lands (it lands as Water1).
//! 4. otherwise → `Air` (unfed flowing water recedes).
//!
//! The `L <= c` cap only matters while receding; fixed points are the same as with plain
//! `min(L + 1)` (each voxel = 1 + its lowest feeder, i.e. the flow distance). Without it,
//! orphaned water ping-pongs (inner voxels re-fed by outer ones, levels creeping up to 8),
//! keeping the whole body in the queue at once; with it a stable flowing voxel always has
//! a strictly lower neighbor chain down to a source or a fall, and orphaned water recedes
//! in a single outward wave (each voxel goes straight to Air or to `c + 1` at most).
//! A flowing voxel that recedes to Air re-queues itself (behind the dependents it just
//! pushed): as Air it accepts any feeder, so water still fed by a higher-level neighbor
//! (e.g. one of two sources removed) refills at the right level.
//!
//! # Dependencies (what gets enqueued)
//! `desired(P)` reads `above(P)`, `below(P)`, `H(P)` (4 horizontal neighbors) and
//! `below(H(P))`. So a change at `Q` can affect `below(Q)`, `H(Q)`, `above(Q)` and
//! `H(above(Q))`. [`step`] pushes only those that can actually change (and only Air or
//! flowing ones):
//! - `H(Q)`: if `Q` became a source → all; if `Q` now water at level `n <= 6` and spreads
//!   → Air or flowing with level `> n + 1`; if `Q` was water at level `o` and got weaker or
//!   removed → flowing with level `== o + 1` (only those can have had `Q` as their lowest
//!   feeder; a flowing voxel at any other level that is not at its fixed point is already
//!   queued, since every change enqueues its dependents).
//! - `below(Q)`: Air → water: Air or flowing with level `> 1`; water → Air: flowing.
//! - `above(Q)` and `H(above(Q))`: only if `Q`'s *support* status changed.
//!
//! A voxel that went flowing → Air also re-queues itself (see rule 3).
//!
//! Player edits call [`enqueue_neighbors`], which pushes `Q` itself plus all 10 dependents
//! (unfiltered except for Air/flowing).
//!
//! If a queue is full the entry is dropped (water stays in a valid but possibly stale
//! state until a later edit nearby re-triggers it). The filters above keep the peak low;
//! measured in the tests: radius-7 spread 28, its recede 28, fall + landing spread 24,
//! two sources 31 entries (the plain `min(L + 1)` recede rule hit the 64 cap).
//!
//! # Cost (per processed entry)
//! `desired`: ≤ 10 block reads (each: a few compares to pick the chunk + one load).
//! On a change: 1 write, ≤ 6 more reads for the dependency filters, and ≤ 11 pushes
//! (each: 1 read + a dedup scan of ≤ 64 `u16`s). Unchanged entries (the common case for
//! back-propagated entries) cost ≈ 50–80 ops; a worst-case change ≈ 10 × 64 compares ≈
//! 1–2k ops. With the planned budget of 32 entries/tick the hard upper bound is ≈ 60k CU;
//! typical ticks are far below. (Hand count, not an SBF measurement.) `bench_step` (native
//! release, spread + recede of one source): ≈ 300 entries per scenario, ≈ 35 ns/entry
//! including test-harness overhead; measure real CU once `tick_chunk` exists.
//!
//! # SBF stack
//! No arrays on the stack: [`ChunkNeighborhood`] is 6 words; [`step`] / `desired` /
//! `on_change` are `#[inline(never)]` and hold only a handful of scalars (well under 256 B).

use crate::blocks::Block;
use crate::consts::{CHUNK_H, CHUNK_VOL, CHUNK_W};

const AIR: u8 = Block::Air as u8;
const STONE: u8 = Block::Stone as u8;
const BEDROCK: u8 = Block::Bedrock as u8;
const SOURCE: u8 = Block::WaterSource as u8;
const WATER1: u8 = Block::Water1 as u8;
const WATER7: u8 = Block::Water7 as u8;

/// Horizontal neighbor offsets `(dx, dz)`: E, W, S, N.
const DIRS: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

/// Neighborhood slots (also the order of [`FluidQueues`]).
pub const CENTER: usize = 0;
/// Chunk `(cx, cz - 1)`.
pub const NORTH: usize = 1;
/// Chunk `(cx, cz + 1)`.
pub const SOUTH: usize = 2;
/// Chunk `(cx + 1, cz)`.
pub const EAST: usize = 3;
/// Chunk `(cx - 1, cz)`.
pub const WEST: usize = 4;

/// Water level of a raw byte (source 0, flowing 1..=7), `None` for anything else.
#[inline]
fn level(b: u8) -> Option<u8> {
    if (SOURCE..=WATER7).contains(&b) {
        Some(b - SOURCE)
    } else {
        None
    }
}

#[inline]
fn is_flowing(b: u8) -> bool {
    (WATER1..=WATER7).contains(&b)
}

/// Air or flowing water: the only voxels fluid updates can change.
#[inline]
fn updatable(b: u8) -> bool {
    b == AIR || is_flowing(b)
}

/// Lets water above spread sideways / enables infinite sources: not Air, not flowing.
#[inline]
fn support(b: u8) -> bool {
    !updatable(b)
}

/// Ring buffer of pending fluid updates: local block indices (`0..16384`) of the owning
/// chunk, FIFO, deduplicated, capacity 64.
///
/// Byte layout (`#[repr(C)]`, size [`FluidQueue::SIZE`] = 130, align 2, no padding;
/// integers little-endian on SBF):
///
/// | offset | size | field  |                                              |
/// |--------|------|--------|----------------------------------------------|
/// | 0      | 128  | `buf`  | `[u16; 64]` ring storage                     |
/// | 128    | 1    | `head` | index of the oldest entry (used `& 63`)      |
/// | 129    | 1    | `len`  | number of entries (values > 64 read as 64)   |
///
/// All-zero bytes are an empty queue. Methods tolerate arbitrary field values (head is
/// masked, len clamped, stored entries ≥ 16384 are skipped by [`step`]) and never panic.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FluidQueue {
    pub buf: [u16; 64],
    pub head: u8,
    pub len: u8,
}

const _: () = assert!(core::mem::size_of::<FluidQueue>() == FluidQueue::SIZE);

impl Default for FluidQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl FluidQueue {
    /// Capacity in entries.
    pub const CAP: usize = 64;
    /// Size in bytes (see the layout table).
    pub const SIZE: usize = 130;

    /// Empty queue.
    pub const fn new() -> Self {
        FluidQueue {
            buf: [0; 64],
            head: 0,
            len: 0,
        }
    }

    /// Number of queued entries (clamped to 64).
    #[inline]
    pub fn len(&self) -> usize {
        (self.len as usize).min(Self::CAP)
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Queues `idx`. Returns `true` if it is queued afterwards (newly or already present),
    /// `false` if it was dropped (queue full, or `idx >= CHUNK_VOL`).
    pub fn push(&mut self, idx: u16) -> bool {
        if idx as usize >= CHUNK_VOL {
            return false;
        }
        let len = self.len();
        let head = self.head as usize;
        let mut i = 0;
        while i < len {
            if self.buf[(head + i) & (Self::CAP - 1)] == idx {
                return true;
            }
            i += 1;
        }
        if len >= Self::CAP {
            return false;
        }

        self.buf[(head + len) & (Self::CAP - 1)] = idx;
        self.len = (len + 1) as u8;
        true
    }

    /// Removes and returns the oldest entry.
    pub fn pop(&mut self) -> Option<u16> {
        let len = self.len();
        if len == 0 {
            self.len = 0;
            return None;
        }
        let head = self.head as usize & (Self::CAP - 1);
        let v = self.buf[head];
        self.head = ((head + 1) & (Self::CAP - 1)) as u8;
        self.len = (len - 1) as u8;
        Some(v)
    }
}

/// Block read/write in **world** block coordinates.
pub trait BlockAccess {
    /// Block byte at `(x, y, z)`; positions outside the accessible area read as solid.
    fn get(&self, x: i32, y: i32, z: i32) -> u8;
    /// Writes a block; returns `false` (and writes nothing) if the position is not writable.
    fn set(&mut self, x: i32, y: i32, z: i32, b: u8) -> bool;
}

/// Queues of the neighborhood, indexed like the chunk slots: [`CENTER`], [`NORTH`],
/// [`SOUTH`], [`EAST`], [`WEST`]. `None` = chunk missing (or queue unavailable).
pub type FluidQueues<'q> = [Option<&'q mut FluidQueue>; 5];

/// The center chunk plus its (optional) 4 orthogonal neighbors. See the module docs for
/// what reads outside them return.
pub struct ChunkNeighborhood<'a> {
    /// Center chunk coordinates.
    pub cx: i32,
    pub cz: i32,
    chunks: [Option<&'a mut [u8; CHUNK_VOL]>; 5],
}

impl<'a> ChunkNeighborhood<'a> {
    /// `neighbors` in order N (`cz-1`), S (`cz+1`), E (`cx+1`), W (`cx-1`); `None` = missing.
    pub fn new(
        cx: i32,
        cz: i32,
        center: &'a mut [u8; CHUNK_VOL],
        neighbors: [Option<&'a mut [u8; CHUNK_VOL]>; 4],
    ) -> Self {
        let [n, s, e, w] = neighbors;
        ChunkNeighborhood {
            cx,
            cz,
            chunks: [Some(center), n, s, e, w],
        }
    }

    /// World → frame coordinates (relative to the center chunk origin), `None` if far away.
    #[inline]
    fn to_frame(&self, x: i32, z: i32) -> Option<(i32, i32)> {
        let fx = x as i64 - self.cx as i64 * CHUNK_W as i64;
        let fz = z as i64 - self.cz as i64 * CHUNK_W as i64;
        if (-16..32).contains(&fx) && (-16..32).contains(&fz) {
            Some((fx as i32, fz as i32))
        } else {
            None
        }
    }

    /// Frame coordinates → (slot, local block index) of a *present* chunk.
    #[inline]
    fn locate(&self, x: i32, y: i32, z: i32) -> Option<(usize, usize)> {
        if !(0..CHUNK_H as i32).contains(&y) {
            return None;
        }
        let inx = (0..16).contains(&x);
        let inz = (0..16).contains(&z);
        let (slot, lx, lz) = if inx && inz {
            (CENTER, x, z)
        } else if inx && (-16..0).contains(&z) {
            (NORTH, x, z + 16)
        } else if inx && (16..32).contains(&z) {
            (SOUTH, x, z - 16)
        } else if inz && (16..32).contains(&x) {
            (EAST, x - 16, z)
        } else if inz && (-16..0).contains(&x) {
            (WEST, x + 16, z)
        } else {
            return None;
        };
        self.chunks.get(slot)?.as_ref()?;
        Some((
            slot,
            ((y as usize * CHUNK_W) + lz as usize) * CHUNK_W + lx as usize,
        ))
    }

    /// Read in frame coordinates.
    #[inline]
    fn fget(&self, x: i32, y: i32, z: i32) -> u8 {
        if y < 0 {
            return BEDROCK;
        }
        if y >= CHUNK_H as i32 {
            return AIR;
        }
        match self.locate(x, y, z) {
            Some((slot, idx)) => match self.chunks.get(slot) {
                Some(Some(c)) => c.get(idx).copied().unwrap_or(STONE),
                _ => STONE,
            },
            None => STONE,
        }
    }

    /// Write in frame coordinates.
    #[inline]
    fn fset(&mut self, x: i32, y: i32, z: i32, b: u8) -> bool {
        let Some((slot, idx)) = self.locate(x, y, z) else {
            return false;
        };
        match self.chunks.get_mut(slot) {
            Some(Some(c)) => match c.get_mut(idx) {
                Some(v) => {
                    *v = b;
                    true
                }
                None => false,
            },
            _ => false,
        }
    }

    /// Pushes frame position `(x, y, z)` into its owner's queue if it is Air or flowing.
    /// Returns `false` only if the entry was dropped because the queue is full.
    #[inline]
    fn push_if_updatable(&self, queues: &mut FluidQueues, x: i32, y: i32, z: i32) -> bool {
        let Some((slot, idx)) = self.locate(x, y, z) else {
            return true;
        };
        if !updatable(self.fget(x, y, z)) {
            return true;
        }
        match queues.get_mut(slot) {
            Some(Some(q)) => q.push(idx as u16),
            _ => true,
        }
    }
}

impl BlockAccess for ChunkNeighborhood<'_> {
    fn get(&self, x: i32, y: i32, z: i32) -> u8 {
        match self.to_frame(x, z) {
            Some((fx, fz)) => self.fget(fx, y, fz),
            None if y < 0 => BEDROCK,
            None if y >= CHUNK_H as i32 => AIR,
            None => STONE,
        }
    }

    fn set(&mut self, x: i32, y: i32, z: i32, b: u8) -> bool {
        match self.to_frame(x, z) {
            Some((fx, fz)) => self.fset(fx, y, fz, b),
            None => false,
        }
    }
}

/// Desired state of the Air/flowing voxel at frame position `(x, y, z)` (rules 1–4).
#[inline(never)]
fn desired(w: &ChunkNeighborhood, x: i32, y: i32, z: i32, cur: u8) -> u8 {
    // Flowing water at level c only accepts feeders with L <= c; Air accepts any.
    let cap = level(cur).unwrap_or(7);
    let mut sources = 0u8;
    let mut best = 8u8; // lowest L + 1 offered sideways
    for (dx, dz) in DIRS {
        let (hx, hz) = (x + dx, z + dz);
        if let Some(l) = level(w.fget(hx, y, hz)) {
            if l == 0 {
                sources += 1;
            }
            if l < 7 && l <= cap && l + 1 < best && support(w.fget(hx, y - 1, hz)) {
                best = l + 1;
            }
        }
    }
    if sources >= 2 && support(w.fget(x, y - 1, z)) {
        return SOURCE;
    }
    if level(w.fget(x, y + 1, z)).is_some() {
        return WATER1;
    }
    if best <= 7 {
        SOURCE + best
    } else {
        AIR
    }
}

/// Enqueues the dependents of frame position `Q = (x, y, z)` that can change because `Q`
/// went from `old` to `new` (filters in the module docs). Returns the number dropped.
#[inline(never)]
fn on_change(
    w: &ChunkNeighborhood,
    queues: &mut FluidQueues,
    (x, y, z): (i32, i32, i32),
    old: u8,
    new: u8,
) -> u32 {
    let mut dropped = 0u32;
    let ol = level(old);
    let nl = level(new);
    let q_spreads = support(w.fget(x, y - 1, z));
    let weaker = match (ol, nl) {
        (Some(_), None) => true,
        (Some(o), Some(n)) => n > o,
        _ => false,
    };
    for (dx, dz) in DIRS {
        let (hx, hz) = (x + dx, z + dz);
        let h = w.fget(hx, y, hz);
        if !updatable(h) {
            continue;
        }
        // Flowing levels are 1..=7; Air gets 8 so "level > n + 1" includes it.
        let hl = level(h).unwrap_or(8);
        let mut want = nl == Some(0);
        if let Some(n) = nl {
            want |= q_spreads && n < 7 && hl > n + 1;
        }
        if let Some(o) = ol {
            want |= weaker && is_flowing(h) && hl == o + 1;
        }
        if want && !w.push_if_updatable(queues, hx, y, hz) {
            dropped += 1;
        }
    }
    let b = w.fget(x, y - 1, z);
    let want_below = match (ol, nl) {
        (None, Some(_)) => b == AIR || level(b).is_some_and(|l| l > 1),
        (Some(_), None) => is_flowing(b),
        _ => false,
    };
    if want_below && !w.push_if_updatable(queues, x, y - 1, z) {
        dropped += 1;
    }
    if support(old) != support(new) {
        dropped += push_above(w, queues, x, y, z);
    }
    dropped
}

/// Pushes `above(Q)` and `H(above(Q))`. Returns the number dropped.
fn push_above(w: &ChunkNeighborhood, queues: &mut FluidQueues, x: i32, y: i32, z: i32) -> u32 {
    let mut dropped = 0;
    if !w.push_if_updatable(queues, x, y + 1, z) {
        dropped += 1;
    }
    for (dx, dz) in DIRS {
        if !w.push_if_updatable(queues, x + dx, y + 1, z + dz) {
            dropped += 1;
        }
    }
    dropped
}

/// Notifies the fluid system of a block edit at **world** position `(x, y, z)` (call it
/// after writing the new block): pushes the position itself and every voxel whose state
/// can depend on it — `below`, `above`, the 4 horizontal neighbors and the 4 horizontal
/// neighbors of `above` — that is Air or flowing, into the owning chunk's queue (skipped
/// for missing chunks). Returns the number of entries dropped because a queue was full.
pub fn enqueue_neighbors(
    world: &ChunkNeighborhood,
    queues: &mut FluidQueues,
    x: i32,
    y: i32,
    z: i32,
) -> u32 {
    let Some((fx, fz)) = world.to_frame(x, z) else {
        return 0;
    };
    // Keep y + 1 / y - 1 overflow-free; anything outside 0..64 is never queued anyway.
    if !(-1..=CHUNK_H as i32).contains(&y) {
        return 0;
    }
    let mut dropped = 0;
    for (px, py, pz) in [(fx, y, fz), (fx, y - 1, fz)] {
        if !world.push_if_updatable(queues, px, py, pz) {
            dropped += 1;
        }
    }
    for (dx, dz) in DIRS {
        if !world.push_if_updatable(queues, fx + dx, y, fz + dz) {
            dropped += 1;
        }
    }
    dropped + push_above(world, queues, fx, y, fz)
}

/// Processes up to `budget` entries of the center chunk's queue (see the module docs).
/// Writes only into the center chunk; pushes follow-up work into the owning chunks'
/// queues. Returns the number of entries popped (`<= budget`). Never panics.
#[inline(never)]
pub fn step(world: &mut ChunkNeighborhood, queues: &mut FluidQueues, budget: u32) -> u32 {
    let mut processed = 0u32;
    while processed < budget {
        let Some(idx) = (match queues.get_mut(CENTER) {
            Some(Some(q)) => q.pop(),
            _ => None,
        }) else {
            break;
        };
        processed += 1;
        let idx = idx as usize;
        if idx >= CHUNK_VOL {
            continue;
        }
        let x = (idx % CHUNK_W) as i32;
        let z = ((idx / CHUNK_W) % CHUNK_W) as i32;
        let y = (idx / (CHUNK_W * CHUNK_W)) as i32;
        let cur = world.fget(x, y, z);
        if !updatable(cur) {
            continue;
        }
        let want = desired(world, x, y, z, cur);
        if want == cur || !world.fset(x, y, z, want) {
            continue;
        }
        on_change(world, queues, (x, y, z), cur, want);
        if want == AIR {
            // Receded for lack of a feeder `<= c`; as Air it may be re-fed by a higher
            // neighbor that is still fed. Re-check after the dependents just pushed, so
            // orphaned outer water gets the chance to recede first.
            if let Some(Some(q)) = queues.get_mut(CENTER) {
                q.push(idx as u16);
            }
        }
    }
    processed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blocks::Block;
    use crate::coords::block_index;
    use crate::hash::splitmix_next;
    use std::collections::BTreeMap;

    const AIR: u8 = Block::Air as u8;
    const STONE: u8 = Block::Stone as u8;
    const SRC: u8 = Block::WaterSource as u8;

    fn w(level: u8) -> u8 {
        crate::blocks::water_block(level) as u8
    }

    fn boxed_chunk() -> Box<[u8; CHUNK_VOL]> {
        vec![AIR; CHUNK_VOL].into_boxed_slice().try_into().unwrap()
    }

    /// Air chunk with a stone floor at `y <= floor`.
    fn floor_chunk(floor: usize) -> Box<[u8; CHUNK_VOL]> {
        let mut c = boxed_chunk();
        for y in 0..=floor {
            for i in 0..256 {
                c[y * 256 + i] = STONE;
            }
        }
        c
    }

    /// Multi-chunk test world: chunks + their queues, keyed by chunk coords.
    #[derive(Clone, PartialEq, Debug)]
    struct World {
        chunks: BTreeMap<(i32, i32), Box<[u8; CHUNK_VOL]>>,
        queues: BTreeMap<(i32, i32), FluidQueue>,
    }

    impl World {
        fn new(coords: &[(i32, i32)], floor: usize) -> Self {
            let mut chunks = BTreeMap::new();
            let mut queues = BTreeMap::new();
            for &c in coords {
                chunks.insert(c, floor_chunk(floor));
                queues.insert(c, FluidQueue::new());
            }
            World { chunks, queues }
        }

        /// Runs `f` with the neighborhood + queues centered on `(cx, cz)` (center must exist).
        fn with<R>(
            &mut self,
            cx: i32,
            cz: i32,
            f: impl FnOnce(&mut ChunkNeighborhood, &mut FluidQueues) -> R,
        ) -> R {
            let keys = [
                (cx, cz),
                (cx, cz - 1),
                (cx, cz + 1),
                (cx + 1, cz),
                (cx - 1, cz),
            ];
            let mut cs: Vec<Option<Box<[u8; CHUNK_VOL]>>> =
                keys.iter().map(|k| self.chunks.remove(k)).collect();
            let mut qs: Vec<Option<FluidQueue>> =
                keys.iter().map(|k| self.queues.remove(k)).collect();
            let r = {
                let mut ci = cs.iter_mut();
                let center = ci.next().unwrap().as_deref_mut().unwrap();
                let n: Vec<Option<&mut [u8; CHUNK_VOL]>> = ci.map(|c| c.as_deref_mut()).collect();
                let [a, b, c, d]: [Option<&mut [u8; CHUNK_VOL]>; 4] = n.try_into().ok().unwrap();
                let mut world = ChunkNeighborhood::new(cx, cz, center, [a, b, c, d]);
                let qv: Vec<Option<&mut FluidQueue>> = qs.iter_mut().map(|q| q.as_mut()).collect();
                let mut queues: FluidQueues = qv.try_into().ok().unwrap();
                f(&mut world, &mut queues)
            };
            for (i, k) in keys.iter().enumerate() {
                if let Some(c) = cs[i].take() {
                    self.chunks.insert(*k, c);
                }
                if let Some(q) = qs[i].take() {
                    self.queues.insert(*k, q);
                }
            }
            r
        }

        fn get(&self, x: i32, y: i32, z: i32) -> u8 {
            let (cx, lx) = crate::coords::world_to_chunk(x);
            let (cz, lz) = crate::coords::world_to_chunk(z);
            self.chunks[&(cx, cz)][block_index(lx, y as usize, lz)]
        }

        /// Player-style edit: set a block in chunk `(cx, cz)` and notify the fluid queues.
        fn edit(&mut self, x: i32, y: i32, z: i32, b: u8) {
            let (cx, _) = crate::coords::world_to_chunk(x);
            let (cz, _) = crate::coords::world_to_chunk(z);
            self.with(cx, cz, |world, queues| {
                assert!(world.set(x, y, z, b));
                enqueue_neighbors(world, queues, x, y, z);
            });
        }

        /// Ticks every chunk with a non-empty queue (in key order) until all queues drain.
        /// Returns the number of rounds.
        fn run(&mut self, budget: u32, max_rounds: u32) -> u32 {
            for round in 0..max_rounds {
                let busy: Vec<(i32, i32)> = self
                    .queues
                    .iter()
                    .filter(|(_, q)| !q.is_empty())
                    .map(|(k, _)| *k)
                    .collect();
                if busy.is_empty() {
                    return round;
                }
                for (cx, cz) in busy {
                    let n = self.with(cx, cz, |world, queues| step(world, queues, budget));
                    assert!(n <= budget);
                }
            }
            panic!("queues did not drain in {max_rounds} rounds");
        }
    }

    /// Asserts two worlds are equal, reporting the first differing voxels / queues.
    fn assert_same(a: &World, b: &World) {
        for (k, ca) in &a.chunks {
            let cb = &b.chunks[k];
            let diffs: Vec<_> = (0..CHUNK_VOL)
                .filter(|&i| ca[i] != cb[i])
                .map(|i| (i % 16, i / 256, (i / 16) % 16, ca[i], cb[i]))
                .take(12)
                .collect();
            assert!(
                diffs.is_empty(),
                "chunk {k:?} (lx,y,lz,got,want): {diffs:?}"
            );
        }
        for (k, q) in &a.queues {
            assert_eq!(q.len(), b.queues[k].len(), "queue {k:?} length");
        }
    }

    fn manhattan(a: (i32, i32), b: (i32, i32)) -> i32 {
        (a.0 - b.0).abs() + (a.1 - b.1).abs()
    }

    // ---------------------------------------------------------------- queue

    #[test]
    fn queue_layout() {
        assert_eq!(FluidQueue::SIZE, 130);
        assert_eq!(core::mem::size_of::<FluidQueue>(), FluidQueue::SIZE);
        assert_eq!(core::mem::align_of::<FluidQueue>(), 2);
        let q = FluidQueue::new();
        assert!(q.is_empty());
        assert_eq!(q.len(), 0);
    }

    #[test]
    fn queue_push_dedups_and_fills() {
        let mut q = FluidQueue::new();
        assert!(q.push(5));
        assert!(q.push(5));
        assert_eq!(q.len(), 1);
        for i in 0..63u16 {
            assert!(q.push(100 + i));
        }
        assert_eq!(q.len(), 64);
        assert!(!q.push(9999), "full queue drops");
        assert!(q.push(5), "already queued counts as queued even when full");
        assert_eq!(q.len(), 64);
        assert!(!q.push(CHUNK_VOL as u16), "out-of-range index rejected");
        assert_eq!(q.pop(), Some(5));
        assert!(q.push(5), "after pop it can be re-queued");
        assert_eq!(q.len(), 64);
    }

    #[test]
    fn queue_ring_wraps() {
        let mut q = FluidQueue::new();
        let mut next_in = 0u16;
        let mut next_out = 0u16;
        // Keep ~40 in flight while pushing 1000 values: head wraps many times.
        for _ in 0..1000 {
            assert!(q.push(next_in));
            next_in += 1;
            if q.len() > 40 {
                assert_eq!(q.pop(), Some(next_out));
                next_out += 1;
            }
        }
        while let Some(v) = q.pop() {
            assert_eq!(v, next_out);
            next_out += 1;
        }
        assert_eq!(next_out, next_in);
        assert!(q.is_empty());
        assert_eq!(q.pop(), None);
    }

    #[test]
    fn queue_tolerates_corrupt_fields() {
        let mut q = FluidQueue {
            buf: [0xFFFF; 64],
            head: 200,
            len: 250,
        };
        assert_eq!(q.len(), 64);
        assert!(!q.push(1));
        let mut n = 0;
        while q.pop().is_some() {
            n += 1;
        }
        assert_eq!(n, 64);
        assert!(q.push(1));
        assert_eq!(q.pop(), Some(1));
    }

    // ---------------------------------------------------------------- access

    #[test]
    fn neighborhood_access_rules() {
        let mut c = boxed_chunk();
        let mut e = boxed_chunk();
        e[block_index(0, 5, 3)] = Block::Dirt as u8;
        let mut world = ChunkNeighborhood::new(2, -1, &mut c, [None, None, Some(&mut e), None]);
        let (ox, oz) = (32, -16);
        assert_eq!(
            world.get(ox + 16, 5, oz + 3),
            Block::Dirt as u8,
            "east neighbor read"
        );
        assert!(
            world.set(ox + 17, 5, oz + 3, SRC),
            "present neighbor writable"
        );
        assert_eq!(world.get(ox - 1, 5, oz), STONE, "missing west reads stone");
        assert!(
            !world.set(ox - 1, 5, oz, AIR),
            "missing neighbor not writable"
        );
        assert_eq!(world.get(ox + 16, 5, oz - 1), STONE, "diagonal reads stone");
        assert!(!world.set(ox + 16, 5, oz - 1, AIR));
        assert_eq!(world.get(ox + 40, 5, oz), STONE, "far reads stone");
        assert_eq!(
            world.get(ox, -1, oz),
            Block::Bedrock as u8,
            "below world is bedrock"
        );
        assert_eq!(world.get(ox, 64, oz), AIR, "above world is air");
        assert!(!world.set(ox, 64, oz, SRC));
        assert!(!world.set(ox, -1, oz, SRC));
        assert!(world.set(ox + 3, 7, oz + 4, SRC));
        assert_eq!(world.get(ox + 3, 7, oz + 4), SRC);
        assert_eq!(world.get(i32::MAX, 5, i32::MIN), STONE);
        assert_eq!(c[block_index(3, 7, 4)], SRC);
        assert_eq!(e[block_index(1, 5, 3)], SRC);
    }

    // ---------------------------------------------------------------- rules

    #[test]
    fn water_falls_to_floor() {
        let mut wd = World::new(&[(0, 0)], 10);
        wd.edit(8, 40, 8, SRC);
        wd.run(32, 10_000);
        assert_eq!(wd.get(8, 40, 8), SRC);
        for y in 11..40 {
            assert_eq!(wd.get(8, y, 8), w(1), "column y={y}");
        }
        assert_eq!(wd.get(8, 10, 8), STONE);
        // The source over air and the falling column never spread sideways.
        for y in 12..=40 {
            assert_eq!(wd.get(9, y, 8), AIR, "no side spread at y={y}");
            assert_eq!(wd.get(8, y, 7), AIR);
        }
        // The landing Water1 spreads on the floor: levels 2..=7, radius 6.
        for x in 0..16 {
            for z in 0..16 {
                let d = manhattan((x, z), (8, 8));
                let want = match d {
                    0 => w(1),
                    1..=6 => w(d as u8 + 1),
                    _ => AIR,
                };
                assert_eq!(wd.get(x, 11, z), want, "floor ({x},{z}) d={d}");
            }
        }
    }

    #[test]
    fn source_spreads_radius_seven() {
        let mut wd = World::new(&[(0, 0)], 10);
        wd.edit(8, 11, 8, SRC);
        wd.run(32, 10_000);
        for y in 0..CHUNK_H as i32 {
            for x in 0..16 {
                for z in 0..16 {
                    let d = manhattan((x, z), (8, 8));
                    let want = if y <= 10 {
                        STONE
                    } else if y == 11 && d == 0 {
                        SRC
                    } else if y == 11 && d <= 7 {
                        w(d as u8)
                    } else {
                        AIR
                    };
                    assert_eq!(wd.get(x, y, z), want, "({x},{y},{z})");
                }
            }
        }
    }

    #[test]
    fn two_sources_fill_gap_with_source() {
        let mut wd = World::new(&[(0, 0)], 10);
        wd.edit(6, 11, 8, SRC);
        wd.edit(8, 11, 8, SRC);
        wd.run(32, 10_000);
        assert_eq!(wd.get(7, 11, 8), SRC);
        // Neighbors of the gap touch only one source each: they stay flowing.
        assert_eq!(wd.get(7, 11, 7), w(1));
        assert_eq!(wd.get(7, 11, 9), w(1));
        assert_eq!(wd.get(5, 11, 8), w(1));
    }

    #[test]
    fn sources_need_support_for_infinite() {
        // Gap over air: no infinite source.
        let mut wd = World::new(&[(0, 0)], 10);
        wd.edit(7, 10, 8, AIR); // hole under the gap
        wd.edit(6, 11, 8, SRC);
        wd.edit(8, 11, 8, SRC);
        wd.run(32, 10_000);
        assert_eq!(wd.get(7, 11, 8), w(1));
        assert_eq!(wd.get(7, 10, 8), w(1), "fell into the hole");
    }

    #[test]
    fn removing_source_recedes() {
        let mut wd = World::new(&[(0, 0)], 10);
        wd.edit(8, 11, 8, SRC);
        wd.run(32, 10_000);
        assert_eq!(wd.get(8, 11, 15), w(7));
        wd.edit(8, 11, 8, AIR);
        wd.run(32, 10_000);
        let fresh = World::new(&[(0, 0)], 10);
        assert_same(&wd, &fresh);
    }

    #[test]
    fn falling_column_recedes() {
        let mut wd = World::new(&[(0, 0)], 10);
        wd.edit(8, 40, 8, SRC);
        wd.run(32, 10_000);
        wd.edit(8, 40, 8, AIR);
        wd.run(32, 10_000);
        assert_same(&wd, &World::new(&[(0, 0)], 10));
    }

    #[test]
    fn breaking_wall_releases_water() {
        let mut wd = World::new(&[(0, 0)], 10);
        // Source walled in by stone on its +x side.
        wd.edit(9, 11, 8, STONE);
        wd.edit(8, 11, 8, SRC);
        wd.run(32, 10_000);
        assert_eq!(wd.get(9, 11, 8), STONE);
        assert_eq!(wd.get(10, 11, 8), w(4), "around the wall: d=4 path");
        wd.edit(9, 11, 8, AIR);
        wd.run(32, 10_000);
        assert_eq!(wd.get(9, 11, 8), w(1));
        assert_eq!(wd.get(10, 11, 8), w(2));
    }

    #[test]
    fn removing_one_of_two_sources_converges() {
        let mut wd = World::new(&[(0, 0)], 10);
        wd.edit(4, 11, 4, SRC);
        wd.edit(11, 11, 10, SRC);
        wd.run(32, 10_000);
        wd.edit(4, 11, 4, AIR);
        wd.run(32, 10_000);
        let mut only = World::new(&[(0, 0)], 10);
        only.edit(11, 11, 10, SRC);
        only.run(32, 10_000);
        assert_same(&wd, &only);
    }

    /// Every Air/flowing voxel of the center chunk is at its desired state.
    fn assert_fixed_point(wd: &mut World, cx: i32, cz: i32) {
        wd.with(cx, cz, |world, _| {
            for idx in 0..CHUNK_VOL {
                let (x, y, z) = ((idx % 16) as i32, (idx / 256) as i32, ((idx / 16) % 16) as i32);
                let cur = world.fget(x, y, z);
                if updatable(cur) {
                    let d = desired(world, x, y, z, cur);
                    if d != cur {
                        let g = |dx: i32, dy: i32, dz: i32| world.fget(x + dx, y + dy, z + dz);
                        panic!(
                            "({x},{y},{z}) cur {cur} want {d}; above {} below {} E {}/{} W {}/{} S {}/{} N {}/{}",
                            g(0, 1, 0), g(0, -1, 0), g(1, 0, 0), g(1, -1, 0), g(-1, 0, 0), g(-1, -1, 0),
                            g(0, 0, 1), g(0, -1, 1), g(0, 0, -1), g(0, -1, -1)
                        );
                    }
                }
            }
        });
    }

    #[test]
    fn random_worlds_converge_to_fixed_point() {
        let mut st = 0xC0FFEE_u64;
        for _ in 0..50 {
            let mut wd = World::new(&[(0, 0)], 3);
            // Random stone pillars and a few sources/flowing blobs; then notify everything.
            let mut edits = Vec::new();
            for _ in 0..80 {
                let r = splitmix_next(&mut st);
                let (x, y, z) = (
                    (r % 16) as i32,
                    4 + ((r >> 8) % 20) as i32,
                    ((r >> 16) % 16) as i32,
                );
                let b = match (r >> 24) % 6 {
                    0..=2 => STONE,
                    3 => SRC,
                    4 => w(1 + ((r >> 32) % 7) as u8),
                    _ => AIR,
                };
                edits.push((x, y, z, b));
            }
            for &(x, y, z, b) in &edits {
                wd.edit(x, y, z, b);
                // Keep queues from overflowing during setup.
                wd.run(32, 100_000);
            }
            assert_fixed_point(&mut wd, 0, 0);
            // Remove every source again: no water may remain.
            for &(x, y, z, b) in &edits {
                if b == SRC && wd.get(x, y, z) == SRC {
                    wd.edit(x, y, z, AIR);
                    wd.run(32, 100_000);
                }
            }
            assert_fixed_point(&mut wd, 0, 0);
        }
    }

    #[test]
    fn flow_crosses_chunk_border() {
        let mut wd = World::new(&[(0, 0), (1, 0)], 10);
        wd.edit(12, 11, 8, SRC);
        // Tick only the source chunk: the east chunk gets queue entries but no writes.
        for _ in 0..1000 {
            if wd.queues[&(0, 0)].is_empty() {
                break;
            }
            wd.with(0, 0, |world, queues| step(world, queues, 32));
        }
        assert!(wd.queues[&(0, 0)].is_empty());
        assert_eq!(wd.get(15, 11, 8), w(3));
        assert!(
            !wd.queues[&(1, 0)].is_empty(),
            "neighbor queue received entries"
        );
        assert_eq!(
            wd.get(16, 11, 8),
            AIR,
            "center tick never writes the neighbor"
        );
        // Ticking the neighbor continues the flow there.
        wd.run(32, 10_000);
        for x in 16..32 {
            for z in 0..16 {
                let d = manhattan((x, z), (12, 8));
                let want = if d <= 7 { w(d as u8) } else { AIR };
                assert_eq!(wd.get(x, 11, z), want, "east ({x},{z})");
            }
        }
        // And it recedes across the border too.
        wd.edit(12, 11, 8, AIR);
        wd.run(32, 10_000);
        assert_same(&wd, &World::new(&[(0, 0), (1, 0)], 10));
    }

    #[test]
    fn flow_stops_at_missing_neighbor() {
        let mut wd = World::new(&[(0, 0)], 10);
        wd.edit(12, 11, 8, SRC);
        wd.run(32, 10_000);
        assert_eq!(wd.queues.len(), 1);
        for x in 0..16 {
            for z in 0..16 {
                let d = manhattan((x, z), (12, 8));
                let want = if d == 0 {
                    SRC
                } else if d <= 7 {
                    w(d as u8)
                } else {
                    AIR
                };
                assert_eq!(wd.get(x, 11, z), want, "({x},{z})");
            }
        }
        // Missing north neighbor (z < 0) acts as a stone wall too.
        let mut wd = World::new(&[(0, 0)], 10);
        wd.edit(8, 11, 0, SRC);
        wd.run(32, 10_000);
        assert_eq!(wd.get(8, 11, 1), w(1));
        assert_eq!(wd.get(7, 11, 0), w(1));
    }

    #[test]
    fn missing_neighbor_water_is_not_a_feeder() {
        // Water next to the border with the neighbor absent: the neighbor reads as stone,
        // so a source in the absent chunk can never feed the center.
        let mut c = floor_chunk(10);
        let mut q = FluidQueue::new();
        q.push(block_index(0, 11, 8) as u16);
        let mut world = ChunkNeighborhood::new(0, 0, &mut c, [None, None, None, None]);
        let mut queues: FluidQueues = [Some(&mut q), None, None, None, None];
        assert_eq!(step(&mut world, &mut queues, 32), 1);
        assert_eq!(world.get(0, 11, 8), AIR);
    }

    #[test]
    fn budget_respected() {
        let mut c = floor_chunk(10);
        let mut q = FluidQueue::new();
        for i in 0..64u16 {
            q.push(11 * 256 + i);
        }
        c[11 * 256 + 100] = SRC;
        let mut world = ChunkNeighborhood::new(0, 0, &mut c, [None, None, None, None]);
        let mut queues: FluidQueues = [Some(&mut q), None, None, None, None];
        assert_eq!(step(&mut world, &mut queues, 0), 0);
        assert_eq!(step(&mut world, &mut queues, 5), 5);
        let left = queues[0].as_ref().unwrap().len();
        assert!(
            left >= 59,
            "5 popped, possibly some re-pushed (left {left})"
        );
        let n = step(&mut world, &mut queues, 1000);
        assert!(n <= 1000);
        // No center queue: nothing happens.
        let mut none: FluidQueues = [None, None, None, None, None];
        assert_eq!(step(&mut world, &mut none, 32), 0);
    }

    #[test]
    fn deterministic() {
        let scenario = || {
            let mut wd = World::new(&[(0, 0), (1, 0), (0, 1)], 10);
            wd.edit(14, 11, 14, SRC);
            wd.edit(3, 30, 5, SRC);
            wd.edit(15, 10, 10, AIR);
            wd.run(7, 100_000);
            wd.edit(14, 11, 14, AIR);
            wd.run(13, 100_000);
            wd
        };
        assert_eq!(scenario(), scenario());
    }

    #[test]
    fn fuzz_never_panics() {
        let mut st = 0x5EED_F1D0_u64;
        let mut chunks: Vec<Box<[u8; CHUNK_VOL]>> = (0..5).map(|_| boxed_chunk()).collect();
        let mut total = 0u64;
        for iter in 0..300 {
            let mode = splitmix_next(&mut st) % 3;
            for c in chunks.iter_mut() {
                for v in c.iter_mut() {
                    let r = splitmix_next(&mut st);
                    *v = match mode {
                        // Fully random bytes (mostly out-of-palette).
                        0 => r as u8,
                        // Palette-ish: lots of air and water, some solids, some junk.
                        1 => match r % 8 {
                            0..=2 => AIR,
                            3..=5 => 23 + ((r >> 8) % 8) as u8,
                            6 => STONE,
                            _ => (r >> 16) as u8,
                        },
                        // Mostly air with sparse water.
                        _ => {
                            if r.is_multiple_of(16) {
                                23 + ((r >> 8) % 8) as u8
                            } else {
                                AIR
                            }
                        }
                    };
                }
            }
            let mut qs: Vec<FluidQueue> = (0..5)
                .map(|_| {
                    let mut q = FluidQueue::new();
                    for b in q.buf.iter_mut() {
                        let r = splitmix_next(&mut st);
                        *b = if r.is_multiple_of(4) {
                            r as u16
                        } else {
                            (r % CHUNK_VOL as u64) as u16
                        };
                    }
                    let r = splitmix_next(&mut st);
                    q.head = r as u8;
                    q.len = (r >> 8) as u8;
                    q
                })
                .collect();
            let present = splitmix_next(&mut st);
            let cx = (splitmix_next(&mut st) as i32) >> (iter % 32);
            let cz = (splitmix_next(&mut st) as i32) >> (iter % 31);
            let budget = (splitmix_next(&mut st) % 200) as u32;
            let (c0, rest) = chunks.split_first_mut().unwrap();
            let mut it = rest.iter_mut();
            let mut nb = |bit: u64| {
                let c = it.next().unwrap();
                if present >> bit & 1 == 1 {
                    Some(&mut **c)
                } else {
                    None
                }
            };
            let n = [nb(0), nb(1), nb(2), nb(3)];
            let mut world = ChunkNeighborhood::new(cx, cz, c0, n);
            let mut qi = qs.iter_mut();
            let mut qn = |bit: u64| {
                let q = qi.next().unwrap();
                if present >> bit & 1 == 1 {
                    Some(q)
                } else {
                    None
                }
            };
            let mut queues: FluidQueues = [qn(8), qn(4), qn(5), qn(6), qn(7)];
            for _ in 0..3 {
                let n = step(&mut world, &mut queues, budget);
                assert!(n <= budget);
                total += n as u64;
            }
            let x = splitmix_next(&mut st) as i32;
            enqueue_neighbors(&world, &mut queues, x, 5, x);
            enqueue_neighbors(
                &world,
                &mut queues,
                cx.wrapping_mul(16),
                63,
                cz.wrapping_mul(16),
            );
        }
        assert!(total > 0);
    }

    #[test]
    #[ignore]
    fn bench_step() {
        // Worst-ish case: a big recede wave plus a spread, counted per processed entry.
        const REPS: u32 = 200;
        let mut entries = 0u64;
        let t = std::time::Instant::now();
        for r in 0..REPS {
            let mut wd = World::new(&[(0, 0)], 10);
            wd.edit(8, 11 + (r % 3) as i32, 8, SRC);
            let mut n = 0u64;
            for _ in 0..100_000 {
                if wd.queues[&(0, 0)].is_empty() {
                    break;
                }
                n += wd.with(0, 0, |world, queues| step(world, queues, 32)) as u64;
            }
            wd.edit(8, 11 + (r % 3) as i32, 8, AIR);
            for _ in 0..100_000 {
                if wd.queues[&(0, 0)].is_empty() {
                    break;
                }
                n += wd.with(0, 0, |world, queues| step(world, queues, 32)) as u64;
            }
            entries += n;
        }
        let el = t.elapsed();
        println!(
            "fluid step: {} entries/scenario, {:?}/entry (includes test-harness overhead)",
            entries / REPS as u64,
            el / entries as u32
        );
    }
}
