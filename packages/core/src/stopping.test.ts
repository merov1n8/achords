import { describe, expect, it } from "vitest";
import { openCoreDatabase } from "./db/database.ts";
import { claim, enqueue, getTask, isDraining, requeueInterrupted, setDraining } from "./queue.ts";
import { runProgressItems, setRunProgress, startRun } from "./runs.ts";

describe("planned stop", () => {
  it("an interrupted task goes back to the queue with a note, without using up an attempt", () => {
    const db = openCoreDatabase(":memory:");
    const t = enqueue(db, { title: "Landing page" });
    const c = claim(db, { workerId: "w", leaseMs: 60_000 });
    expect(c?.attempts).toBe(1);
    expect(requeueInterrupted(db, t.id, "w", "Steps done: 2/5")).toBe(true);
    expect(getTask(db, t.id)).toMatchObject({
      status: "queued",
      attempts: 0,
      resumeNote: "Steps done: 2/5",
    });
    expect(requeueInterrupted(db, t.id, "w", "again")).toBe(false); // only a claimed task
  });

  it("draining is a flag the gateway reads; the run keeps its checklist items", () => {
    const db = openCoreDatabase(":memory:");
    expect(isDraining(db)).toBe(false);
    setDraining(db, true);
    expect(isDraining(db)).toBe(true);
    const run = startRun(db, { provider: "cli-claude" });
    setRunProgress(db, run.id, {
      done: 1,
      total: 2,
      current: "Write tests",
      items: [
        { content: "Build", status: "completed" },
        { content: "Write tests", status: "in_progress" },
      ],
    });
    expect(runProgressItems(db, run.id)).toEqual([
      { content: "Build", status: "completed" },
      { content: "Write tests", status: "in_progress" },
    ]);
  });
});
