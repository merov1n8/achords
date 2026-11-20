import { describe, expect, it } from "vitest";
import { openCoreDatabase } from "./db/database.ts";
import { enqueue } from "./queue.ts";
import {
  finishRun,
  listActiveRuns,
  liveProgress,
  setRunPid,
  setRunProgress,
  startRun,
} from "./runs.ts";

describe("runs", () => {
  it("tracks active runs until they finish", () => {
    const db = openCoreDatabase(":memory:");
    const a = startRun(db, { provider: "cli-claude", pid: 100, pgid: 100 }, 1);
    const b = startRun(db, { provider: "cli-claude", model: "x", pid: 200 }, 2);
    expect(listActiveRuns(db).map((r) => r.id)).toEqual([a.id, b.id]);
    expect(a).toMatchObject({ status: "running", pid: 100, pgid: 100, startedAt: 1 });

    const c = startRun(db, { provider: "cli-claude" }, 3);
    setRunPid(db, c.id, 300);
    expect(listActiveRuns(db).find((r) => r.id === c.id)).toMatchObject({ pid: 300, pgid: 300 });
    finishRun(db, c.id, "succeeded", {}, 4);

    expect(finishRun(db, a.id, "cancelled", { error: "emergency stop" }, 5)).toBe(true);
    expect(finishRun(db, a.id, "failed", {}, 6)).toBe(false);
    expect(listActiveRuns(db).map((r) => r.id)).toEqual([b.id]);
  });

  it("keeps the latest progress of each running run for the live view", () => {
    const db = openCoreDatabase(":memory:");
    const task = enqueue(db, { title: "Landing page" });
    const run = startRun(db, { provider: "cli-claude", taskId: task.id }, 1000);
    expect(liveProgress(db)).toEqual([
      expect.objectContaining({
        runId: run.id,
        title: "Landing page",
        startedAt: 1000,
        done: null,
        total: null,
      }),
    ]);
    setRunProgress(db, run.id, { done: 2, total: 5, current: "Writing tests" }, 4000);
    expect(liveProgress(db)[0]).toMatchObject({
      done: 2,
      total: 5,
      current: "Writing tests",
      progressAt: 4000,
    });
    finishRun(db, run.id, "succeeded", {}, 5000);
    expect(liveProgress(db)).toEqual([]);
  });
});
