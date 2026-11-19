import { randomUUID } from "node:crypto";
import type { Db } from "./db/database.ts";
import { transaction } from "./db/database.ts";

export type TaskStatus = "queued" | "claimed" | "done" | "failed" | "cancelled";

export interface Task {
  id: string;
  threadId: string | null;
  parentId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  assigneeAgentId: string | null;
  attempts: number;
  maxAttempts: number;
  claimedBy: string | null;
  leaseUntil: number | null;
  result: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

const toTask = (r: Record<string, unknown>): Task => ({
  id: r.id as string,
  threadId: r.thread_id as string | null,
  parentId: r.parent_id as string | null,
  title: r.title as string,
  description: r.description as string | null,
  status: r.status as TaskStatus,
  priority: Number(r.priority),
  assigneeAgentId: r.assignee_agent_id as string | null,
  attempts: Number(r.attempts),
  maxAttempts: Number(r.max_attempts),
  claimedBy: r.claimed_by as string | null,
  leaseUntil: r.lease_until === null ? null : Number(r.lease_until),
  result: r.result as string | null,
  error: r.error as string | null,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const PAUSED_KEY = "queue.paused";

export function enqueue(
  db: Db,
  input: {
    title: string;
    description?: string;
    threadId?: string;
    parentId?: string;
    assigneeAgentId?: string;
    priority?: number;
    maxAttempts?: number;
  },
  now = Date.now(),
): Task {
  const row = db
    .prepare(
      `INSERT INTO tasks (id, thread_id, parent_id, title, description, priority,
         assignee_agent_id, max_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      randomUUID(),
      input.threadId ?? null,
      input.parentId ?? null,
      input.title,
      input.description ?? null,
      input.priority ?? 0,
      input.assigneeAgentId ?? null,
      input.maxAttempts ?? 3,
      now,
      now,
    );
  return toTask(row as Record<string, unknown>);
}

export function getTask(db: Db, id: string): Task | undefined {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  return row ? toTask(row) : undefined;
}

/**
 * Atomically claims the next task. Expired leases (crashed workers) are first returned to the
 * queue, or failed if they used their last attempt. Returns undefined when empty or paused.
 */
export function claim(
  db: Db,
  opts: { workerId: string; leaseMs: number },
  now = Date.now(),
): Task | undefined {
  return transaction(db, () => {
    db.prepare(
      `UPDATE tasks SET
         status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
         error = CASE WHEN attempts >= max_attempts THEN 'lease expired' ELSE error END,
         claimed_by = NULL, lease_until = NULL, updated_at = ?
       WHERE status = 'claimed' AND lease_until < ?`,
    ).run(now, now);

    if (isPaused(db)) return undefined;

    const row = db
      .prepare(
        `UPDATE tasks SET status = 'claimed', claimed_by = ?, lease_until = ?,
           attempts = attempts + 1, updated_at = ?
         WHERE id = (
           SELECT id FROM tasks WHERE status = 'queued'
           ORDER BY priority DESC, created_at, rowid LIMIT 1
         )
         RETURNING *`,
      )
      .get(opts.workerId, now + opts.leaseMs, now);
    return row ? toTask(row) : undefined;
  });
}

/** Long runs call this periodically so they are not reclaimed as crashed. */
export function extendLease(
  db: Db,
  id: string,
  workerId: string,
  leaseMs: number,
  now = Date.now(),
): boolean {
  const r = db
    .prepare(
      `UPDATE tasks SET lease_until = ?, updated_at = ?
       WHERE id = ? AND status = 'claimed' AND claimed_by = ?`,
    )
    .run(now + leaseMs, now, id, workerId);
  return r.changes === 1;
}

/** Returns false if the worker no longer holds the claim (reclaimed or cancelled). */
export function complete(
  db: Db,
  id: string,
  workerId: string,
  result: string,
  now = Date.now(),
): boolean {
  const r = db
    .prepare(
      `UPDATE tasks SET status = 'done', result = ?, error = NULL,
         claimed_by = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND status = 'claimed' AND claimed_by = ?`,
    )
    .run(result, now, id, workerId);
  return r.changes === 1;
}

/** Requeues the task while attempts remain, otherwise marks it failed. */
export function fail(
  db: Db,
  id: string,
  workerId: string,
  error: string,
  now = Date.now(),
): boolean {
  const r = db
    .prepare(
      `UPDATE tasks SET
         status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
         error = ?, claimed_by = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND status = 'claimed' AND claimed_by = ?`,
    )
    .run(error, now, id, workerId);
  return r.changes === 1;
}

export function cancel(db: Db, id: string, now = Date.now()): boolean {
  const r = db
    .prepare(
      `UPDATE tasks SET status = 'cancelled', claimed_by = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'claimed')`,
    )
    .run(now, id);
  return r.changes === 1;
}

export function isPaused(db: Db): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(PAUSED_KEY);
  return row?.value === "true";
}

export function setPaused(db: Db, paused: boolean): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(PAUSED_KEY, String(paused));
}
