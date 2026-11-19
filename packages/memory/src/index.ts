// Long-term memory: SQLite FTS5 + sqlite-vec, local embeddings (ADR-0008).
export const PACKAGE_NAME = "@achords/memory";

export {
  type Embedder,
  type Hit,
  type Memory,
  type MemoryKind,
  ollamaEmbedder,
  openMemory,
} from "./memory.ts";
