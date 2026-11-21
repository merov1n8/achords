import { describe, expect, it } from "vitest";
import { upsertAgent } from "./agents.ts";
import { openCoreDatabase } from "./db/database.ts";
import { finishRun, startRun } from "./runs.ts";
import {
  apiSpendSince,
  listUsageWindows,
  recordUsageWindows,
  spendBy,
  spendSince,
} from "./usage.ts";

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

describe("spend by provider, agent and project (Phase 4)", () => {
  it("separates API money from subscription estimates and counts unpriced runs", () => {
    const db = openCoreDatabase(":memory:");
    for (const id of ["a", "b"]) upsertAgent(db, { id, name: id, role: id, workspace: "w" });
    const finish = (
      provider: string,
      billing: "api" | "subscription",
      cost: number | undefined,
      agentId = "a",
    ) => {
      const r = startRun(db, { provider, agentId, billing }, 10);
      finishRun(
        db,
        r.id,
        "succeeded",
        {
          ...(cost !== undefined ? { costUsd: cost } : {}),
          tokens: { input: 100, output: 10, cached: 0 },
        },
        20,
      );
    };
    finish("cli-claude", "api", 0.5);
    finish("cli-claude", "api", 0.25, "b");
    finish("cli-claude", "subscription", 2);
    finish("cli-codex", "api", undefined);
    expect(apiSpendSince(db, "cli-claude", 0)).toBe(0.75);
    expect(apiSpendSince(db, "cli-claude", 21)).toBe(0);
    const byProvider = spendBy(db, 0, "provider");
    expect(byProvider).toContainEqual({
      key: "cli-codex",
      billing: "api",
      usd: 0,
      unpriced: 1,
      inputTokens: 100,
      outputTokens: 10,
    });
    expect(
      byProvider.find((r) => r.key === "cli-claude" && r.billing === "subscription")?.usd,
    ).toBe(2);
    expect(spendBy(db, 0, "agent").find((r) => r.key === "b")?.usd).toBe(0.25);
  });
});
