import { describe, expect, it } from "vitest";
import { describeProgress } from "./progress.ts";

const base = { startedAt: 0, done: null, total: null };

describe("describeProgress", () => {
  it("without a checklist shows only the elapsed time", () => {
    expect(describeProgress(base, 90_000)).toEqual({ percent: null, elapsed: "1m", left: null });
  });

  it("estimates the time left only after the first step is done", () => {
    expect(describeProgress({ ...base, done: 0, total: 4 }, 60_000)).toEqual({
      percent: 0,
      elapsed: "1m",
      left: null,
    });
    // 1 of 4 steps in 3 minutes → about 9 minutes left.
    expect(describeProgress({ ...base, done: 1, total: 4 }, 180_000)).toEqual({
      percent: 25,
      elapsed: "3m",
      left: "~9 min",
    });
    expect(describeProgress({ ...base, done: 3, total: 4 }, 30_000)?.left).toBe("<1 min");
    expect(describeProgress({ ...base, done: 4, total: 4 }, 30_000)).toMatchObject({
      percent: 100,
      left: null,
    });
  });
});
