import { describe, expect, it } from "vitest";
import {
  cardTitleOf,
  listMoves,
  moveCard,
  placeCard,
  takeOverCard,
  withCardTitles,
  withOwnerWaits,
} from "./board.ts";
import { addChecklistItem, addComment, listChecklist, listComments, updateTask } from "./cards.ts";
import { openCoreDatabase, openDatabase } from "./db/database.ts";
import { migrate, migrationsFromDir } from "./db/migrate.ts";
import { answerOwnerQuestion, askOwner } from "./delegation.ts";
import { enqueue, getTask, type Task } from "./queue.ts";
import { appendMessage, clearActions, createThread, updateThread } from "./threads.ts";

const setup = () => {
  const db = openCoreDatabase(":memory:");
  const t = enqueue(db, { title: "build page" });
  return { db, t };
};

describe("kanban board", () => {
  it("a chat's next task takes over its card: column, checklist, comments and moves", () => {
    const { db, t } = setup();
    placeCard(db, t.id, "in_progress", "system");
    moveCard(db, { taskId: t.id, from: "in_progress", to: "done", actor: "owner" });
    addChecklistItem(db, t.id, "check mobile");
    addComment(db, t.id, "looks good");
    const next = enqueue(db, { title: "fix footer" });
    takeOverCard(db, t.id, next.id, "in_progress", "system");
    expect(getTask(db, t.id)?.column).toBeNull();
    expect(getTask(db, next.id)?.column).toBe("in_progress");
    expect(listChecklist(db, next.id).map((i) => i.text)).toEqual(["check mobile"]);
    expect(listComments(db, next.id).map((c) => c.text)).toEqual(["looks good"]);
    expect(listMoves(db, next.id).map((m) => [m.from, m.to])).toEqual([
      [null, "in_progress"],
      ["in_progress", "done"],
      ["done", "in_progress"],
    ]);
  });

  it("the owner's name for a card goes with it to the task that takes it over", () => {
    const { db, t } = setup();
    placeCard(db, t.id, "in_progress", "system");
    updateTask(db, t.id, { cardTitle: "Partner hotels" });
    const next = enqueue(db, { title: "move the block below" });
    takeOverCard(db, t.id, next.id, "in_progress", "system");
    expect(getTask(db, next.id)).toMatchObject({
      ownCardTitle: "Partner hotels",
      title: "move the block below",
    });
  });

  it("a card shows the owner's name, else its chat's title, else its task's title", () => {
    expect(cardTitleOf({ ownCardTitle: "Mine", title: "task" }, "Chat")).toBe("Mine");
    expect(cardTitleOf({ ownCardTitle: null, title: "task" }, "Chat")).toBe("Chat");
    expect(cardTitleOf({ ownCardTitle: " ", title: "task" }, "  ")).toBe("task");
    expect(cardTitleOf({ ownCardTitle: null, title: "task" }, null)).toBe("task");

    const { db } = setup();
    const th = createThread(db, { title: "Hotel page" });
    const inChat = enqueue(db, { title: "boss title", threadId: th.id });
    const alone = enqueue(db, { title: "by hand" });
    const titles = () =>
      withCardTitles(
        db,
        [inChat.id, alone.id].map((id) => getTask(db, id) as Task),
      );
    expect(titles().map((x) => x.cardTitle)).toEqual(["Hotel page", "by hand"]);
    updateThread(db, th.id, { title: "Hotels" });
    expect(titles()[0]?.cardTitle).toBe("Hotels");
    updateTask(db, inChat.id, { cardTitle: "Mine" });
    expect(titles()[0]?.cardTitle).toBe("Mine");
    expect(getTask(db, inChat.id)?.title).toBe("boss title");
    updateTask(db, inChat.id, { cardTitle: null });
    expect(titles()[0]?.cardTitle).toBe("Hotels");
  });

  it("a card waits for the owner while its chain asks a question or its chat shows approval buttons", () => {
    const { db } = setup();
    const th = createThread(db, { title: "Hotel page" });
    const card = enqueue(db, { title: "build", threadId: th.id });
    // A delegated step of the card, made outside the chat (older rows have no thread).
    const child = enqueue(db, { title: "check", parentId: card.id });
    db.prepare("UPDATE tasks SET root_id = ? WHERE id = ?").run(card.id, child.id);
    const parked = enqueue(db, { title: "later", parked: true });
    for (const id of [card.id, parked.id]) placeCard(db, id, "todo", "system");
    const waits = () =>
      withOwnerWaits(
        db,
        [card.id, child.id, parked.id].map((id) => getTask(db, id) as Task),
      ).map((x) => x.waitsForOwner);
    expect(waits()).toEqual([false, false, false]);
    askOwner(db, child.id, "which colour?");
    // The child has no card of its own; its card shows it.
    expect(waits()).toEqual([true, false, false]);
    db.prepare("UPDATE tasks SET waiting_owner = 0 WHERE id = ?").run(child.id);
    expect(waits()).toEqual([false, false, false]);
    appendMessage(db, {
      threadId: th.id,
      role: "agent",
      channel: "system",
      content: "publish?",
      actions: [{ label: "Approve", data: "publish:approve:abc" }],
    });
    expect(waits()).toEqual([true, false, false]);
    clearActions(db, "publish:", "abc");
    expect(waits()).toEqual([false, false, false]);
    askOwner(db, card.id, "ok?");
    expect(waits()[0]).toBe(true);
    answerOwnerQuestion(db, th.id, "yes");
    expect(waits()[0]).toBe(false);
  });

  it("a task has no card until it is placed; placing logs a move", () => {
    const { db, t } = setup();
    expect(getTask(db, t.id)?.column).toBeNull();
    placeCard(db, t.id, "in_progress", "system");
    expect(getTask(db, t.id)?.column).toBe("in_progress");
    expect(listMoves(db, t.id)).toEqual([
      expect.objectContaining({ from: null, to: "in_progress", actor: "system", override: false }),
    ]);
  });

  it("moves only from the column the mover saw (no lost updates) and logs overrides", () => {
    const { db, t } = setup();
    placeCard(db, t.id, "in_progress", "system");
    expect(
      moveCard(db, { taskId: t.id, from: "in_progress", to: "review", actor: "agent:dev" }),
    ).toBe(true);
    // A second mover that still saw in_progress loses.
    expect(moveCard(db, { taskId: t.id, from: "in_progress", to: "done", actor: "agent:qa" })).toBe(
      false,
    );
    expect(
      moveCard(db, {
        taskId: t.id,
        from: "review",
        to: "deployed",
        actor: "owner",
        override: true,
      }),
    ).toBe(true);
    expect(getTask(db, t.id)?.column).toBe("deployed");
    expect(listMoves(db, t.id).map((m) => [m.from, m.to, m.actor, m.override])).toEqual([
      [null, "in_progress", "system", false],
      ["in_progress", "review", "agent:dev", false],
      ["review", "deployed", "owner", true],
    ]);
  });
});

describe("migration 0008", () => {
  it("gives existing root tasks a card (done stays done) and leaves child tasks without one", () => {
    const db = openDatabase(":memory:");
    const all = migrationsFromDir(new URL("./db/migrations/", import.meta.url));
    migrate(
      db,
      all.filter((m) => m.version < 8),
    );
    const add = (id: string, status: string, parent: string | null) =>
      db
        .prepare(
          "INSERT INTO tasks (id, parent_id, title, status, created_at, updated_at) VALUES (?, ?, 't', ?, 0, 0)",
        )
        .run(id, parent, status);
    add("a", "done", null);
    add("b", "queued", null);
    add("c", "done", "a");
    migrate(db, all);
    const col = (id: string) =>
      db.prepare("SELECT board_column FROM tasks WHERE id = ?").get(id)?.board_column;
    expect([col("a"), col("b"), col("c")]).toEqual(["done", "in_progress", null]);
  });
});
