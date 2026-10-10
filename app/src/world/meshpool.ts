// A small pool of mesher workers. `request(key, input)` coalesces per key: while a key is
// queued (not yet dispatched) a newer request replaces the input thunk, which is evaluated
// at dispatch so the worker always gets the freshest blocks. Results for a key are
// delivered in request order; a result superseded by a newer dispatched request is dropped.
import type { ChunkMesh, MeshInput } from "./mesher";
import type { MeshReply, MeshRequest } from "./mesher.worker";

type Job = { key: string; input: () => MeshInput | null; done: (m: ChunkMesh | null, ms: number) => void };

export class MeshPool {
  private workers: { w: Worker; busy: boolean }[] = [];
  private queue: Job[] = [];
  private queued = new Map<string, Job>();
  private pending = new Map<number, { job: Job; seq: number; w: { w: Worker; busy: boolean } }>();
  private latest = new Map<string, number>();
  private nextId = 1;
  /** Mesh times (worker-side ms), last 200. */
  readonly times: number[] = [];

  constructor(size = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1))) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL("./mesher.worker.ts", import.meta.url), { type: "module" });
      const slot = { w, busy: false };
      w.onmessage = (e: MessageEvent<MeshReply>) => this.reply(e.data);
      w.onerror = (e) => this.crashed(slot, e.message);
      this.workers.push(slot);
    }
  }

  request(key: string, input: () => MeshInput | null, done: Job["done"]) {
    const q = this.queued.get(key);
    if (q) {
      q.input = input;
      q.done = done;
      return;
    }
    const job: Job = { key, input, done };
    this.queued.set(key, job);
    this.queue.push(job);
    this.pump();
  }

  /** Drops queued (not dispatched) work for keys not in `keep`. */
  prune(keep: (key: string) => boolean) {
    this.queue = this.queue.filter((j) => keep(j.key) || (this.queued.delete(j.key), false));
    for (const k of this.latest.keys()) if (!keep(k)) this.latest.delete(k);
  }

  get backlog() {
    return this.queue.length + this.pending.size;
  }

  private pump() {
    for (const slot of this.workers) {
      if (slot.busy) continue;
      let job: Job | undefined;
      let input: MeshInput | null = null;
      while ((job = this.queue.shift())) {
        this.queued.delete(job.key);
        input = job.input();
        if (input) break;
        job.done(null, 0); // nothing to mesh any more (unloaded / no blocks)
      }
      if (!job || !input) return;
      const id = this.nextId++;
      const seq = id;
      this.latest.set(job.key, seq);
      slot.busy = true;
      this.pending.set(id, { job, seq, w: slot });
      const msg: MeshRequest = { id, input };
      const extra = [...input.borders, ...(input.around ?? [])].flatMap((b) => (b ? [b.buffer] : []));
      slot.w.postMessage(msg, [input.blocks.buffer, ...extra]);
    }
  }

  /** A worker error outside a reply: free its slot and fail its job (the chunk keeps its
   *  previous mesh; the next change re-requests it). */
  private crashed(slot: { w: Worker; busy: boolean }, msg: string) {
    console.error("mesher worker error", msg);
    for (const [id, p] of this.pending)
      if (p.w === slot) {
        this.pending.delete(id);
        if (this.latest.get(p.job.key) === p.seq) this.latest.delete(p.job.key);
        console.error("meshing failed", p.job.key);
      }
    slot.busy = false;
    this.pump();
  }

  private reply(r: MeshReply) {
    const p = this.pending.get(r.id);
    if (!p) return;
    this.pending.delete(r.id);
    p.w.busy = false;
    if ("error" in r) console.error("meshing failed", p.job.key, r.error); // previous mesh stays
    else {
      this.times.push(r.ms);
      if (this.times.length > 200) this.times.shift();
      if (this.latest.get(p.job.key) === p.seq) p.job.done(r.mesh, r.ms);
    }
    if (this.latest.get(p.job.key) === p.seq) this.latest.delete(p.job.key);
    this.pump();
  }

  dispose() {
    for (const s of this.workers) s.w.terminate();
    this.workers = [];
    this.queue = [];
    this.queued.clear();
    this.pending.clear();
    this.latest.clear();
  }
}
