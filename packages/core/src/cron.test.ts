import { describe, expect, it } from "vitest";
import { nextRun, occurrences, parseCron } from "./cron.ts";

// Local time, like the schedules themselves.
const at = (s: string) => new Date(s).getTime();

describe("cron (5 fields, local time)", () => {
  it("finds the next run after a moment", () => {
    expect(nextRun("0 9 * * *", at("2026-11-20T08:30:00"))).toBe(at("2026-11-20T09:00:00"));
    expect(nextRun("0 9 * * *", at("2026-11-20T09:00:00"))).toBe(at("2026-11-21T09:00:00"));
    expect(nextRun("*/15 * * * *", at("2026-11-20T10:07:30"))).toBe(at("2026-11-20T10:15:00"));
    expect(nextRun("30 7 * * 1-5", at("2026-11-21T08:00:00"))).toBe(at("2026-11-23T07:30:00")); // Sat → Mon
    expect(nextRun("0 0 1 * *", at("2026-11-20T00:00:00"))).toBe(at("2026-12-01T00:00:00"));
    expect(nextRun("0 12 * * 0", at("2026-11-20T00:00:00"))).toBe(at("2026-11-22T12:00:00")); // Sunday = 0
    expect(nextRun("0 12 * * 7", at("2026-11-20T00:00:00"))).toBe(at("2026-11-22T12:00:00")); // and 7
  });

  it("day of month OR day of week when both are restricted (classic cron)", () => {
    // The 1st of the month or any Monday.
    expect(nextRun("0 8 1 * 1", at("2026-11-24T09:00:00"))).toBe(at("2026-11-30T08:00:00"));
  });

  it("lists, ranges and steps", () => {
    expect(
      occurrences("0 8,12-13 * * *", at("2026-11-20T00:00:00"), at("2026-11-21T00:00:00")),
    ).toEqual([at("2026-11-20T08:00:00"), at("2026-11-20T12:00:00"), at("2026-11-20T13:00:00")]);
  });

  it("rejects malformed expressions with a reason", () => {
    expect(() => parseCron("0 9 * *")).toThrow(/5 fields/);
    expect(() => parseCron("61 * * * *")).toThrow(/minute/);
    expect(() => parseCron("* 24 * * *")).toThrow(/hour/);
    expect(() => parseCron("* * * * mon")).toThrow(/day of week/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/step/);
  });
});
