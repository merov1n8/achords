import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendMessage,
  type Channel,
  claim,
  complete,
  type Db,
  enqueue,
  extendLease,
  fail,
  finishRun,
  getTask,
  isPaused,
  listMessages,
  setRunPid,
  startRun,
  type Task,
  upsertAgent,
} from "@achords/core";
import { checkModel, loadAgents, type Manifest } from "@achords/policy";
import type { ModelProvider, RunRequest } from "@achords/providers";
import { z } from "zod";

const BOSS_ID = "boss";
const WORKER_ID = "gateway";
const LEASE_MS = 10 * 60_000;
const BOSS_TIMEOUT_MS = 3 * 60_000;
const RUN_TIMEOUT_MS = 30 * 60_000;
const HISTORY = 20;
const MAX_POST = 4000;

const decisionSchema = z.object({
  action: z.enum(["answer", "ask", "delegate"]),
  message: z.string().min(1).describe("What the owner reads. One line for delegate."),
  task: z
    .object({
      title: z.string().min(1),
      description: z.string().min(1).describe("Self-contained instructions for the agent"),
      assignee: z.string().min(1).describe("Agent id from the list"),
      language: z
        .string()
        .min(1)
        .describe("Language the owner writes in (e.g. Hungarian); the agent reports in it"),
    })
    .optional(),
});
// The claude CLI's validator rejects zod's draft 2020-12 `$schema` reference; the rest is plain.
const { $schema: _, ...DECISION_JSON_SCHEMA } = z.toJSONSchema(decisionSchema);

export interface OrchestratorDeps {
  db: Db;
  home: string;
  /** Keyed by the provider part of a manifest model id, e.g. "cli-claude". */
  providers: Record<string, ModelProvider>;
  /** Applied to everything posted to threads (ADR-0012). */
  redact?: (text: string) => string;
}

export interface Orchestrator {
  handleMessage(
    threadId: string,
    text: string,
    channel: Channel,
  ): Promise<"answer" | "ask" | "delegate" | "error">;
  /** Loads manifests and mirrors them into the DB. Returns the agent ids. */
  syncAgents(): string[];
  /** Claims and runs one task. Returns false if there was nothing to do. */
  workOnce(signal?: AbortSignal): Promise<boolean>;
}

const expandHome = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const { db, home } = deps;
  const redact = deps.redact ?? ((s: string) => s);
  const agentsDir = join(home, "agents");

  // Re-read on every use so manifest edits apply without a restart; mirrored into the DB
  // because tasks reference agents by id.
  const agents = () => {
    const all = loadAgents(agentsDir);
    for (const m of all.values()) upsertAgent(db, m);
    return all;
  };

  const post = (threadId: string, content: string) =>
    appendMessage(db, {
      threadId,
      role: "agent",
      author: BOSS_ID,
      channel: "system",
      content: redact(content).slice(0, MAX_POST),
    });

  const agentPrompt = (m: Manifest) => {
    const path = join(agentsDir, m.id, "prompt.md");
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  };

  /** Policy → run request. Throws with a reason if the manifest does not allow the run. */
  const toRequest = (m: Manifest, prompt: string, timeoutMs: number) => {
    const model = m.models.default;
    const decision = checkModel(m, model);
    if (!decision.allowed) throw new Error(decision.reason);
    const slash = model.indexOf("/");
    const provider = deps.providers[model.slice(0, slash)];
    if (!provider) throw new Error(`no provider for ${model}`);

    const roots = [...m.fs.write, ...m.fs.read].map(expandHome);
    const cwd = roots[0] ?? join(agentsDir, m.id, "work");
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    // Bash is available only through allow-listed command prefixes; anything else is denied
    // in print mode (interactive approvals come with the channels).
    const allowedTools = [
      ...m.tools.filter((t) => t !== "Bash"),
      ...(m.tools.includes("Bash") ? (m.shell?.allow ?? []).map((c) => `Bash(${c}:*)`) : []),
    ];
    const system = agentPrompt(m);
    const req: RunRequest = {
      prompt,
      model: model.slice(slash + 1),
      cwd,
      tools: m.tools,
      allowedTools,
      timeoutMs,
      ...(roots.length > 1 ? { addDirs: roots.slice(1) } : {}),
      ...(system ? { appendSystemPrompt: system } : {}),
      ...(m.budget.per_run_usd ? { maxBudgetUsd: m.budget.per_run_usd } : {}),
    };
    return { provider, req };
  };

  return {
    syncAgents: () => [...agents().keys()],

    async handleMessage(threadId, text, channel) {
      appendMessage(db, { threadId, role: "user", channel, content: text });
      try {
        const all = agents();
        const boss = all.get(BOSS_ID);
        if (!boss) throw new Error("boss agent is not configured");
        const team = [...all.values()]
          .filter((m) => m.id !== BOSS_ID)
          .map((m) => `- ${m.id}: ${m.name} (${m.role}, workspace ${m.workspace})`)
          .join("\n");
        const history = listMessages(db, threadId)
          .slice(-HISTORY)
          .map((m) => `${m.role === "user" ? "owner" : (m.author ?? m.role)}: ${m.content}`)
          .join("\n");
        const prompt = `Agents you can delegate to:\n${team || "(none)"}\n\nConversation so far (latest last):\n${history}\n\nDecide what to do with the owner's latest message.`;

        const { provider, req } = toRequest(boss, prompt, BOSS_TIMEOUT_MS);
        // Structured output is an internal tool call, so allow a few turns.
        const res = await provider.run({ ...req, jsonSchema: DECISION_JSON_SCHEMA, maxTurns: 4 });
        if (!res.ok) throw new Error(res.error ?? "boss run failed");
        const decision = decisionSchema.parse(res.structured);

        if (decision.action === "delegate") {
          const task = decision.task;
          if (!task || task.assignee === BOSS_ID || !all.has(task.assignee)) {
            throw new Error(`unknown agent ${task?.assignee ?? "(none)"}`);
          }
          enqueue(db, {
            title: task.title,
            // The sub-agent never sees the conversation, so the reply language travels with the task.
            description: `${task.description}\n\nWrite your final report for the owner in ${task.language}.`,
            threadId,
            assigneeAgentId: task.assignee,
          });
        }
        post(threadId, decision.message);
        return decision.action;
      } catch (err) {
        post(threadId, `Sorry, I could not handle that (${(err as Error).message}).`);
        return "error";
      }
    },

    async workOnce(signal) {
      if (isPaused(db)) return false;
      const task = claim(db, { workerId: WORKER_ID, leaseMs: LEASE_MS });
      if (!task) return false;
      await runTask(task, signal);
      return true;
    },
  };

  async function runTask(task: Task, signal?: AbortSignal) {
    const report = (finalFailure: boolean, text: string) => {
      if (task.threadId && finalFailure) post(task.threadId, text);
    };
    let built: ReturnType<typeof toRequest>;
    let manifest: Manifest | undefined;
    try {
      manifest = task.assigneeAgentId ? agents().get(task.assigneeAgentId) : undefined;
      if (!manifest) throw new Error(`no agent ${task.assigneeAgentId ?? "(unassigned)"}`);
      const prompt = `# Task: ${task.title}\n\n${task.description ?? ""}`.trim();
      built = toRequest(manifest, prompt, RUN_TIMEOUT_MS);
    } catch (err) {
      // Policy or configuration problems will not fix themselves: fail without retrying.
      const msg = (err as Error).message;
      db.prepare("UPDATE tasks SET max_attempts = attempts WHERE id = ?").run(task.id);
      fail(db, task.id, WORKER_ID, msg);
      report(true, `Failed: ${task.title}\n\n${msg}`);
      return;
    }

    const run = startRun(db, {
      provider: built.provider.id,
      model: built.req.model,
      taskId: task.id,
      agentId: manifest.id,
    });
    const keepAlive = setInterval(
      () => extendLease(db, task.id, WORKER_ID, LEASE_MS),
      LEASE_MS / 3,
    );
    try {
      const res = await built.provider.run({
        ...built.req,
        ...(signal ? { signal } : {}),
        onSpawn: (pid) => setRunPid(db, run.id, pid),
      });
      finishRun(
        db,
        run.id,
        res.ok ? "succeeded" : res.stopReason === "cancelled" ? "cancelled" : "failed",
        {
          ...(res.error ? { error: res.error } : {}),
        },
      );
      if (res.ok) {
        complete(db, task.id, WORKER_ID, res.text);
        if (task.threadId) post(task.threadId, `Done: ${task.title}\n\n${res.text}`);
      } else {
        fail(db, task.id, WORKER_ID, res.error ?? res.stopReason);
        report(
          getTask(db, task.id)?.status === "failed",
          `Failed: ${task.title}\n\n${res.error ?? res.stopReason}`,
        );
      }
    } finally {
      clearInterval(keepAlive);
    }
  }
}
