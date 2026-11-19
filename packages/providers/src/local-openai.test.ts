import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localOpenAI } from "./local-openai.ts";
import type { RunRequest } from "./types.ts";

describe("local OpenAI-compatible provider (Ollama)", () => {
  let server: Server;
  let base: string;
  let seen: Record<string, unknown>[];
  let mode: "ok" | "json" | "error" | "hang";

  beforeEach(async () => {
    seen = [];
    mode = "ok";
    server = createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      seen.push({ url: req.url, ...JSON.parse(body || "{}") });
      if (mode === "hang") return; // never answers
      if (mode === "error") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { message: 'model "nope" not found, try pulling it first' } }),
        );
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: mode === "json" ? '{"action":"answer","message":"Szia"}' : "helyi válasz",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  const req = (over: Partial<RunRequest> = {}): RunRequest => ({
    prompt: "összefoglalnád?",
    model: "qwen3:8b",
    cwd: "/tmp",
    tools: [],
    allowedTools: [],
    timeoutMs: 5000,
    ...over,
  });

  it("sends a chat completion with the system prompt and a keep-alive TTL", async () => {
    const res = await localOpenAI({ baseUrl: base }).run(req({ appendSystemPrompt: "légy rövid" }));
    expect(res).toMatchObject({ ok: true, stopReason: "completed", text: "helyi válasz" });
    expect(res.usage).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    });
    expect(seen[0]).toMatchObject({
      url: "/v1/chat/completions",
      model: "qwen3:8b",
      stream: false,
      keep_alive: "5m",
      messages: [
        { role: "system", content: "légy rövid" },
        { role: "user", content: "összefoglalnád?" },
      ],
    });
  });

  it("asks for structured output and parses it", async () => {
    mode = "json";
    const schema = { type: "object", properties: { action: { type: "string" } } };
    const res = await localOpenAI({ baseUrl: base }).run(req({ jsonSchema: schema }));
    expect(res.structured).toEqual({ action: "answer", message: "Szia" });
    expect(seen[0]?.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "result", schema },
    });
  });

  it("refuses runs that need tools instead of silently dropping them", async () => {
    const res = await localOpenAI({ baseUrl: base }).run(req({ tools: ["Bash"] }));
    expect(res).toMatchObject({ ok: false, stopReason: "error" });
    expect(res.error).toMatch(/tools/);
    expect(seen).toEqual([]);
  });

  it("reports server errors and an unreachable server clearly", async () => {
    mode = "error";
    const res = await localOpenAI({ baseUrl: base }).run(req({ model: "nope" }));
    expect(res).toMatchObject({ ok: false, stopReason: "error" });
    expect(res.error).toMatch(/not found/);

    const down = await localOpenAI({ baseUrl: "http://127.0.0.1:1/v1" }).run(req());
    expect(down).toMatchObject({ ok: false, stopReason: "error" });
    expect(down.error).toMatch(/not reachable/);
  });

  it("times out and can be cancelled", async () => {
    mode = "hang";
    const t = await localOpenAI({ baseUrl: base }).run(req({ timeoutMs: 200 }));
    expect(t).toMatchObject({ ok: false, stopReason: "timeout" });
    const ctl = new AbortController();
    const running = localOpenAI({ baseUrl: base }).run(req({ signal: ctl.signal }));
    setTimeout(() => ctl.abort(), 50);
    expect(await running).toMatchObject({ ok: false, stopReason: "cancelled" });
  });
});
