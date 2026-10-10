// Web Worker: meshes chunks off the main thread. Request `{ id, input }` → reply
// `{ id, mesh, ms }` with every typed array transferred (no copies back).
import { meshChunk, type ChunkMesh, type MeshInput } from "./mesher";

export type MeshRequest = { id: number; input: MeshInput };
export type MeshReply = { id: number; mesh: ChunkMesh; ms: number } | { id: number; error: string };

const transfers = (m: ChunkMesh): Transferable[] =>
  [m.opaque, m.cutout, m.water].flatMap((a) => [a.positions.buffer, a.normals.buffer, a.uvs.buffer, a.colors.buffer, a.dark.buffer, a.indices.buffer]);

self.onmessage = (e: MessageEvent<MeshRequest>) => {
  const { id, input } = e.data;
  try {
    const t0 = performance.now();
    const mesh = meshChunk(input);
    const reply: MeshReply = { id, mesh, ms: performance.now() - t0 };
    (self as unknown as Worker).postMessage(reply, transfers(mesh));
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) } satisfies MeshReply);
  }
};
