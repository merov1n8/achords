// The hub's own MCP server (ADR-0029), started by the agent CLI over stdio for one run. Built on
// the official MCP SDK. It holds no authority of its own: every call is forwarded to the gateway
// with the run token, and the gateway decides who the caller is.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const HUB = process.env.ACHORDS_HUB_URL ?? "";
const TOKEN = process.env.ACHORDS_RUN_TOKEN ?? "";
// Tools granted to this run; the gateway checks again, this only keeps the model's view honest.
const GRANTED = new Set((process.env.ACHORDS_TOOLS ?? "").split(",").filter(Boolean));

const text = z.string().trim().min(1, "must be a non-empty string");
const list = z.array(z.string(), "must be a list of strings");

const TOOLS = [
  {
    name: "delegate",
    description:
      "Hand part of your task to another agent. It runs with its own permissions; you get its result when it finishes (your task resumes then). Only agents your manifest allows.",
    input: z.object({
      agent: text.describe("Target agent id"),
      title: text.describe("Short task title"),
      instructions: text.describe(
        "Complete, self-contained instructions (the agent sees nothing else)",
      ),
    }),
    endpoint: "/api/agent/delegate",
    done: "Delegated as task {taskId}. End your turn now; you will be resumed with the result.",
  },
  {
    name: "ask_owner",
    description:
      "Ask the owner a question you cannot answer yourself (missing decision or information). It reaches them in the original conversation; your task resumes with their answer.",
    input: z.object({ question: text.describe("One short, specific question") }),
    endpoint: "/api/agent/ask_owner",
    done: "Question sent to the owner. End your turn now; you will be resumed with the answer.",
  },
  {
    name: "spawn_worker",
    description:
      "Start a short-lived helper for a self-contained subtask, with a subset of YOUR OWN tools and write paths (anything beyond them is refused). Max 3 per task; helpers cannot delegate or spawn. You resume with its result.",
    input: z.object({
      instructions: text.describe("Complete instructions for the helper"),
      tools: list.describe("Subset of your tools"),
      paths: list.describe("Absolute paths inside your own write paths (may be empty)"),
    }),
    endpoint: "/api/agent/spawn_worker",
    done: "Worker started as task {taskId}. End your turn now; you will be resumed with its result.",
  },
  {
    name: "propose_agent",
    description:
      "Propose a new persistent agent (full agent.yaml). Nothing is created until the owner approves it.",
    input: z.object({
      manifest_yaml: text.describe("Complete agent.yaml"),
      reason: text.describe("Why this agent is needed"),
    }),
    endpoint: "/api/agent/propose_agent",
    done: "Proposal filed; the owner decides. Continue your task without the new agent.",
  },
  {
    name: "open_room",
    description:
      "Open a short discussion with up to 3 agents you may delegate to (1-3 rounds, each speaks once per round, read-only). End your turn after opening; you resume with the transcript and write the decision.",
    input: z.object({
      topic: text.describe("Short topic"),
      question: text.describe("What the participants should decide or advise on"),
      participants: list.describe("Agent ids, speaking order"),
      rounds: text.describe("Number of rounds, 1-3"),
    }),
    endpoint: "/api/agent/open_room",
    done: "Discussion opened. End your turn now; you will be resumed with the transcript.",
  },
  {
    name: "move_task",
    description:
      "Move a kanban card to another column (e.g. your finished work to review, or reviewed work to done). Only moves the workspace workflow allows for your role are accepted; some need the owner's approval.",
    input: z.object({
      task_id: text.describe("The card's task id"),
      to: text.describe("Target column, e.g. review or done"),
    }),
    endpoint: "/api/agent/move_task",
    done: "Card moved.",
  },
];

const reply = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  ...(isError ? { isError } : {}),
});

async function forward(endpoint: string, done: string, body: unknown) {
  try {
    const res = await fetch(`${HUB}${endpoint}`, {
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
      return reply("Move requested; the owner decides. Continue or finish your turn.");
    if (out.ok) return reply(done.replace("{taskId}", out.taskId ?? ""));
    return reply(`Refused: ${out.reason ?? out.error ?? `HTTP ${res.status}`}`, true);
  } catch (err) {
    return reply(`hub not reachable: ${(err as Error).name}`, true);
  }
}

serveStdio(() => {
  const server = new McpServer({ name: "achords", version: "0.1.0" });
  for (const tool of TOOLS.filter((t) => GRANTED.has(t.name))) {
    // The SDK validates against the schema and passes only the declared fields on.
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input },
      (args: unknown) => forward(tool.endpoint, tool.done, args),
    );
  }
  return server;
});
