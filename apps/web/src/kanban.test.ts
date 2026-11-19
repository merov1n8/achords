import { describe, expect, it } from "vitest";
import { ago, groupTasks } from "./kanban.ts";
import type { Task } from "./types.ts";

const task = (id: string, status: Task["status"], updatedAt = 0): Task => ({
  id,
  title: id,
  status,
  assigneeAgentId: "web-dev",
  threadId: null,
  error: null,
  createdAt: 0,
  updatedAt,
});

describe("groupTasks", () => {
  it("maps statuses to kanban columns, newest first", () => {
    const cols = groupTasks([
      task("a", "queued", 1),
      task("b", "claimed"),
      task("c", "done", 1),
      task("d", "done", 5),
      task("e", "failed"),
      task("f", "cancelled"),
    ]);
    expect(cols.map((c) => [c.title, c.tasks.map((t) => t.id)])).toEqual([
      ["To do", ["a"]],
      ["In progress", ["b"]],
      ["Done", ["d", "c"]],
      ["Failed", ["e", "f"]],
    ]);
  });
});

describe("ago", () => {
  it("formats card age compactly", () => {
    expect(ago(0, 30_000)).toBe("just now");
    expect(ago(0, 5 * 60_000)).toBe("5m");
    expect(ago(0, 3 * 3600_000)).toBe("3h");
    expect(ago(0, 2 * 86400_000)).toBe("2d");
  });
});
