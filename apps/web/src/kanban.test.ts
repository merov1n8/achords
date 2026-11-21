import { describe, expect, it } from "vitest";
import { ago, boardColumns, columnLabel, dropKind, type Rule, unionColumns } from "./kanban.ts";
import type { Task } from "./types.ts";

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: id,
  status: "done",
  assigneeAgentId: "dev",
  threadId: null,
  parentId: null,
  column: "in_progress",
  error: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const matrix: { to: string; rules: Rule[] }[] = [
  { to: "review", rules: [{ from: "in_progress", by: "assignee" }] },
  { to: "done", rules: [{ from: "review", by: "role:qa", not: "assignee" }] },
  { to: "deployed", rules: [{ from: "done", by: "owner" }] },
];

describe("boardColumns", () => {
  it("puts cards of the workspace into workflow columns, newest first, with child counts", () => {
    const tasks = [
      task("a", { updatedAt: 1 }),
      task("b", { updatedAt: 5 }),
      task("c", { column: "review" }),
      task("child", { parentId: "a", column: null }),
      task("other", { assigneeAgentId: "ops" }),
    ];
    const cols = boardColumns(["in_progress", "review"], tasks, new Set(["dev"]));
    expect(cols.map((c) => [c.id, c.cards.map((k) => [k.task.id, k.children])])).toEqual([
      [
        "in_progress",
        [
          ["b", 0],
          ["a", 1],
        ],
      ],
      ["review", [["c", 0]]],
    ]);
  });
});

describe("dropKind", () => {
  it("tells the owner whether a drop follows the rules or is an override", () => {
    expect(dropKind(matrix, "done", "deployed")).toBe("allowed");
    expect(dropKind(matrix, "in_progress", "done")).toBe("override");
    expect(dropKind(matrix, "review", "done")).toBe("override"); // QA's move, not the owner's
    expect(dropKind(matrix, "done", "done")).toBe("same");
  });
});

describe("columnLabel", () => {
  it("uses the catalog for known columns and a readable fallback for custom ones", () => {
    expect(columnLabel("in_progress")).toBe("In progress");
    expect(columnLabel("waiting_for_client")).toBe("Waiting for client");
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

describe("unionColumns", () => {
  it("merges workflow columns of several workspaces, keeping their order", () => {
    expect(
      unionColumns([
        ["backlog", "todo", "in_progress", "review", "done"],
        ["todo", "in_progress", "qa", "done", "deployed"],
      ]),
    ).toEqual(["backlog", "todo", "in_progress", "review", "qa", "done", "deployed"]);
    expect(unionColumns([])).toEqual([]);
  });
});
