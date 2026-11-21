import { describe, expect, it } from "vitest";
import { placeCard } from "./board.ts";
import {
  addChecklistItem,
  addComment,
  type ChecklistItem,
  deleteCard,
  deleteComment,
  listChecklist,
  listComments,
  removeChecklistItem,
  startParked,
  updateChecklistItem,
  updateTask,
} from "./cards.ts";
import { openCoreDatabase } from "./db/database.ts";
import { enqueueChild } from "./delegation.ts";
import { claim, enqueue, getTask } from "./queue.ts";
import { getRoom, openRoom } from "./rooms.ts";
import { getThread } from "./threads.ts";

const LEASE = 60_000;

describe("owner card edits", () => {
  it("edits title and description; clears the description with null", () => {
    const db = openCoreDatabase(":memory:");
    const t = enqueue(db, { title: "old", description: "d" }, 1);
    expect(updateTask(db, t.id, { title: "new" }, 5)).toMatchObject({
      title: "new",
      description: "d",
      updatedAt: 5,
    });
    expect(updateTask(db, t.id, { description: null })?.description).toBeNull();
    expect(updateTask(db, "missing", { title: "x" })).toBeUndefined();
  });

  it("keeps an ordered checklist the owner can tick, reword and remove", () => {
    const db = openCoreDatabase(":memory:");
    const t = enqueue(db, { title: "card" });
    const a = addChecklistItem(db, t.id, "first", 1) as ChecklistItem;
    const b = addChecklistItem(db, t.id, "second", 2) as ChecklistItem;
    expect(addChecklistItem(db, "missing", "x")).toBeUndefined();
    expect(updateChecklistItem(db, t.id, a.id, { done: true }, 3)).toMatchObject({
      text: "first",
      done: true,
      updatedAt: 3,
    });
    expect(updateChecklistItem(db, t.id, b.id, { text: "2nd" })?.text).toBe("2nd");
    // An item of another card is not reachable through this card.
    const other = enqueue(db, { title: "other" });
    expect(updateChecklistItem(db, other.id, a.id, { done: false })).toBeUndefined();
    expect(removeChecklistItem(db, other.id, a.id)).toBe(false);
    expect(listChecklist(db, t.id).map((i) => [i.text, i.done])).toEqual([
      ["first", true],
      ["2nd", false],
    ]);
    expect(removeChecklistItem(db, t.id, a.id)).toBe(true);
    expect(listChecklist(db, t.id).map((i) => i.text)).toEqual(["2nd"]);
  });

  it("appends comments and deletes one", () => {
    const db = openCoreDatabase(":memory:");
    const t = enqueue(db, { title: "card" });
    const c1 = addComment(db, t.id, "one", 1);
    addComment(db, t.id, "two", 2);
    expect(addComment(db, "missing", "x")).toBeUndefined();
    expect(deleteComment(db, "missing", c1?.id ?? 0)).toBe(false);
    expect(deleteComment(db, t.id, c1?.id ?? 0)).toBe(true);
    expect(listComments(db, t.id).map((c) => [c.text, c.createdAt])).toEqual([["two", 2]]);
  });
});

describe("deleteCard", () => {
  it("deletes the card with its whole subtree, moves, notes and discussion threads", () => {
    const db = openCoreDatabase(":memory:");
    const root = enqueue(db, { title: "card" });
    placeCard(db, root.id, "todo", "owner");
    addChecklistItem(db, root.id, "x");
    addComment(db, root.id, "y");
    const child = enqueueChild(db, root, { title: "child", caller: "boss" });
    const grandchild = enqueueChild(db, child, { title: "grandchild", caller: "dev" });
    const room = openRoom(db, {
      openerTaskId: root.id,
      openerAgentId: "boss",
      topic: "t",
      question: "q",
      participants: ["a"],
      rounds: 1,
    });
    enqueueChild(db, root, { title: "turn", caller: "boss", roomId: room.id });
    const unrelated = enqueue(db, { title: "keep" });

    expect(deleteCard(db, root.id)).toEqual({ ok: true, deleted: 4 });
    for (const id of [root.id, child.id, grandchild.id]) expect(getTask(db, id)).toBeUndefined();
    expect(getRoom(db, room.id)).toBeUndefined();
    expect(getThread(db, room.id)).toBeUndefined();
    expect(listChecklist(db, root.id)).toEqual([]);
    expect(listComments(db, root.id)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_moves").get()?.n).toBe(0);
    expect(getTask(db, unrelated.id)).toBeDefined();
  });

  it("refuses while the card or any step inside it is running", () => {
    const db = openCoreDatabase(":memory:");
    const root = enqueue(db, { title: "card" }, 1);
    const child = enqueueChild(db, root, { title: "child", caller: "boss" }, 2);
    // The root waits for its child, so the claim takes the child.
    expect(claim(db, { workerId: "w", leaseMs: LEASE })?.id).toBe(child.id);
    expect(deleteCard(db, root.id)).toEqual({ ok: false, reason: "running" });
    expect(getTask(db, root.id)).toBeDefined();
  });

  it("refuses a step inside a card and unknown tasks", () => {
    const db = openCoreDatabase(":memory:");
    const root = enqueue(db, { title: "card" });
    const child = enqueueChild(db, root, { title: "child", caller: "boss" });
    expect(deleteCard(db, child.id)).toEqual({ ok: false, reason: "not a card" });
    expect(deleteCard(db, "missing")).toEqual({ ok: false, reason: "no such task" });
  });
});

describe("startParked", () => {
  const withAgent = () => {
    const db = openCoreDatabase(":memory:");
    db.prepare(
      "INSERT INTO agents (id, name, role, created_at, updated_at) VALUES ('dev', 'dev', 'dev', 0, 0)",
    ).run();
    return db;
  };

  it("un-parks once, sets the assignee and budget; then a worker may claim it", () => {
    const db = withAgent();
    const t = enqueue(db, { title: "later", parked: true }, 1);
    expect(claim(db, { workerId: "w", leaseMs: LEASE })).toBeUndefined();
    expect(startParked(db, t.id, { assigneeAgentId: "dev", budgetUsd: 2 }, 5)).toBe(true);
    expect(getTask(db, t.id)).toMatchObject({
      parked: false,
      assigneeAgentId: "dev",
      budgetUsd: 2,
      updatedAt: 5,
    });
    expect(startParked(db, t.id, { assigneeAgentId: "dev" })).toBe(false);
    expect(claim(db, { workerId: "w", leaseMs: LEASE })?.id).toBe(t.id);
  });

  it("keeps an existing budget when none is given", () => {
    const db = withAgent();
    const t = enqueue(db, { title: "later", parked: true, budgetUsd: 3 }, 1);
    startParked(db, t.id, { assigneeAgentId: "dev" });
    expect(getTask(db, t.id)?.budgetUsd).toBe(3);
  });
});
