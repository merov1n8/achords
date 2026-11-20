import { describe, expect, it } from "vitest";
import { openCoreDatabase } from "./db/database.ts";
import { finishRun, startRun } from "./runs.ts";
import { listUsageWindows, recordUsageWindows, spendSince } from "./usage.ts";

describe("usage meters (step 6)", () => {
  it("keeps the latest state of each subscription window per provider", () => {
    const db = openCoreDatabase(":memory:");
    recordUsageWindows(
      db,
      "cli-claude",
      [
        { kind: "five_hour", utilization: 0.1, resetsAt: 5000, status: "allowed" },
        { kind: "seven_day", utilization: 0.06, resetsAt: 9000, status: "allowed" },
      ],
      100,
    );
    recordUsageWindows(
      db,
      "cli-claude",
      [{ kind: "five_hour", utilization: 0.4, resetsAt: 5000, status: "allowed" }],
      200,
    );
    recordUsageWindows(db, "cli-claude", [], 300); // runs without window info change nothing
    expect(listUsageWindows(db)).toEqual([
      {
        provider: "cli-claude",
        kind: "five_hour",
        utilization: 0.4,
        resetsAt: 5000,
        status: "allowed",
        updatedAt: 200,
      },
      {
        provider: "cli-claude",
        kind: "seven_day",
        utilization: 0.06,
        resetsAt: 9000,
        status: "allowed",
        updatedAt: 100,
      },
    ]);
  });

  it("sums the cost of runs that ended since a point in time", () => {
    const db = openCoreDatabase(":memory:");
    const a = startRun(db, { provider: "cli-claude" }, 1);
    finishRun(db, a.id, "succeeded", { costUsd: 0.25 }, 50);
    const b = startRun(db, { provider: "cli-claude" }, 1);
    finishRun(db, b.id, "failed", { costUsd: 0.5 }, 150);
    const c = startRun(db, { provider: "local" }, 1);
    finishRun(db, c.id, "succeeded", {}, 160);
    expect(spendSince(db, 100)).toBe(0.5);
    expect(spendSince(db, 0)).toBe(0.75);
  });
});
