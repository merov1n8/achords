import { describe, expect, it } from "vitest";
import { openCoreDatabase } from "./db/database.ts";
import { finishRun, listActiveRuns, startRun } from "./runs.ts";

describe("runs", () => {
  it("tracks active runs until they finish", () => {
    const db = openCoreDatabase(":memory:");
    const a = startRun(db, { provider: "cli-claude", pid: 100, pgid: 100 }, 1);
    const b = startRun(db, { provider: "cli-claude", model: "x", pid: 200 }, 2);
    expect(listActiveRuns(db).map((r) => r.id)).toEqual([a.id, b.id]);
    expect(a).toMatchObject({ status: "running", pid: 100, pgid: 100, startedAt: 1 });

    expect(finishRun(db, a.id, "cancelled", { error: "emergency stop" }, 5)).toBe(true);
    expect(finishRun(db, a.id, "failed", {}, 6)).toBe(false);
    expect(listActiveRuns(db).map((r) => r.id)).toEqual([b.id]);
  });
});
