// ADR-0066 part 1: the stall watcher, with a fake clock (Date only) and a fake boss.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addSpend,
  appendMessage,
  askOwner,
  claim,
  createThread,
  enqueueChild,
  extendLease,
  getTask,
  listMessages,
  openCoreDatabase,
  STALL_MINUTES_KEY,
  setRunProgress,
  setSetting,
  startRun,
  type Task,
} from "@achords/core";
import type { ModelProvider, RunRequest, RunResult } from "@achords/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunTokens } from "../mcp/tokens.ts";
import { QUIET_HOURS_KEY } from "../monitors.ts";
import { createOrchestrator, type Orchestrator } from "./orchestrator.ts";

const T0 = new Date(2026, 10, 24, 12, 0, 0).getTime();
const MIN = 60_000;

const ok = (over: Partial<RunResult> = {}): RunResult => ({
  ok: true,
  stopReason: "completed",
  text: "done",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  windows: [],
  durationMs: 1,
  ...over,
});

describe("stall watcher (ADR-0066 part 1)", () => {
  let home: string;
  let db: ReturnType<typeof openCoreDatabase>;
  let orch: Orchestrator;
  let bossCalls: RunRequest[];
  let bossDecision: { action: string; message: string };
  let agentRun: ((req: RunRequest) => Promise<RunResult>) | undefined;

  const at = (ms: number) => vi.setSystemTime(T0 + ms);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    home = mkdtempSync(join(tmpdir(), "achords-stalls-"));
    for (const id of ["boss", "dev"]) {
      mkdirSync(join(home, "agents", id), { recursive: true });
      writeFileSync(
        join(home, "agents", id, "agent.yaml"),
        `id: ${id}\nname: ${id}\nrole: ${id}\nworkspace: shared\nmodels:\n  default: cli-claude/sonnet\ndelegation:\n  can_delegate_to: [dev]\n  accepts_from: [boss, dev]\n`,
      );
    }
    db = openCoreDatabase(join(home, "core.db"));
    bossCalls = [];
    bossDecision = { action: "ask_owner", message: "The build seems stuck. Should I stop it?" };
    agentRun = undefined;
    const p: ModelProvider = {
      id: "cli-claude",
      async run(req) {
        if (req.jsonSchema) {
          bossCalls.push(req);
          return ok({ structured: bossDecision });
        }
        return agentRun ? agentRun(req) : ok();
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
    vi.useRealTimers();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  /** A card whose task is claimed and has a run that says nothing (a hung CLI). */
  const runningCard = (title = "Build") => {
    const thread = createThread(db, {});
    const r = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: "dev", title, instructions: "go" },
      { newCard: true },
    );
    if (!r.ok) throw new Error(r.reason);
    const task = claim(db, { workerId: "gateway", leaseMs: 10 * MIN }) as Task;
    expect(task.id).toBe(r.taskId);
    const run = startRun(db, { provider: "cli-claude", taskId: task.id, agentId: "dev" });
    return { threadId: thread.id, rootId: task.id, runId: run.id };
  };
  const notices = (threadId: string) =>
    listMessages(db, threadId).filter((m) => m.author === "boss" && /stuck/.test(m.content));

  it("gives one notice after N idle minutes, and none on the next tick", async () => {
    const { threadId, rootId } = runningCard();
    at(14 * MIN);
    expect(await orch.watchStalls()).toBe(0);
    at(15 * MIN);
    expect(await orch.watchStalls()).toBe(1);
    expect(bossCalls).toHaveLength(1);
    expect(bossCalls[0]?.prompt).toContain("Stall notice");
    expect(bossCalls[0]?.prompt).toContain("Build (task #");
    expect(bossCalls[0]?.prompt).toContain("Last activity: run started");
    expect(notices(threadId)).toHaveLength(1);
    expect(db.prepare("SELECT stall_reason FROM tasks WHERE id = ?").get(rootId)).toEqual({
      stall_reason: "idle",
    });
    at(15 * MIN + 1000);
    expect(await orch.watchStalls()).toBe(0);
    expect(bossCalls).toHaveLength(1);
  });

  it("gives a new notice after new progress and a new idle period", async () => {
    const { threadId, runId } = runningCard();
    at(15 * MIN);
    expect(await orch.watchStalls()).toBe(1);
    at(20 * MIN);
    setRunProgress(db, runId, { done: 1, total: 3 });
    at(34 * MIN);
    expect(await orch.watchStalls()).toBe(0);
    at(35 * MIN);
    expect(await orch.watchStalls()).toBe(1);
    expect(notices(threadId)).toHaveLength(2);
  });

  it("counts an agent's message as progress, not the boss's own posts", async () => {
    const { threadId } = runningCard();
    at(10 * MIN);
    appendMessage(db, { threadId, role: "agent", author: "boss", channel: "system", content: "x" });
    at(15 * MIN);
    expect(await orch.watchStalls()).toBe(1);
    at(16 * MIN);
    appendMessage(db, { threadId, role: "agent", author: "dev", channel: "system", content: "y" });
    at(30 * MIN);
    expect(await orch.watchStalls()).toBe(0);
    at(31 * MIN);
    expect(await orch.watchStalls()).toBe(1);
  });

  it("does not take lease renewal alone as progress", async () => {
    const { rootId } = runningCard();
    for (const m of [4, 8, 12]) {
      at(m * MIN);
      expect(extendLease(db, rootId, "gateway", 10 * MIN)).toBe(true);
    }
    at(15 * MIN);
    expect(await orch.watchStalls()).toBe(1);
  });

  it("takes a stream event as progress, and the claim restarts the clock", async () => {
    const thread = createThread(db, {});
    const r = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: "dev", title: "Build", instructions: "go" },
    );
    if (!r.ok) throw new Error(r.reason);
    // Queued for an hour (it waits for the worker): the claim starts its clock.
    at(60 * MIN);
    let release: (r: RunResult) => void = () => {};
    let started: () => void = () => {};
    const running = new Promise<void>((s) => {
      started = s;
    });
    agentRun = (req) => {
      at(70 * MIN);
      req.onActivity?.();
      started();
      return new Promise((done) => {
        release = done;
      });
    };
    const work = orch.workOnce();
    await running;
    at(84 * MIN);
    expect(await orch.watchStalls()).toBe(0);
    at(85 * MIN);
    expect(await orch.watchStalls()).toBe(1);
    release(ok());
    await work;
  });

  it("gives no notice to a chain queued behind another chain's task", async () => {
    const a = runningCard("A");
    const thread = createThread(db, {});
    const b = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: "dev", title: "B", instructions: "go" },
    );
    if (!b.ok) throw new Error(b.reason);
    at(40 * MIN);
    // Only A, which runs and says nothing, is noticed; B waits for the single worker.
    expect(await orch.watchStalls()).toBe(1);
    expect(notices(a.threadId)).toHaveLength(1);
    expect(notices(thread.id)).toHaveLength(0);
    expect(db.prepare("SELECT stall_noticed_at FROM tasks WHERE id = ?").get(b.taskId)).toEqual({
      stall_noticed_at: null,
    });
  });

  it("gives no notice while the chain waits on the owner", async () => {
    const { rootId } = runningCard();
    askOwner(db, rootId, "Which colour?");
    db.prepare("UPDATE tasks SET status = 'queued', claimed_by = NULL WHERE id = ?").run(rootId);
    db.prepare("UPDATE runs SET status = 'succeeded', ended_at = ?").run(T0);
    at(120 * MIN);
    expect(await orch.watchStalls()).toBe(0);
    expect(bossCalls).toHaveLength(0);
  });

  it("notices a chain whose only blocker is a child's question its parent left open", async () => {
    const { threadId, rootId } = runningCard();
    const child = enqueueChild(db, getTask(db, rootId) as Task, {
      title: "Part",
      assigneeAgentId: "dev",
      caller: "dev",
    });
    // The parent waits for its child; the child asked, and the parent's run saw it and ended.
    db.prepare(
      "UPDATE tasks SET status = 'queued', claimed_by = NULL, waiting_children = 1 WHERE id = ?",
    ).run(rootId);
    db.prepare(
      "UPDATE tasks SET waiting_parent = 2, parent_question = 'Which API?' WHERE id = ?",
    ).run(child.id);
    db.prepare("UPDATE runs SET status = 'succeeded', ended_at = ?").run(T0);
    at(15 * MIN);
    expect(await orch.watchStalls()).toBe(1);
    expect(bossCalls[0]?.prompt).toContain("asked its parent, no answer yet");
    expect(notices(threadId)).toHaveLength(1);
  });

  it("gives one spend notice at 80 %, and none at 95 %", async () => {
    const { rootId, runId } = runningCard();
    db.prepare("UPDATE tasks SET budget_usd = 1 WHERE id = ?").run(rootId);
    at(1 * MIN);
    addSpend(db, rootId, 0.5);
    expect(await orch.watchStalls()).toBe(0);
    addSpend(db, rootId, 0.3);
    expect(await orch.watchStalls()).toBe(1);
    expect(bossCalls[0]?.prompt).toContain("at least 80% of its budget");
    expect(bossCalls[0]?.prompt).toContain("$0.80 of $1.00");
    at(2 * MIN);
    setRunProgress(db, runId, { done: 1, total: 2 });
    addSpend(db, rootId, 0.15);
    expect(await orch.watchStalls()).toBe(0);
    expect(bossCalls).toHaveLength(1);
  });

  it("gives no spend notice without a budget", async () => {
    const { rootId } = runningCard();
    db.prepare("UPDATE tasks SET budget_usd = NULL WHERE id = ?").run(rootId);
    addSpend(db, rootId, 50);
    at(1 * MIN);
    expect(await orch.watchStalls()).toBe(0);
  });

  it("stop_chain cancels the chain like Stop, and only that chain", async () => {
    bossDecision = { action: "stop_chain", message: "Stopped: it was stuck." };
    const { threadId, rootId } = runningCard();
    const child = enqueueChild(db, getTask(db, rootId) as Task, {
      title: "Part",
      assigneeAgentId: "dev",
      caller: "dev",
    });
    // The root delegated and waits; its child runs and says nothing.
    db.prepare("UPDATE tasks SET status = 'queued', claimed_by = NULL WHERE id = ?").run(rootId);
    db.prepare("UPDATE runs SET status = 'succeeded', ended_at = ?").run(T0);
    expect(claim(db, { workerId: "gateway", leaseMs: 10 * MIN })?.id).toBe(child.id);
    const runId = startRun(db, { provider: "cli-claude", taskId: child.id, agentId: "dev" }).id;
    // A second card in the same chat is another chain.
    const other = orch.delegate(
      { from: "boss", threadId },
      { agent: "dev", title: "Other", instructions: "go" },
      { newCard: true },
    );
    if (!other.ok) throw new Error(other.reason);
    db.prepare("UPDATE tasks SET parked = 1 WHERE id = ?").run(other.taskId);
    at(15 * MIN);
    expect(await orch.watchStalls()).toBe(1);
    expect(getTask(db, rootId)?.status).toBe("cancelled");
    expect(getTask(db, child.id)?.status).toBe("cancelled");
    expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(runId)).toEqual({
      status: "cancelled",
    });
    expect(getTask(db, other.taskId)?.status).toBe("queued");
    expect(listMessages(db, threadId).at(-1)?.content).toBe("Stopped: it was stuck.");
  });

  it("let_run posts nothing", async () => {
    bossDecision = { action: "let_run", message: "fine" };
    const { threadId, rootId } = runningCard();
    const before = listMessages(db, threadId).length;
    at(15 * MIN);
    expect(await orch.watchStalls()).toBe(1);
    expect(listMessages(db, threadId)).toHaveLength(before);
    expect(getTask(db, rootId)?.status).toBe("claimed");
  });

  it("the boss call is not watched and produces no notice of its own", async () => {
    const { threadId } = runningCard();
    at(15 * MIN);
    expect(await orch.watchStalls()).toBe(1);
    // The notice was a boss run without a task, and a boss message in the thread.
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM runs WHERE agent_id = 'boss' AND task_id IS NULL")
        .get(),
    ).toEqual({ n: 1 });
    for (const m of [31, 60, 120]) {
      at(m * MIN);
      expect(await orch.watchStalls()).toBe(0);
    }
    expect(bossCalls).toHaveLength(1);
    expect(notices(threadId)).toHaveLength(1);
  });

  it("follows the minutes setting and keeps quiet hours", async () => {
    setSetting(db, STALL_MINUTES_KEY, "30");
    runningCard();
    at(20 * MIN);
    expect(await orch.watchStalls()).toBe(0);
    setSetting(db, QUIET_HOURS_KEY, "12-13");
    at(30 * MIN);
    expect(await orch.watchStalls()).toBe(0);
    setSetting(db, QUIET_HOURS_KEY, "");
    expect(await orch.watchStalls()).toBe(1);
  });
});
