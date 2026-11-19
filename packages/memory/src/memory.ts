import { DatabaseSync } from "node:sqlite";
import { migrate, migrationsFromDir } from "@achords/core";
import { getLoadablePath } from "sqlite-vec";

export type MemoryKind = "fact" | "decision" | "summary" | "note";

export interface Embedder {
  readonly dims: number;
  /** Returns one vector per text, or undefined if the local embedding model is unavailable. */
  embed(texts: string[]): Promise<number[][] | undefined>;
}

export interface Hit {
  id: number;
  workspace: string;
  kind: MemoryKind;
  content: string;
  source: string | null;
  createdAt: number;
  score: number;
}

export interface Memory {
  add(
    m: { workspace: string; kind: MemoryKind; content: string; source?: string },
    embedder?: Embedder,
  ): Promise<number>;
  search(
    query: string,
    opts: { workspaces: string[]; limit?: number },
    embedder?: Embedder,
  ): Promise<Hit[]>;
  /** Embeds memories stored while the embedding model was unavailable. Returns how many. */
  backfill(embedder: Embedder): Promise<number>;
  pendingEmbeddings(): number;
  close(): void;
}

const MIGRATIONS = new URL("./migrations/", import.meta.url);
const RRF_K = 60;
const CANDIDATES = 50;

const vec = (v: number[]) => new Uint8Array(new Float32Array(v).buffer);

/** Every word quoted and OR-ed: user text can never be parsed as FTS5 syntax. */
function ftsQuery(text: string): string | undefined {
  const words = text.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 32);
  return words?.length ? words.map((w) => `"${w}"`).join(" OR ") : undefined;
}

/**
 * Long-term memory (ADR-0008): FTS5 keyword search and sqlite-vec similarity search over local
 * embeddings, fused with Reciprocal Rank Fusion. Embeddings never leave the machine.
 */
export function openMemory(path: string, opts: { dims: number }): Memory {
  const db = new DatabaseSync(path, { allowExtension: true });
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.loadExtension(getLoadablePath());
  db.enableLoadExtension(false);
  migrate(db, migrationsFromDir(MIGRATIONS));

  const stored = db.prepare("SELECT value FROM meta WHERE key = 'dims'").get();
  if (stored && Number(stored.value) !== opts.dims) {
    db.close();
    throw new Error(`memory store uses embedding dimension ${stored.value}, not ${opts.dims}`);
  }
  if (!stored)
    db.prepare("INSERT INTO meta (key, value) VALUES ('dims', ?)").run(String(opts.dims));
  // vec0 needs the dimension at creation time, so this table lives outside the migrations.
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(embedding float[${opts.dims}])`,
  );

  const storeVector = (id: number, v: number[]) => {
    db.prepare("INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)").run(BigInt(id), vec(v));
    db.prepare("UPDATE memories SET has_vec = 1 WHERE id = ?").run(id);
  };

  const toHit = (r: Record<string, unknown>, score: number): Hit => ({
    id: Number(r.id),
    workspace: r.workspace as string,
    kind: r.kind as MemoryKind,
    content: r.content as string,
    source: r.source as string | null,
    createdAt: Number(r.created_at),
    score,
  });

  return {
    async add(m, embedder) {
      const row = db
        .prepare(
          `INSERT INTO memories (workspace, kind, content, source, created_at)
           VALUES (?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(m.workspace, m.kind, m.content, m.source ?? null, Date.now());
      const id = Number(row?.id);
      const [v] = (await embedder?.embed([m.content])) ?? [];
      if (v) storeVector(id, v);
      return id;
    },

    async search(query, { workspaces, limit = 5 }, embedder) {
      if (workspaces.length === 0) return [];
      const inWs = `(${workspaces.map(() => "?").join(",")})`;
      const ranks = new Map<number, number>();
      const fuse = (ids: number[]) => {
        for (const [i, id] of ids.entries())
          ranks.set(id, (ranks.get(id) ?? 0) + 1 / (RRF_K + i + 1));
      };

      const q = ftsQuery(query);
      if (q) {
        const ids = db
          .prepare(
            `SELECT m.id FROM memories_fts f JOIN memories m ON m.id = f.rowid
             WHERE memories_fts MATCH ? AND m.workspace IN ${inWs}
             ORDER BY bm25(memories_fts) LIMIT ${CANDIDATES}`,
          )
          .all(q, ...workspaces)
          .map((r) => Number(r.id));
        fuse(ids);
      }
      const [qv] = (query.trim() && (await embedder?.embed([query]))) || [];
      if (qv) {
        // KNN first, then the workspace filter (vec0 has no join pushdown here).
        const ids = db
          .prepare(
            `SELECT v.rowid AS id FROM memories_vec v JOIN memories m ON m.id = v.rowid
             WHERE v.embedding MATCH ? AND k = ${CANDIDATES} AND m.workspace IN ${inWs}
             ORDER BY v.distance`,
          )
          .all(vec(qv), ...workspaces)
          .map((r) => Number(r.id));
        fuse(ids);
      }

      const top = [...ranks.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
      const get = db.prepare("SELECT * FROM memories WHERE id = ?");
      return top.map(([id, score]) => toHit(get.get(id) as Record<string, unknown>, score));
    },

    async backfill(embedder) {
      const rows = db.prepare("SELECT id, content FROM memories WHERE has_vec = 0 LIMIT 100").all();
      if (rows.length === 0) return 0;
      const vectors = await embedder.embed(rows.map((r) => r.content as string));
      if (!vectors) return 0;
      rows.forEach((r, i) => {
        const v = vectors[i];
        if (v) storeVector(Number(r.id), v);
      });
      return rows.length;
    },

    pendingEmbeddings: () =>
      Number(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE has_vec = 0").get()?.n),

    close: () => db.close(),
  };
}

/** Embeddings from the local Ollama (`/api/embed`); undefined when it is not reachable. */
export function ollamaEmbedder(
  opts: { baseUrl?: string; model?: string; dims?: number } = {},
): Embedder {
  const base = opts.baseUrl ?? "http://127.0.0.1:11434";
  const model = opts.model ?? "nomic-embed-text";
  return {
    dims: opts.dims ?? 768,
    async embed(texts) {
      try {
        const res = await fetch(`${base}/api/embed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, input: texts }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) return undefined;
        const body = (await res.json()) as { embeddings?: number[][] };
        return body.embeddings?.length === texts.length ? body.embeddings : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
