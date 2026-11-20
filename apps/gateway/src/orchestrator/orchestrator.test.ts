import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createThread,
  enqueue,
  getTask,
  listActiveRuns,
  listMessages,
  openCoreDatabase,
  setPaused,
} from "@achords/core";
import { openMemory } from "@achords/memory";
import type { ModelProvider, RunRequest, RunResult } from "@achords/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOrchestrator, type Orchestrator } from "./orchestrator.ts";
import { seedAgents } from "./seed.ts";

const SEED_DIR = new URL("../../../../seed/agents/", import.meta.url).pathname;

function result(over: Partial<RunResult> = {}): RunResult {
  return {
    ok: true,
    stopReason: "completed",
    text: "",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    windows: [],
    durationMs: 1,
    ...over,
  };
}

function fakeProvider(reply: (req: RunRequest) => RunResult) {
  const calls: RunRequest[] = [];
  const provider: ModelProvider = {
    id: "cli-claude",
    async run(req) {
      calls.push(req);
      req.onSpawn?.(4242);
      return reply(req);
    },
  };
  return { provider, calls };
}

describe("seedAgents", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-seed-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("copies seed agents once, fills in ACHORDS_HOME, never overwrites local edits", () => {
    const agents = join(home, "agents");
    expect(seedAgents(SEED_DIR, agents, home).sort()).toEqual(["boss", "web-dev"]);
    const yaml = readFileSync(join(agents, "web-dev", "agent.yaml"), "utf8");
    expect(yaml).toContain(`${home}/workspaces/web-clients`);
    expect(yaml).not.toContain("{{ACHORDS_HOME}}");

    writeFileSync(join(agents, "web-dev", "AGENT.md"), "local edit");
    expect(seedAgents(SEED_DIR, agents, home)).toEqual([]);
    expect(readFileSync(join(agents, "web-dev", "AGENT.md"), "utf8")).toBe("local edit");
  });
});

describe("orchestrator", () => {
  let home: string;
  let db: ReturnType<typeof openCoreDatabase>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-orch-"));
    seedAgents(SEED_DIR, join(home, "agents"), home);
    db = openCoreDatabase(join(home, "core.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const make = (reply: (req: RunRequest) => RunResult, redact?: (s: string) => string) => {
    const fake = fakeProvider(reply);
    const orch: Orchestrator = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": fake.provider },
      ...(redact ? { redact } : {}),
    });
    expect(orch.syncAgents().sort()).toEqual(["boss", "web-dev"]);
    return { orch, calls: fake.calls };
  };

  const boss = (structured: unknown) => () => result({ structured });

  it("boss answers directly: reply in the thread, no task", async () => {
    const { orch, calls } = make(boss({ action: "answer", message: "Szia!" }));
    const t = createThread(db, {});
    expect(await orch.handleMessage(t.id, "hello", "telegram")).toBe("answer");
    expect(listMessages(db, t.id).map((m) => [m.role, m.author, m.content])).toEqual([
      ["user", null, "hello"],
      ["agent", "boss", "Szia!"],
    ]);
    // Boss runs locked down: no tools, structured output, its own manifest's model and budget.
    expect(calls[0]).toMatchObject({
      model: "sonnet",
      tools: [],
      allowedTools: [],
      maxBudgetUsd: 0.5,
    });
    // The claude CLI rejects a draft 2020-12 $schema reference (found with the real CLI).
    expect(calls[0]?.jsonSchema).toMatchObject({ type: "object", required: ["action", "message"] });
    expect(calls[0]?.jsonSchema).not.toHaveProperty("$schema");
    expect(calls[0]?.prompt).toContain("web-dev");
    expect(calls[0]?.prompt).toContain("hello");
    expect(calls[0]?.appendSystemPrompt).toContain("ask");
  });

  it("AGENT.md: the agent's own runs get it, the boss sees each agent's summary", async () => {
    const { orch, calls } = make(boss({ action: "answer", message: "ok" }));
    await orch.handleMessage(createThread(db, {}).id, "hello", "web");
    // Boss: its own AGENT.md as system prompt, the team with one-line scopes.
    expect(calls[0]?.appendSystemPrompt).toMatch(/# Boss/);
    expect(calls[0]?.prompt).toMatch(
      /- web-dev: Web developer \(web-dev, workspace web-clients\): Builds and maintains client websites/,
    );
  });

  it("an older install's prompt.md still works when there is no AGENT.md", async () => {
    rmSync(join(home, "agents", "boss", "AGENT.md"));
    writeFileSync(join(home, "agents", "boss", "prompt.md"), "legacy boss prompt");
    const { orch, calls } = make(boss({ action: "answer", message: "ok" }));
    await orch.handleMessage(createThread(db, {}).id, "hello", "web");
    expect(calls[0]?.appendSystemPrompt).toBe("legacy boss prompt");
  });

  it("boss asks a clarifying question: no task yet", async () => {
    const { orch } = make(boss({ action: "ask", message: "Melyik ügyfélnek?" }));
    const t = createThread(db, {});
    expect(await orch.handleMessage(t.id, "csinálj egy TODO appot", "telegram")).toBe("ask");
    expect(listMessages(db, t.id).at(-1)?.content).toBe("Melyik ügyfélnek?");
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()?.n).toBe(0);
  });

  it("boss delegates: a kanban task for the sub-agent, a one-line ack in the thread", async () => {
    const { orch } = make(
      boss({
        action: "delegate",
        message: "Rendben, a web-dev megcsinálja.",
        task: {
          title: "TODO app for Acme",
          description: "Build ...",
          assignee: "web-dev",
          language: "Hungarian",
        },
      }),
    );
    const t = createThread(db, {});
    await orch.handleMessage(t.id, "TODO app az Acme-nek, sima HTML", "web");
    const task = db.prepare("SELECT * FROM tasks").get();
    expect(task).toMatchObject({
      title: "TODO app for Acme",
      description: "Build ...\n\nWrite your final report for the owner in Hungarian.",
      assignee_agent_id: "web-dev",
      thread_id: t.id,
      status: "queued",
    });
    expect(listMessages(db, t.id).at(-1)?.content).toBe("Rendben, a web-dev megcsinálja.");
  });

  it("passes the owner's language to the sub-agent, which reports in it", async () => {
    const { orch, calls } = make((req) =>
      req.jsonSchema
        ? result({
            structured: {
              action: "delegate",
              message: "Rendben.",
              task: {
                title: "X",
                description: "Build X",
                assignee: "web-dev",
                language: "Hungarian",
              },
            },
          })
        : result({ text: "Kész." }),
    );
    const t = createThread(db, {});
    await orch.handleMessage(t.id, "csináld meg az X-et", "telegram");
    expect(db.prepare("SELECT description FROM tasks").get()?.description).toContain("Hungarian");
    await orch.workOnce();
    expect(calls.at(-1)?.prompt).toMatch(/final report.*Hungarian/s);
    // The schema asks the boss for the language explicitly.
    expect(JSON.stringify(calls[0]?.jsonSchema)).toContain("language");
  });

  it("refuses to delegate to an agent that does not exist", async () => {
    const { orch } = make(
      boss({
        action: "delegate",
        message: "ok",
        task: { title: "x", description: "y", assignee: "hacker" },
      }),
    );
    const t = createThread(db, {});
    expect(await orch.handleMessage(t.id, "do it", "web")).toBe("error");
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()?.n).toBe(0);
    expect(listMessages(db, t.id).at(-1)?.content).toMatch(/could not/i);
  });

  it("reports a failed boss run briefly instead of going silent", async () => {
    const { orch } = make(() => result({ ok: false, stopReason: "error", error: "boom" }));
    const t = createThread(db, {});
    expect(await orch.handleMessage(t.id, "hi", "web")).toBe("error");
    expect(listMessages(db, t.id).at(-1)).toMatchObject({ author: "boss", role: "agent" });
  });

  it("worker runs the sub-agent from its manifest and reports done in the thread", async () => {
    const { orch, calls } = make(() => result({ text: "Kész: index.html a workspace-ben." }));
    const t = createThread(db, {});
    const task = enqueue(db, {
      title: "TODO app",
      description: "Build it",
      threadId: t.id,
      assigneeAgentId: "web-dev",
    });

    expect(await orch.workOnce()).toBe(true);
    const req = calls[0] as RunRequest;
    const ws = join(home, "workspaces", "web-clients");
    expect(req).toMatchObject({
      model: "sonnet",
      cwd: ws,
      // TodoWrite only keeps the run's own checklist (live progress), no file/shell/network access.
      tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "TodoWrite"],
      maxBudgetUsd: 2,
    });
    expect(existsSync(ws)).toBe(true);
    // Bash is available, but only allow-listed commands run without approval.
    expect(req.allowedTools).toContain("Bash(git status:*)");
    expect(req.allowedTools).not.toContain("Bash");
    expect(req.prompt).toContain("Build it");
    expect(req.appendSystemPrompt).toContain("# Web developer");

    expect(getTask(db, task.id)).toMatchObject({ status: "done" });
    expect(listMessages(db, t.id).at(-1)?.content).toBe(
      "Done: TODO app\n\nKész: index.html a workspace-ben.",
    );
    expect(listActiveRuns(db)).toEqual([]);
    const run = db.prepare("SELECT * FROM runs").get();
    expect(run).toMatchObject({
      status: "succeeded",
      pid: 4242,
      agent_id: "web-dev",
      task_id: task.id,
    });
    expect(await orch.workOnce()).toBe(false);
  });

  it("retries quietly and only reports the final failure", async () => {
    const { orch } = make(() => result({ ok: false, stopReason: "error", error: "tests failed" }));
    const t = createThread(db, {});
    const task = enqueue(db, {
      title: "X",
      threadId: t.id,
      assigneeAgentId: "web-dev",
      maxAttempts: 2,
    });
    await orch.workOnce();
    expect(getTask(db, task.id)?.status).toBe("queued");
    expect(listMessages(db, t.id)).toEqual([]);
    await orch.workOnce();
    expect(getTask(db, task.id)?.status).toBe("failed");
    expect(listMessages(db, t.id).at(-1)?.content).toBe("Failed: X\n\ntests failed");
  });

  it("enforces the manifest's model policy before running (local-only fails closed)", async () => {
    const yamlPath = join(home, "agents", "web-dev", "agent.yaml");
    writeFileSync(yamlPath, `${readFileSync(yamlPath, "utf8")}sensitivity: local-only\n`);
    const { orch, calls } = make(() => result({ text: "should not run" }));
    const task = enqueue(db, { title: "X", assigneeAgentId: "web-dev", maxAttempts: 1 });
    await orch.workOnce();
    expect(calls).toEqual([]);
    expect(getTask(db, task.id)).toMatchObject({ status: "failed" });
    expect(getTask(db, task.id)?.error).toMatch(/local-only/);
  });

  it("does nothing while the queue is paused", async () => {
    const { orch, calls } = make(() => result());
    enqueue(db, { title: "X", assigneeAgentId: "web-dev" });
    setPaused(db, true);
    expect(await orch.workOnce()).toBe(false);
    expect(calls).toEqual([]);
  });

  it("gives the boss and sub-agents relevant memories and remembers finished tasks (redacted)", async () => {
    const memory = openMemory(":memory:", { dims: 16 });
    await memory.add({
      workspace: "web-clients",
      kind: "decision",
      content: "Acme wants plain HTML, no frameworks",
    });
    await memory.add({
      workspace: "studio",
      kind: "fact",
      content: "Acme is also a Unity asset name",
    });
    const fake = fakeProvider((req) =>
      req.jsonSchema
        ? result({
            structured: {
              action: "delegate",
              message: "ok",
              task: {
                title: "Acme TODO",
                description: "Build the Acme TODO",
                assignee: "web-dev",
                language: "English",
              },
            },
          })
        : result({ text: "Built it. token=supersecretvalue123" }),
    );
    const orch = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": fake.provider },
      memory,
      redact: (s) => s.replaceAll("supersecretvalue123", "[REDACTED]"),
    });
    orch.syncAgents();
    const t = createThread(db, {});
    await orch.handleMessage(t.id, "Acme TODO please", "web");
    // The boss sees memories from every workspace.
    expect(fake.calls[0]?.prompt).toContain("Acme wants plain HTML");
    await orch.workOnce();
    // The sub-agent only sees its own workspace (+ shared).
    expect(fake.calls[1]?.prompt).toContain("Acme wants plain HTML");
    expect(fake.calls[1]?.prompt).not.toContain("Unity asset");

    const saved = await memory.search("Acme TODO built", { workspaces: ["web-clients"] });
    const summary = saved.find((h) => h.kind === "summary");
    expect(summary?.content).toContain("Built it");
    expect(summary?.content).not.toContain("supersecretvalue123");
    memory.close();
  });

  it("redacts secrets from everything posted to the thread", async () => {
    const { orch } = make(
      () => result({ text: "token=supersecretvalue123" }),
      (s) => s.replaceAll("supersecretvalue123", "[REDACTED]"),
    );
    const t = createThread(db, {});
    enqueue(db, { title: "X", threadId: t.id, assigneeAgentId: "web-dev" });
    await orch.workOnce();
    expect(listMessages(db, t.id).at(-1)?.content).toBe("Done: X\n\ntoken=[REDACTED]");
  });
});
