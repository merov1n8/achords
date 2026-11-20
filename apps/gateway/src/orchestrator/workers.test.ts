import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThread, getTask, listMessages, openCoreDatabase, type Task } from "@achords/core";
import type { ModelProvider, RunRequest, RunResult } from "@achords/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunTokens } from "../mcp/tokens.ts";
import { createOrchestrator, type Orchestrator } from "./orchestrator.ts";

const result = (over: Partial<RunResult> = {}): RunResult => ({
  ok: true,
  stopReason: "completed",
  text: "",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  windows: [],
  durationMs: 1,
  ...over,
});

describe("ephemeral workers and agent proposals (ADR-0029)", () => {
  let home: string;
  let ws: string;
  let db: ReturnType<typeof openCoreDatabase>;
  let orch: Orchestrator;
  let calls: { task: Task; req: RunRequest }[];
  let behave: (req: RunRequest, task: Task) => RunResult;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-workers-"));
    ws = join(home, "ws");
    mkdirSync(join(ws, "site"), { recursive: true });
    const agents = [
      ["boss", "models:\n  default: cli-claude/sonnet"],
      [
        "dev",
        `models:\n  default: cli-claude/sonnet\ntools: [Read, Edit, Bash]\nfs:\n  write: ["${ws}"]\nshell:\n  allow: ["npm test"]`,
      ],
    ] as [string, string][];
    for (const [id, yaml] of agents) {
      mkdirSync(join(home, "agents", id), { recursive: true });
      writeFileSync(
        join(home, "agents", id, "agent.yaml"),
        `id: ${id}\nname: ${id}\nrole: ${id}\nworkspace: shared\n${yaml}\n`,
      );
    }
    db = openCoreDatabase(join(home, "core.db"));
    calls = [];
    behave = () => result();
    const p: ModelProvider = {
      id: "cli-claude",
      async run(req) {
        const row = db.prepare("SELECT id FROM tasks WHERE status = 'claimed'").get();
        const task = getTask(db, String(row?.id)) as Task;
        calls.push({ task, req });
        return behave(req, task);
      },
    };
    orch = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": p },
      hub: { url: "http://127.0.0.1:1", tokens: createRunTokens(), serverEntry: "/x.ts" },
    });
    orch.syncAgents();
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const rootTask = () => {
    const thread = createThread(db, {});
    const r = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: "dev", title: "Build", instructions: "go" },
      { budgetUsd: 5 },
    );
    if (!r.ok) throw new Error(r.reason);
    return { thread, id: r.taskId };
  };
  const drain = async () => {
    for (let i = 0; i < 20 && (await orch.workOnce()); i++);
  };

  it("a worker gets a subset of the caller's permissions and nothing else", async () => {
    let spawned: unknown;
    behave = (req, task) => {
      if (!task.parentId && !req.prompt.includes("Results from delegated tasks")) {
        spawned = orch.spawnWorker(
          { from: "task", taskId: task.id },
          {
            instructions: "run the tests in site",
            tools: ["Read", "Bash"],
            paths: [join(ws, "site")],
          },
        );
      }
      return result({ text: task.parentId ? "tests pass" : "all good" });
    };
    const { id } = rootTask();
    await drain();
    expect(spawned).toMatchObject({ ok: true });
    const worker = calls.find((c) => c.task.parentId)?.req;
    expect(worker?.tools).toEqual(["Read", "Bash", "TodoWrite"]);
    // Reads only inside the granted path; no write tool, no write rule.
    const site = realpathSync(join(ws, "site"));
    expect(worker?.allowedTools).toEqual([`Read(/${site}/**)`, "Bash(npm test:*)", "TodoWrite"]);
    expect(worker?.cwd).toBe(join(ws, "site"));
    // Depth 1: no hub at all (cannot delegate, spawn, propose or ask).
    expect(worker?.mcpConfigPath).toBeUndefined();
    expect(calls.at(-1)?.req.prompt).toMatch(/Results from delegated tasks[\s\S]*tests pass/);
    expect(getTask(db, id)).toMatchObject({ status: "done" });
  });

  it("rejects (does not trim) requests beyond the caller's permissions", async () => {
    const outcomes: unknown[] = [];
    behave = (_req, task) => {
      if (!task.parentId) {
        outcomes.push(
          orch.spawnWorker(
            { from: "task", taskId: task.id },
            { instructions: "x", tools: ["Read", "Write"], paths: [] },
          ),
        );
        outcomes.push(
          orch.spawnWorker(
            { from: "task", taskId: task.id },
            { instructions: "x", tools: ["Read"], paths: [home] },
          ),
        );
        outcomes.push(
          orch.spawnWorker(
            { from: "task", taskId: task.id },
            { instructions: "x", tools: ["mcp__achords__delegate"], paths: [] },
          ),
        );
      }
      return result();
    };
    rootTask();
    await drain();
    expect(outcomes).toEqual([
      { ok: false, reason: expect.stringMatching(/Write/) },
      { ok: false, reason: expect.stringMatching(/outside/) },
      { ok: false, reason: expect.stringMatching(/mcp__achords__delegate/) },
    ]);
  });

  it("limits workers to 3 per task, and workers cannot spawn or delegate", async () => {
    const outcomes: boolean[] = [];
    const fromWorker: unknown[] = [];
    behave = (req, task) => {
      if (!task.parentId && !req.prompt.includes("Results from delegated tasks")) {
        for (let i = 0; i < 4; i++) {
          outcomes.push(
            orch.spawnWorker(
              { from: "task", taskId: task.id },
              { instructions: `w${i}`, tools: ["Read"], paths: [] },
            ).ok,
          );
        }
      }
      if (task.parentId && fromWorker.length === 0) {
        fromWorker.push(
          orch.spawnWorker(
            { from: "task", taskId: task.id },
            { instructions: "nested", tools: [], paths: [] },
          ),
        );
        fromWorker.push(
          orch.delegate(
            { from: "task", taskId: task.id },
            { agent: "dev", title: "x", instructions: "y" },
          ),
        );
      }
      return result();
    };
    rootTask();
    await drain();
    expect(outcomes).toEqual([true, true, true, false]);
    expect(fromWorker).toEqual([
      { ok: false, reason: expect.stringMatching(/workers cannot/) },
      { ok: false, reason: expect.stringMatching(/workers cannot/) },
    ]);
  });

  it("a proposed agent exists only after the owner approves it", async () => {
    let proposal: { ok: boolean; proposalId?: string; reason?: string } = { ok: false };
    behave = (_req, task) => {
      if (!task.parentId) {
        expect(
          orch.proposeAgent({ from: "task", taskId: task.id }, { yaml: "id: [broken", reason: "x" })
            .ok,
        ).toBe(false);
        expect(
          orch.proposeAgent(
            { from: "task", taskId: task.id },
            {
              yaml: "id: dev\nname: d\nrole: r\nworkspace: w\nmodels: {default: local/x}\n",
              reason: "dup",
            },
          ),
        ).toMatchObject({ ok: false, reason: expect.stringMatching(/already exists/) });
        proposal = orch.proposeAgent(
          { from: "task", taskId: task.id },
          {
            yaml: "id: tester\nname: Tester\nrole: qa\nworkspace: shared\nmodels:\n  default: cli-claude/haiku\ntools: [Read]\n",
            reason: "We need a QA agent for regression runs",
          },
        );
      }
      return result();
    };
    const { thread } = rootTask();
    await drain();
    expect(proposal).toMatchObject({ ok: true });
    expect(existsSync(join(home, "agents", "tester"))).toBe(false);
    const msg = listMessages(db, thread.id).find((m) => m.content.includes("proposes a new agent"));
    expect(msg?.content).toMatch(/tester[\s\S]*tools: Read[\s\S]*\/approve/);

    expect(orch.decideProposal(proposal.proposalId as string, true)).toMatchObject({ ok: true });
    // The buttons disappear everywhere (web and Telegram read the same message).
    expect(
      listMessages(db, thread.id).find((m) => m.content.includes("proposes"))?.actions,
    ).toBeNull();
    expect(existsSync(join(home, "agents", "tester", "agent.yaml"))).toBe(true);
    expect(orch.syncAgents()).toContain("tester");
    // Decided once only.
    expect(orch.decideProposal(proposal.proposalId as string, true)).toMatchObject({ ok: false });
  });

  it("a rejected proposal creates nothing", async () => {
    let id = "";
    behave = (_req, task) => {
      if (!task.parentId) {
        const r = orch.proposeAgent(
          { from: "task", taskId: task.id },
          {
            yaml: "id: spammer\nname: S\nrole: s\nworkspace: shared\nmodels:\n  default: cli-claude/haiku\n",
            reason: "trust me",
          },
        );
        if (r.ok) id = r.proposalId;
      }
      return result();
    };
    rootTask();
    await drain();
    expect(orch.decideProposal(id, false)).toMatchObject({ ok: true });
    expect(existsSync(join(home, "agents", "spammer"))).toBe(false);
  });
});
