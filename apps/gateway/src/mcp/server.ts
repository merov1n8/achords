// The hub's own MCP server (ADR-0029), started by the agent CLI over stdio for one run.
// Minimal MCP: initialize, tools/list, tools/call. It holds no authority of its own: every call
// is forwarded to the gateway with the run token, and the gateway decides who the caller is.
import { createInterface } from "node:readline";

const HUB = process.env.ACHORDS_HUB_URL ?? "";
const TOKEN = process.env.ACHORDS_RUN_TOKEN ?? "";
// Tools granted to this run; the gateway checks again, this only keeps the model's view honest.
const GRANTED = new Set((process.env.ACHORDS_TOOLS ?? "").split(",").filter(Boolean));
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
    done: "Delegated as task {taskId}. End your turn now; you will be resumed with the result.",
  },
  {
    name: "ask_owner",
    description:
      "Ask the owner a question you cannot answer yourself (missing decision or information). It reaches them in the original conversation; your task resumes with their answer.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", description: "One short, specific question" } },
      required: ["question"],
      additionalProperties: false,
    },
    endpoint: "/api/agent/ask_owner",
    done: "Question sent to the owner. End your turn now; you will be resumed with the answer.",
  },
  {
    name: "spawn_worker",
    description:
      "Start a short-lived helper for a self-contained subtask, with a subset of YOUR OWN tools and write paths (anything beyond them is refused). Max 3 per task; helpers cannot delegate or spawn. You resume with its result.",
    inputSchema: {
      type: "object",
      properties: {
        instructions: { type: "string", description: "Complete instructions for the helper" },
        tools: { type: "array", items: { type: "string" }, description: "Subset of your tools" },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Absolute paths inside your own write paths (may be empty)",
        },
      },
      required: ["instructions", "tools", "paths"],
      additionalProperties: false,
    },
    endpoint: "/api/agent/spawn_worker",
    done: "Worker started as task {taskId}. End your turn now; you will be resumed with its result.",
  },
  {
    name: "propose_agent",
    description:
      "Propose a new persistent agent (full agent.yaml). Nothing is created until the owner approves it.",
    inputSchema: {
      type: "object",
      properties: {
        manifest_yaml: { type: "string", description: "Complete agent.yaml" },
        reason: { type: "string", description: "Why this agent is needed" },
      },
      required: ["manifest_yaml", "reason"],
      additionalProperties: false,
    },
    endpoint: "/api/agent/propose_agent",
    done: "Proposal filed; the owner decides. Continue your task without the new agent.",
  },
  {
    name: "open_room",
    description:
      "Open a short discussion with up to 3 agents you may delegate to (1-3 rounds, each speaks once per round, read-only). End your turn after opening; you resume with the transcript and write the decision.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Short topic" },
        question: {
          type: "string",
          description: "What the participants should decide or advise on",
        },
        participants: {
          type: "array",
          items: { type: "string" },
          description: "Agent ids, speaking order",
        },
        rounds: { type: "string", description: "Number of rounds, 1-3" },
      },
      required: ["topic", "question", "participants", "rounds"],
      additionalProperties: false,
    },
    endpoint: "/api/agent/open_room",
    done: "Discussion opened. End your turn now; you will be resumed with the transcript.",
  },
  {
    name: "move_task",
    description:
      "Move a kanban card to another column (e.g. your finished work to review, or reviewed work to done). Only moves the workspace workflow allows for your role are accepted; some need the owner's approval.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The card's task id" },
        to: { type: "string", description: "Target column, e.g. review or done" },
      },
      required: ["task_id", "to"],
      additionalProperties: false,
    },
    endpoint: "/api/agent/move_task",
    done: "Card moved.",
  },
] as const;

const granted = () => TOOLS.filter((t) => GRANTED.has(t.name));

type Json = Record<string, unknown>;

const send = (msg: Json) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const text = (t: string, isError = false) => ({
  content: [{ type: "text", text: t }],
  ...(isError ? { isError } : {}),
});

async function callTool(name: string, args: Json): Promise<Json> {
  const tool = granted().find((t) => t.name === name);
  if (!tool) throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  const props = tool.inputSchema.properties as Record<string, { type: string }>;
  for (const key of tool.inputSchema.required) {
    const v = args[key];
    if (props[key]?.type === "array") {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
        return text(`invalid arguments: ${key} must be a list of strings`, true);
      }
    } else if (typeof v !== "string" || !v.trim()) {
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
      pending?: boolean;
      taskId?: string;
      reason?: string;
      error?: string;
    };
    if (out.ok && out.pending)
      return text("Move requested; the owner decides. Continue or finish your turn.");
    if (out.ok) return text(tool.done.replace("{taskId}", out.taskId ?? ""));
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
      return send({
        id,
        result: { tools: granted().map(({ endpoint: _e, done: _d, ...t }) => t) },
      });
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
