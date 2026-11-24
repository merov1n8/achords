import { type Db, transaction } from "./db/database.ts";
import { getTask, type Task } from "./queue.ts";

// Owner edits on kanban cards: title/description, a checklist, comments, and deleting a card.

export interface ChecklistItem {
  id: number;
  text: string;
  done: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TaskComment {
  id: number;
  text: string;
  /** null: the owner's own comment; else the agent that recorded a room outcome (ADR-0066). */
  author: string | null;
  /** The room whose outcome this comment is. */
  roomId: string | null;
  createdAt: number;
}

const toItem = (r: Record<string, unknown>): ChecklistItem => ({
  id: Number(r.id),
  text: r.text as string,
  done: Number(r.done) === 1,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const toComment = (r: Record<string, unknown>): TaskComment => ({
  id: Number(r.id),
  text: r.text as string,
  author: (r.author as string | null) ?? null,
  roomId: (r.room_id as string | null) ?? null,
  createdAt: Number(r.created_at),
});

/** `description: null` clears it. Returns undefined for an unknown task. */
export function updateTask(
  db: Db,
  id: string,
  patch: { title?: string; description?: string | null },
  now = Date.now(),
): Task | undefined {
  const r = db
    .prepare(
      `UPDATE tasks SET title = COALESCE(?, title),
         description = CASE WHEN ? THEN ? ELSE description END, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      patch.title ?? null,
      patch.description !== undefined ? 1 : 0,
      patch.description ?? null,
      now,
      id,
    );
  return Number(r.changes) === 1 ? getTask(db, id) : undefined;
}

/**
 * Starts a parked card (made by hand): gives it its agent and budget and makes it claimable.
 * Returns false if it was not parked (already started, or unknown). Policy checks come before.
 */
export function startParked(
  db: Db,
  id: string,
  input: { assigneeAgentId: string; budgetUsd?: number },
  now = Date.now(),
): boolean {
  const r = db
    .prepare(
      `UPDATE tasks SET parked = 0, assignee_agent_id = ?, budget_usd = COALESCE(?, budget_usd),
         updated_at = ?
       WHERE id = ? AND parked = 1`,
    )
    .run(input.assigneeAgentId, input.budgetUsd ?? null, now, id);
  return Number(r.changes) === 1;
}

/**
 * Deletes a card (a root task) with every task below it. Refused while any of them is claimed:
 * a worker holds it and would finish into a task that no longer exists. Discussion threads
 * opened inside the card go too; the card's chat stays.
 */
export function deleteCard(
  db: Db,
  id: string,
):
  | { ok: true; deleted: number }
  | { ok: false; reason: "no such task" | "not a card" | "running" } {
  return transaction(db, () => {
    const task = getTask(db, id);
    if (!task) return { ok: false, reason: "no such task" };
    if (task.parentId) return { ok: false, reason: "not a card" };
    const ids = db
      .prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT ? UNION SELECT t.id FROM tasks t JOIN tree ON t.parent_id = tree.id)
         SELECT tasks.id, tasks.status FROM tasks JOIN tree USING (id)`,
      )
      .all(id);
    if (ids.some((r) => r.status === "claimed")) return { ok: false, reason: "running" };
    const list = JSON.stringify(ids.map((r) => r.id));
    const rooms = db
      .prepare("SELECT id FROM rooms WHERE opener_task_id IN (SELECT value FROM json_each(?))")
      .all(list);
    // Tasks first: their room_id references the rooms that the thread delete cascades away.
    db.prepare("DELETE FROM tasks WHERE id IN (SELECT value FROM json_each(?))").run(list);
    db.prepare("DELETE FROM threads WHERE id IN (SELECT value FROM json_each(?))").run(
      JSON.stringify(rooms.map((r) => r.id)),
    );
    return { ok: true, deleted: ids.length };
  });
}

const exists = (db: Db, taskId: string) =>
  db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId) !== undefined;

export function listChecklist(db: Db, taskId: string): ChecklistItem[] {
  return db
    .prepare("SELECT * FROM task_checklist WHERE task_id = ? ORDER BY id")
    .all(taskId)
    .map(toItem);
}

export function addChecklistItem(
  db: Db,
  taskId: string,
  text: string,
  now = Date.now(),
): ChecklistItem | undefined {
  if (!exists(db, taskId)) return undefined;
  const row = db
    .prepare(
      "INSERT INTO task_checklist (task_id, text, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING *",
    )
    .get(taskId, text, now, now);
  return toItem(row as Record<string, unknown>);
}

export function updateChecklistItem(
  db: Db,
  taskId: string,
  itemId: number,
  patch: { text?: string; done?: boolean },
  now = Date.now(),
): ChecklistItem | undefined {
  const row = db
    .prepare(
      `UPDATE task_checklist SET text = COALESCE(?, text), done = COALESCE(?, done), updated_at = ?
       WHERE id = ? AND task_id = ? RETURNING *`,
    )
    .get(
      patch.text ?? null,
      patch.done === undefined ? null : patch.done ? 1 : 0,
      now,
      itemId,
      taskId,
    );
  return row ? toItem(row) : undefined;
}

export function removeChecklistItem(db: Db, taskId: string, itemId: number): boolean {
  const r = db
    .prepare("DELETE FROM task_checklist WHERE id = ? AND task_id = ?")
    .run(itemId, taskId);
  return Number(r.changes) === 1;
}

export function listComments(db: Db, taskId: string): TaskComment[] {
  return db
    .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY id")
    .all(taskId)
    .map(toComment);
}

export function addComment(
  db: Db,
  taskId: string,
  text: string,
  now = Date.now(),
): TaskComment | undefined {
  if (!exists(db, taskId)) return undefined;
  const row = db
    .prepare("INSERT INTO task_comments (task_id, text, created_at) VALUES (?, ?, ?) RETURNING *")
    .get(taskId, text, now);
  return toComment(row as Record<string, unknown>);
}

export function deleteComment(db: Db, taskId: string, commentId: number): boolean {
  const r = db
    .prepare("DELETE FROM task_comments WHERE id = ? AND task_id = ?")
    .run(commentId, taskId);
  return Number(r.changes) === 1;
}
