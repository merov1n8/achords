import { describe, expect, it } from "vitest";
import { listMoves, moveCard, placeCard } from "./board.ts";
import { openCoreDatabase, openDatabase } from "./db/database.ts";
import { migrate, migrationsFromDir } from "./db/migrate.ts";
import { enqueue, getTask } from "./queue.ts";

const setup = () => {
  const db = openCoreDatabase(":memory:");
  const t = enqueue(db, { title: "build page" });
  return { db, t };
};

describe("kanban board", () => {
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
