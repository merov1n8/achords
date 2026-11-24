import { type Db, transaction } from "./db/database.ts";
import type { Task } from "./queue.ts";

export interface CardMove {
  from: string | null;
  to: string;
  actor: string;
  override: boolean;
  createdAt: number;
}

const log = (
  db: Db,
  taskId: string,
  from: string | null,
  to: string,
  actor: string,
  override: boolean,
  now: number,
) =>
  db
    .prepare(
      "INSERT INTO task_moves (task_id, from_column, to_column, actor, override, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(taskId, from, to, actor, override ? 1 : 0, now);

/** Puts a task on the board (it has no card before). */
export function placeCard(
  db: Db,
  taskId: string,
  column: string,
  actor: string,
  now = Date.now(),
): void {
  transaction(db, () => {
    db.prepare("UPDATE tasks SET board_column = ? WHERE id = ?").run(column, taskId);
    log(db, taskId, null, column, actor, false, now);
  });
}

/**
 * Moves a card if it is still where the mover saw it (compare-and-swap), and logs the move.
 * Permission checks happen before, against the workflow (policy checkMove).
 */
export function moveCard(
  db: Db,
  m: { taskId: string; from: string; to: string; actor: string; override?: boolean },
  now = Date.now(),
): boolean {
  return transaction(db, () => {
    const changed = db
      .prepare(
        "UPDATE tasks SET board_column = ?, updated_at = ? WHERE id = ? AND board_column = ?",
      )
      .run(m.to, now, m.taskId, m.from).changes;
    if (Number(changed) === 0) return false;
    log(db, m.taskId, m.from, m.to, m.actor, m.override ?? false, now);
    return true;
  });
}

export function listMoves(db: Db, taskId: string): CardMove[] {
  return db
    .prepare(
      "SELECT from_column, to_column, actor, override, created_at FROM task_moves WHERE task_id = ? ORDER BY id",
    )
    .all(taskId)
    .map((r) => ({
      from: r.from_column as string | null,
      to: r.to_column as string,
      actor: r.actor as string,
      override: Number(r.override) === 1,
      createdAt: Number(r.created_at),
    }));
}

/**
 * One chat, one card: the chat's next task takes over the card of the earlier one. The card moves
 * to `column` on the new task, with its checklist, comments and move history; the earlier task
 * leaves the board (it stays in the database and in the chat). The owner's name for the card
 * goes with it.
 */
export function takeOverCard(
  db: Db,
  fromId: string,
  toId: string,
  column: string,
  actor: string,
  now = Date.now(),
): void {
  transaction(db, () => {
    const from = db.prepare("SELECT board_column FROM tasks WHERE id = ?").get(fromId)
      ?.board_column as string | null | undefined;
    for (const table of ["task_checklist", "task_comments", "task_moves"]) {
      db.prepare(`UPDATE ${table} SET task_id = ? WHERE task_id = ?`).run(toId, fromId);
    }
    db.prepare("UPDATE tasks SET board_column = NULL WHERE id = ?").run(fromId);
    db.prepare(
      "UPDATE tasks SET board_column = ?, card_title = (SELECT card_title FROM tasks WHERE id = ?) WHERE id = ?",
    ).run(column, fromId, toId);
    log(db, toId, from ?? null, column, actor, false, now);
  });
}

/** The chat's card: its newest top-level task on the board, if any. */
export function threadCard(db: Db, threadId: string): string | undefined {
  const r = db
    .prepare(
      `SELECT id FROM tasks WHERE thread_id = ? AND parent_id IS NULL AND room_id IS NULL
         AND board_column IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(threadId);
  return r ? (r.id as string) : undefined;
}

/**
 * The title a card shows: the owner's own name for it, else its chat's title, else the title of
 * the task holding it (each follow-up task in the chat brings a new one, so it comes last).
 */
export function cardTitleOf(
  task: Pick<Task, "ownCardTitle" | "title">,
  threadTitle: string | null | undefined,
): string {
  return task.ownCardTitle?.trim() || threadTitle?.trim() || task.title;
}

/** Adds `cardTitle` (cardTitleOf) to tasks, reading each chat's title once. */
export function withCardTitles<T extends Task>(db: Db, tasks: T[]): (T & { cardTitle: string })[] {
  const titles = new Map<string, string | null>();
  const q = db.prepare("SELECT title FROM threads WHERE id = ?");
  return tasks.map((t) => {
    if (t.threadId && !titles.has(t.threadId)) {
      titles.set(t.threadId, (q.get(t.threadId)?.title as string | null | undefined) ?? null);
    }
    return { ...t, cardTitle: cardTitleOf(t, t.threadId ? titles.get(t.threadId) : null) };
  });
}
