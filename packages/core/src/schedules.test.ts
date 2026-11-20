import { describe, expect, it } from "vitest";
import { openCoreDatabase } from "./db/database.ts";
import { enqueue } from "./queue.ts";
import {
  createSchedule,
  deleteSchedule,
  dueSchedules,
  listSchedules,
  markScheduleRun,
  updateSchedule,
} from "./schedules.ts";

const at = (s: string) => new Date(s).getTime();

describe("schedules (step 7)", () => {
  const input = {
    name: "Weekly report",
    cron: "0 9 * * 1",
    agentId: "web-dev",
    title: "Weekly report",
    instructions: "Summarise last week.",
  };

  it("computes the next run on create and after each run; disabled ones are never due", () => {
    const db = openCoreDatabase(":memory:");
    const s = createSchedule(db, input, at("2026-11-20T10:00:00")); // Friday
    expect(s.nextRunAt).toBe(at("2026-11-23T09:00:00"));
    expect(dueSchedules(db, at("2026-11-23T08:59:00"))).toEqual([]);
    expect(dueSchedules(db, at("2026-11-23T09:00:30")).map((x) => x.id)).toEqual([s.id]);

    const task = enqueue(db, { title: "Weekly report" });
    markScheduleRun(db, s.id, { taskId: task.id, threadId: null }, at("2026-11-23T09:00:30"));
    expect(listSchedules(db)[0]).toMatchObject({
      lastTaskId: task.id,
      lastStatus: "queued",
      nextRunAt: at("2026-11-30T09:00:00"),
    });

    updateSchedule(db, s.id, { enabled: false }, at("2026-11-24T00:00:00"));
    expect(dueSchedules(db, at("2026-12-31T00:00:00"))).toEqual([]);
    updateSchedule(db, s.id, { enabled: true, cron: "30 7 * * *" }, at("2026-11-24T00:00:00"));
    expect(listSchedules(db)[0]?.nextRunAt).toBe(at("2026-11-24T07:30:00"));
  });

  it("validates the cron expression and can be deleted", () => {
    const db = openCoreDatabase(":memory:");
    expect(() => createSchedule(db, { ...input, cron: "every monday" })).toThrow(/5 fields/);
    const s = createSchedule(db, input);
    expect(() => updateSchedule(db, s.id, { cron: "99 * * * *" })).toThrow(/minute/);
    deleteSchedule(db, s.id);
    expect(listSchedules(db)).toEqual([]);
  });
});
