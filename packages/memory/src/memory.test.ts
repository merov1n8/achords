import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type Embedder, ollamaEmbedder, openMemory } from "./memory.ts";

/** Deterministic toy embedder: bag of words hashed into 16 dims, normalised. */
function fakeEmbedder(available = true): Embedder & { calls: number } {
  const e = {
    dims: 16,
    calls: 0,
    async embed(texts: string[]) {
      e.calls++;
      if (!available) return undefined;
      return texts.map((t) => {
        const v = new Array(16).fill(0);
        for (const w of t.toLowerCase().match(/\p{L}+/gu) ?? []) {
          let h = 0;
          for (const ch of w) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 16;
          v[h] += 1;
        }
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
  };
  return e;
}

describe("memory", () => {
  it("finds memories by keyword within the requested workspaces only", async () => {
    const m = openMemory(":memory:", { dims: 16 });
    const emb = fakeEmbedder();
    await m.add(
      { workspace: "web-clients", kind: "decision", content: "Acme wants a static HTML TODO app" },
      emb,
    );
    await m.add({ workspace: "studio", kind: "fact", content: "The Unity game uses URP" }, emb);
    await m.add(
      { workspace: "shared", kind: "fact", content: "Owner prefers Hungarian replies" },
      emb,
    );

    const hits = await m.search("Acme TODO", { workspaces: ["web-clients", "shared"] }, emb);
    expect(hits[0]?.content).toContain("Acme");
    expect(hits.every((h) => h.workspace !== "studio")).toBe(true);
    m.close();
  });

  it("fuses keyword and vector rankings (RRF): a semantic-only match still surfaces", async () => {
    const m = openMemory(":memory:", { dims: 16 });
    const emb = fakeEmbedder();
    await m.add({ workspace: "w", kind: "fact", content: "invoice invoice invoice" }, emb);
    await m.add({ workspace: "w", kind: "fact", content: "something unrelated entirely" }, emb);
    const hits = await m.search("invoices invoice", { workspaces: ["w"] }, emb);
    expect(hits[0]?.content).toBe("invoice invoice invoice");
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it("works without embeddings (Ollama down) and backfills vectors later", async () => {
    const m = openMemory(":memory:", { dims: 16 });
    const down = fakeEmbedder(false);
    await m.add({ workspace: "w", kind: "fact", content: "Mac Mini has 32 GB RAM" }, down);
    expect((await m.search("Mini RAM", { workspaces: ["w"] }, down))[0]?.content).toContain(
      "Mac Mini",
    );
    expect(m.pendingEmbeddings()).toBe(1);
    const up = fakeEmbedder();
    expect(await m.backfill(up)).toBe(1);
    expect(m.pendingEmbeddings()).toBe(0);
    m.close();
  });

  it("tolerates search syntax in queries (no FTS injection errors)", async () => {
    const m = openMemory(":memory:", { dims: 16 });
    await m.add({ workspace: "w", kind: "note", content: "quotes and stars" }, fakeEmbedder());
    for (const q of ['"unbalanced', "a* OR NOT(", "-- ; DROP", ""]) {
      await expect(m.search(q, { workspaces: ["w"] }, fakeEmbedder())).resolves.toBeInstanceOf(
        Array,
      );
    }
    m.close();
  });

  it("refuses to reopen a memory store with a different embedding size", () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/achords-mem-${process.pid}-${Date.now()}.db`;
    openMemory(path, { dims: 16 }).close();
    expect(() => openMemory(path, { dims: 768 })).toThrow(/dimension/);
  });
});

describe("ollamaEmbedder", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise((r) => server?.close(r));
    server = undefined;
  });

  it("calls the local /api/embed and returns vectors; undefined when Ollama is down", async () => {
    let seen: Record<string, unknown> = {};
    server = createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      seen = { url: req.url, ...JSON.parse(body) };
      res.end(JSON.stringify({ embeddings: [[0.1, 0.2]] }));
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const e = ollamaEmbedder({ baseUrl: url, dims: 2 });
    expect(await e.embed(["hello"])).toEqual([[0.1, 0.2]]);
    expect(seen).toMatchObject({ url: "/api/embed", model: "nomic-embed-text", input: ["hello"] });
    expect(
      await ollamaEmbedder({ baseUrl: "http://127.0.0.1:1", dims: 2 }).embed(["x"]),
    ).toBeUndefined();
  });
});
