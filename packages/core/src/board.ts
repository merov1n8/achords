import { type Db, transaction } from "./db/database.ts";

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
