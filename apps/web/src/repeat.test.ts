import { describe, expect, it } from "vitest";
// The gateway's own parser: every string the picker produces must be one it accepts.
import { parseCron } from "../../../packages/core/src/cron.ts";
import { fromCron, KINDS, type Repeat, summary, toCron, withKind } from "./repeat.ts";

const SHAPES: [Repeat, string][] = [
  [{ kind: "hourly", minute: 15 }, "15 * * * *"],
  [{ kind: "daily", hour: 7, minute: 30 }, "30 7 * * *"],
  [{ kind: "weekdays", hour: 9, minute: 0 }, "0 9 * * 1-5"],
  [{ kind: "weekly", days: [1, 3, 5], hour: 18, minute: 5 }, "5 18 * * 1,3,5"],
  [{ kind: "weekly", days: [0], hour: 10, minute: 0 }, "0 10 * * 0"],
  [{ kind: "monthly", day: 1, hour: 8, minute: 0 }, "0 8 1 * *"],
  [{ kind: "monthly", day: 31, hour: 23, minute: 59 }, "59 23 31 * *"],
];

describe("repeat picker <-> cron", () => {
  it.each(SHAPES)("%j is %s and back", (repeat, cron) => {
    expect(toCron(repeat)).toBe(cron);
    expect(fromCron(cron)).toEqual(repeat);
    expect(() => parseCron(cron)).not.toThrow();
  });

  it.each([
    "*/15 * * * *", // steps
    "0 9-17 * * *", // hour range
    "0 9 * * 1-3", // a weekday range other than Mon-Fri
    "0 9 * * 5,1", // days out of order would not come back identical
    "0 9 * * 7", // Sunday spelled 7
    "0 9 1 * 1", // both day fields
    "0 9 1 6 *", // a month
    "00 9 * * *", // leading zero
    "0 24 * * *", // out of range
    "0 9 * *", // four fields
    "garbage",
  ])("%s stays Custom, unchanged", (cron) => {
    expect(fromCron(cron)).toEqual({ kind: "custom", cron });
    expect(toCron(fromCron(cron))).toBe(cron);
  });

  it("switching the kind keeps the time and gives valid cron", () => {
    let r: Repeat = { kind: "daily", hour: 6, minute: 45 };
    for (const kind of KINDS) {
      r = withKind(r, kind);
      expect(r.kind).toBe(kind);
      expect(() => parseCron(toCron(r))).not.toThrow();
    }
    expect(withKind({ kind: "hourly", minute: 45 }, "weekly")).toEqual({
      kind: "weekly",
      days: [1],
      hour: 9,
      minute: 45,
    });
    expect(withKind({ kind: "monthly", day: 3, hour: 6, minute: 45 }, "custom")).toEqual({
      kind: "custom",
      cron: "45 6 3 * *",
    });
  });

  it("says it in plain words", () => {
    expect(summary(fromCron("0 9 * * 1-5"))).toBe("Weekdays at 09:00");
    expect(summary(fromCron("5 * * * *"))).toBe("Every hour at :05");
    expect(summary(fromCron("30 7 * * *"))).toBe("Every day at 07:30");
    expect(summary(fromCron("0 18 * * 1,3"))).toBe("Every Mon, Wed at 18:00");
    expect(summary(fromCron("0 8 1 * *"))).toBe("Monthly on day 1 at 08:00");
    expect(summary(fromCron("*/15 * * * *"))).toBe("Custom: */15 * * * *");
  });
});
