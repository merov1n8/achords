import { randomUUID } from "node:crypto";
import type { Db } from "./db/database.ts";
import { transaction } from "./db/database.ts";
import { getSetting, setSetting } from "./settings.ts";

export type TaskStatus = "queued" | "claimed" | "done" | "failed" | "cancelled";

export interface Task {
  id: string;
  sensitivity: "normal" | "local-only";
  rootId: string | null;
  depth: number;
  /** Agents that delegated down to this task, root first (ADR-0029). */
  agentChain: string[];
  budgetUsd: number | null;
  spentUsd: number;
  waitingChildren: number;
  /** An open question to the owner (ask_owner); the task waits for the answer. */
  waitingOwner: boolean;
  ownerQuestion: string | null;
  ownerAnswer: string | null;
  /** An open question to the parent task (ask_parent, ADR-0066); the task waits for the answer. */
  waitingParent: boolean;
  parentQuestion: string | null;
  parentAnswer: string | null;
  /** How many questions this task asked its parent. */
  parentQuestions: number;
  /** Set on ephemeral worker tasks: the restricted permissions they run with. */
  workerSpec: { tools: string[]; paths: string[] } | null;
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
  /** Kanban column (ADR-0030); null = no card of its own (child tasks, helpers). */
  column: string | null;
  /** Project slug (ADR-0031), inherited by child tasks. */
  project: string | null;
  /** Set on a discussion turn (ADR-0032): the room this task speaks in. */
  roomId: string | null;
  /** Left by a planned stop: where the agent was, for the run that continues. */
  resumeNote: string | null;
  /** A card made by hand and not started yet: never claimed until the owner starts it. */
  parked: boolean;
  /** Handoff (ADR-0055): the earlier step whose work this task continues. */
  continuesFrom: string | null;
  /** Handoff asked for during the run; the successor is created when the run ends well. */
  handoff: { agent: string; title: string; instructions: string } | null;
}

const toTask = (r: Record<string, unknown>): Task => ({
  id: r.id as string,
  column: (r.board_column as string | null) ?? null,
  project: (r.project as string | null) ?? null,
  roomId: (r.room_id as string | null) ?? null,
  resumeNote: (r.resume_note as string | null) ?? null,
  parked: Number(r.parked) === 1,
  continuesFrom: (r.continues_from as string | null) ?? null,
  handoff: r.handoff ? (JSON.parse(String(r.handoff)) as Task["handoff"]) : null,
  sensitivity: r.sensitivity as Task["sensitivity"],
  rootId: r.root_id as string | null,
  depth: Number(r.depth),
  agentChain: JSON.parse(String(r.agent_chain)) as string[],
  budgetUsd: r.budget_usd === null ? null : Number(r.budget_usd),
  spentUsd: Number(r.spent_usd),
  waitingChildren: Number(r.waiting_children),
  waitingOwner: Number(r.waiting_owner) === 1,
  ownerQuestion: r.owner_question as string | null,
  ownerAnswer: r.owner_answer as string | null,
  waitingParent: Number(r.waiting_parent) > 0,
  parentQuestion: (r.parent_question as string | null) ?? null,
  parentAnswer: (r.parent_answer as string | null) ?? null,
  parentQuestions: Number(r.parent_questions ?? 0),
  workerSpec: r.worker_spec ? (JSON.parse(String(r.worker_spec)) as Task["workerSpec"]) : null,
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
    sensitivity?: Task["sensitivity"];
    /** Root tasks only: one budget for the whole delegation chain. */
    budgetUsd?: number;
    /** Project slug (ADR-0031). */
    project?: string;
    /** Not claimable until started (a card the owner made by hand). */
    parked?: boolean;
  },
  now = Date.now(),
): Task {
  const row = db
    .prepare(
      `INSERT INTO tasks (id, thread_id, parent_id, title, description, priority,
         assignee_agent_id, max_attempts, sensitivity, budget_usd, project, parked, created_at,
         updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
      input.sensitivity ?? "normal",
      input.budgetUsd ?? null,
      input.project ?? null,
      input.parked ? 1 : 0,
      now,
      now,
    );
  return toTask(row as Record<string, unknown>);
}

export function listTasks(db: Db, limit = 200): Task[] {
  return db
    .prepare("SELECT * FROM tasks ORDER BY updated_at DESC, rowid DESC LIMIT ?")
    .all(limit)
    .map(toTask);
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
    // Children that die with their worker on the last attempt must still wake their parent.
    const dead = db
      .prepare(
        `SELECT parent_id FROM tasks WHERE status = 'claimed' AND lease_until < ?
           AND attempts >= max_attempts AND parent_id IS NOT NULL`,
      )
      .all(now);
    for (const r of dead) {
      db.prepare(
        "UPDATE tasks SET waiting_children = MAX(waiting_children - 1, 0) WHERE id = ?",
      ).run(String(r.parent_id));
    }
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
           SELECT p.id FROM tasks p WHERE p.status = 'queued' AND p.waiting_owner = 0
             AND p.waiting_parent = 0 AND p.parked = 0
             AND (p.not_before IS NULL OR p.not_before <= ?)
             -- A child's new question to its parent wakes the parent despite open children.
             AND (p.waiting_children = 0 OR EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = p.id
               AND c.waiting_parent = 1 AND c.status = 'queued'))
           ORDER BY p.priority DESC, p.created_at, p.rowid LIMIT 1
         )
         RETURNING *`,
      )
      .get(opts.workerId, now + opts.leaseMs, now, now);
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

/**
 * Puts a claimed task back to wait for a resource (e.g. the local model server) without using
 * up an attempt; it is not claimed again before `delayMs` has passed.
 */
export function defer(
  db: Db,
  id: string,
  workerId: string,
  reason: string,
  delayMs: number,
  now = Date.now(),
): boolean {
  const r = db
    .prepare(
      `UPDATE tasks SET status = 'queued', attempts = MAX(attempts - 1, 0), error = ?,
         not_before = ?, claimed_by = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND status = 'claimed' AND claimed_by = ?`,
    )
    .run(reason, now + delayMs, now, id, workerId);
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
  return getSetting(db, PAUSED_KEY) === "true";
}

export function setPaused(db: Db, paused: boolean): void {
  setSetting(db, PAUSED_KEY, String(paused));
}

/**
 * Planned stop: puts a claimed task back without using up an attempt (the stop was not its
 * fault) and leaves a note for the run that continues it.
 */
export function requeueInterrupted(
  db: Db,
  id: string,
  workerId: string,
  note: string,
  now = Date.now(),
): boolean {
  const r = db
    .prepare(
      `UPDATE tasks SET status = 'queued', attempts = MAX(attempts - 1, 0), resume_note = ?,
         claimed_by = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND status = 'claimed' AND claimed_by = ?`,
    )
    .run(note, now, id, workerId);
  return Number(r.changes) === 1;
}

export function clearResumeNote(db: Db, id: string): void {
  db.prepare("UPDATE tasks SET resume_note = NULL WHERE id = ?").run(id);
}

const DRAINING_KEY = "gateway.draining";

/** `achords stop` in progress: no new work is started, running work may finish. */
export function isDraining(db: Db): boolean {
  return getSetting(db, DRAINING_KEY) === "true";
}

export function setDraining(db: Db, on: boolean): void {
  setSetting(db, DRAINING_KEY, String(on));
}
