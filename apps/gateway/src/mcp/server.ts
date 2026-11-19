// The hub's own MCP server (ADR-0029), started by the agent CLI over stdio for one run.
// Minimal MCP: initialize, tools/list, tools/call. It holds no authority of its own: every call
// is forwarded to the gateway with the run token, and the gateway decides who the caller is.
import { createInterface } from "node:readline";

const HUB = process.env.ACHORDS_HUB_URL ?? "";
const TOKEN = process.env.ACHORDS_RUN_TOKEN ?? "";
const DEFAULT_PROTOCOL = "2025-06-18";

const TOOLS = [
  {
    name: "delegate",
    description:
      "Hand part of your task to another agent. It runs with its own permissions; you get its result when it finishes (your task resumes then). Only agents your manifest allows.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Target agent id" },
        title: { type: "string", description: "Short task title" },
        instructions: {
          type: "string",
          description: "Complete, self-contained instructions (the agent sees nothing else)",
        },
      },
      required: ["agent", "title", "instructions"],
      additionalProperties: false,
    },
    endpoint: "/api/agent/delegate",
  },
] as const;

type Json = Record<string, unknown>;

const send = (msg: Json) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const text = (t: string, isError = false) => ({
  content: [{ type: "text", text: t }],
  ...(isError ? { isError } : {}),
});

async function callTool(name: string, args: Json): Promise<Json> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  for (const key of tool.inputSchema.required) {
    if (typeof args[key] !== "string" || !(args[key] as string).trim()) {
      return text(`invalid arguments: ${key} must be a non-empty string`, true);
    }
  }
  // Only the declared fields are forwarded; anything else the model adds is dropped.
  const body = Object.fromEntries(
    Object.keys(tool.inputSchema.properties).map((k) => [k, args[k]]),
  );
  try {
    const res = await fetch(`${HUB}${tool.endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const out = (await res.json()) as {
      ok?: boolean;
      taskId?: string;
      reason?: string;
      error?: string;
    };
    if (out.ok) {
      return text(
        `Delegated as task ${out.taskId}. End your turn now; you will be resumed with the result.`,
      );
    }
    return text(`Refused: ${out.reason ?? out.error ?? `HTTP ${res.status}`}`, true);
  } catch (err) {
    return text(`hub not reachable: ${(err as Error).name}`, true);
  }
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg: Json;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "parse error" } });
  }
  const { id, method } = msg as { id?: number | string; method?: string };
  const params = (msg.params ?? {}) as Json;
  if (id === undefined) return; // notifications (e.g. notifications/initialized)
  try {
    if (method === "initialize") {
      return send({
        id,
        result: {
          protocolVersion: (params.protocolVersion as string) ?? DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "achords", version: "0.1.0" },
        },
      });
    }
    if (method === "tools/list") {
      return send({ id, result: { tools: TOOLS.map(({ endpoint: _, ...t }) => t) } });
    }
    if (method === "tools/call") {
      return send({
        id,
        result: await callTool(String(params.name), (params.arguments ?? {}) as Json),
      });
    }
    if (method === "ping") return send({ id, result: {} });
    send({ id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (err) {
    const e = err as Error & { code?: number };
    send({ id, error: { code: e.code ?? -32603, message: e.message } });
  }
});
