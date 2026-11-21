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
    const done = (taskId: string, agentId: string, input: number, output: number, usd: number) => {
      const run = startRun(db, { provider: "cli-claude", taskId, agentId });
      finishRun(db, run.id, "succeeded", {
        costUsd: usd,
        tokens: { input, output, cached: 0 },
      });
    };
    done(root.id, "coder", 1000, 200, 0.25);
    done(child.id, "reviewer", 500, 100, 0.1);
    done(other.id, "writer", 9999, 9999, 9);
    expect(threadSummary(db, thread.id)).toMatchObject({
      tokensIn: 1500,
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
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      participants: [],
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
