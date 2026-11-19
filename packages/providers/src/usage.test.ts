import { describe, expect, it } from "vitest";
import { stubApiMeter, subscriptionMeter } from "./usage.ts";

describe("usage meters", () => {
  it("subscription meter keeps the latest window per kind", () => {
    const m = subscriptionMeter("cli-claude");
    expect(m.snapshot()).toEqual({
      provider: "cli-claude",
      mode: "subscription",
      windows: [],
      updatedAt: null,
    });
    m.record([{ kind: "five_hour", utilization: 0.1, resetsAt: 1, status: "allowed" }], 10);
    m.record(
      [
        { kind: "five_hour", utilization: 0.3, resetsAt: 1, status: "allowed" },
        { kind: "seven_day", utilization: 0.06, resetsAt: 2, status: "allowed" },
      ],
      20,
    );
    expect(m.snapshot()).toEqual({
      provider: "cli-claude",
      mode: "subscription",
      windows: [
        { kind: "five_hour", utilization: 0.3, resetsAt: 1, status: "allowed" },
        { kind: "seven_day", utilization: 0.06, resetsAt: 2, status: "allowed" },
      ],
      updatedAt: 20,
    });
    m.record([], 30);
    expect(m.snapshot().updatedAt).toBe(20);
  });

  it("API meter stub reports spend and balance", () => {
    expect(stubApiMeter("api-anthropic", { spentUsd: 1.5, balanceUsd: 20 }).snapshot()).toEqual({
      provider: "api-anthropic",
      mode: "api",
      spentUsd: 1.5,
      balanceUsd: 20,
      updatedAt: null,
    });
  });
});
