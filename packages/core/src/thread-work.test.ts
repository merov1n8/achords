import { describe, expect, it } from "vitest";
import { upsertAgent } from "./agents.ts";
import { openCoreDatabase } from "./db/database.ts";
import { askOwner, enqueueChild, enqueueRoot } from "./delegation.ts";
import { claim, enqueue, getTask } from "./queue.ts";
import { finishRun, listActiveRuns, startRun } from "./runs.ts";
import { stopThread, threadSummary } from "./thread-work.ts";
import { createThread } from "./threads.ts";

function setup() {
  const db = openCoreDatabase(":memory:");
  for (const [id, name] of [
    ["coder", "Coder"],
    ["reviewer", "Reviewer"],
    ["tester", "Tester"],
    ["writer", "Writer"],
  ] as const) {
    upsertAgent(db, { id, name, role: id, workspace: "shared" });
  }
  const thread = createThread(db, { title: "Auth" });
  return { db, thread };
}

describe("thread work", () => {
  it("sums tokens and cost of the thread's runs, delegated children included", () => {
    const { db, thread } = setup();
    const root = enqueueRoot(db, { title: "Refactor", threadId: thread.id, caller: "boss" });
    const child = enqueueChild(db, root, { title: "Review", caller: "coder" });
    const other = enqueue(db, { title: "Elsewhere" });
    const done = (
      taskId: string,
      agentId: string,
      input: number,
      output: number,
      usd: number,
      resumed = false,
    ) => {
      const run = startRun(db, { provider: "cli-claude", taskId, agentId, resumed });
      finishRun(db, run.id, "succeeded", {
        costUsd: usd,
        tokens: { input, output, cached: 5000 },
      });
    };
    done(root.id, "coder", 1000, 200, 0.25);
    done(child.id, "reviewer", 500, 100, 0.1, true);
    done(other.id, "writer", 9999, 9999, 9, true);
    expect(threadSummary(db, thread.id)).toMatchObject({
      tokensIn: 1500,
      // ADR-0066: what resumed sessions read, this chat's only.
      resumedIn: 500,
      resumedCached: 5000,
      // Most input of a CLI run is read from the prompt cache; shown apart so "in" is not tiny.
      tokensCached: 10000,
      tokensOut: 300,
      costUsd: 0.35,
    });
  });

  it("lists each agent once with what it is doing: running, waiting, queued or idle", () => {
    const { db, thread } = setup();
    const root = enqueueRoot(db, {
      title: "Refactor",
      threadId: thread.id,
      assigneeAgentId: "coder",
      caller: "boss",
    });
    claim(db, { workerId: "w", leaseMs: 60_000 });
    const review = enqueueChild(db, root, {
      title: "Review",
      caller: "coder",
      assigneeAgentId: "reviewer",
    });
    askOwner(db, review.id, "Which branch?");
    enqueueChild(db, root, { title: "Test", caller: "coder", assigneeAgentId: "tester" });
    const old = enqueue(db, { title: "Old", threadId: thread.id, assigneeAgentId: "writer" });
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(old.id);

    const s = threadSummary(db, thread.id);
    expect(s.participants).toEqual([
      { agent: "coder", name: "Coder", status: "running" },
      { agent: "reviewer", name: "Reviewer", status: "waiting" },
      { agent: "tester", name: "Tester", status: "queued" },
      { agent: "writer", name: "Writer", status: "idle" },
    ]);
    expect(s).toMatchObject({ agentsWorking: 1, agentsTotal: 4 });
    expect(threadSummary(db, createThread(db, {}).id)).toEqual({
      agentsWorking: 0,
      agentsTotal: 0,
      tasksDone: 0,
      tasksTotal: 0,
      waitingOwner: false,
      tokensCached: 0,
      tokensIn: 0,
      tokensOut: 0,
      resumedIn: 0,
      resumedCached: 0,
      costUsd: 0,
      participants: [],
    });
  });

  it("counts the chat's tasks (cards), done of all, and says when work waits for the owner", () => {
    const { db, thread } = setup();
    const t1 = enqueueRoot(db, {
      title: "Plan",
      threadId: thread.id,
      caller: "boss",
      assigneeAgentId: "coder",
    });
    const t2 = enqueueRoot(db, {
      title: "Q1",
      threadId: thread.id,
      caller: "boss",
      assigneeAgentId: "coder",
    });
    enqueueRoot(db, { title: "Q2", threadId: thread.id, caller: "boss", assigneeAgentId: "coder" });
    enqueueChild(db, t2, { title: "step", caller: "coder", assigneeAgentId: "tester" });
    db.prepare("UPDATE tasks SET status = 'done' WHERE id IN (?, ?)").run(t1.id, t2.id);
    expect(threadSummary(db, thread.id)).toMatchObject({
      tasksDone: 2,
      tasksTotal: 3,
      waitingOwner: false,
    });
    const q3 = enqueueRoot(db, {
      title: "Q3",
      threadId: thread.id,
      caller: "boss",
      assigneeAgentId: "coder",
    });
    askOwner(db, q3.id, "Which tier?");
    expect(threadSummary(db, thread.id)).toMatchObject({
      tasksDone: 2,
      tasksTotal: 4,
      waitingOwner: true,
    });
  });

  it("stop cancels the thread's open tasks and ends its running runs, nothing else", () => {
    const { db, thread } = setup();
    const root = enqueueRoot(db, { title: "Refactor", threadId: thread.id, caller: "boss" });
    claim(db, { workerId: "w", leaseMs: 60_000 });
    const child = enqueueChild(db, root, { title: "Review", caller: "coder" });
    const finished = enqueue(db, { title: "Old", threadId: thread.id });
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(finished.id);
    const other = enqueue(db, { title: "Elsewhere" });
    // No pid: the kill step only marks the run (a real one gets its process group killed).
    const run = startRun(db, { provider: "cli-claude", taskId: root.id, agentId: "coder" });
    const otherRun = startRun(db, { provider: "cli-claude", taskId: other.id });

    expect(stopThread(db, thread.id)).toEqual({ cancelled: 2, stopped: 1 });
    expect(getTask(db, root.id)?.status).toBe("cancelled");
    expect(getTask(db, child.id)?.status).toBe("cancelled");
    expect(getTask(db, finished.id)?.status).toBe("done");
    expect(getTask(db, other.id)?.status).toBe("queued");
    expect(listActiveRuns(db).map((r) => r.id)).toEqual([otherRun.id]);
    expect(db.prepare("SELECT status, error FROM runs WHERE id = ?").get(run.id)).toEqual({
      status: "cancelled",
      error: "stopped by the owner",
    });
    expect(stopThread(db, thread.id)).toEqual({ cancelled: 0, stopped: 0 });
  });
});
