import { randomUUID } from "node:crypto";
import { type Db, transaction } from "./db/database.ts";
import { enqueue, getTask, type Task } from "./queue.ts";

/**
 * Creates a child task delegated from `parent` (ADR-0029): same thread and root, one level
 * deeper, the caller appended to the agent chain, never less sensitive than the parent. The
 * parent waits (is not claimable) until the child finishes. Authorization is the caller's job.
 */
export function enqueueChild(
  db: Db,
  parent: Task,
  input: {
    title: string;
    description?: string;
    assigneeAgentId?: string;
    /** The agent delegating (the parent's assignee, or the boss). */
    caller: string;
    sensitivity?: Task["sensitivity"];
    maxAttempts?: number;
  },
  now = Date.now(),
): Task {
  return transaction(db, () => {
    const sensitivity =
      parent.sensitivity === "local-only" ? "local-only" : (input.sensitivity ?? "normal");
    const row = db
      .prepare(
        `INSERT INTO tasks (id, thread_id, parent_id, root_id, depth, agent_chain, title,
           description, assignee_agent_id, max_attempts, sensitivity, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        randomUUID(),
        parent.threadId,
        parent.id,
        parent.rootId ?? parent.id,
        parent.depth + 1,
        JSON.stringify([...parent.agentChain, input.caller]),
        input.title,
        input.description ?? null,
        input.assigneeAgentId ?? null,
        input.maxAttempts ?? 3,
        sensitivity,
        now,
        now,
      );
    db.prepare("UPDATE tasks SET waiting_children = waiting_children + 1 WHERE id = ?").run(
      parent.id,
    );
    return getTask(db, String(row?.id)) as Task;
  });
}

/** Called once a child is done or finally failed: the parent becomes claimable again. */
export function childFinished(db: Db, childId: string): void {
  db.prepare(
    `UPDATE tasks SET waiting_children = MAX(waiting_children - 1, 0)
     WHERE id = (SELECT parent_id FROM tasks WHERE id = ?)`,
  ).run(childId);
}

export function listChildren(db: Db, parentId: string): Task[] {
  return db
    .prepare("SELECT id FROM tasks WHERE parent_id = ? ORDER BY created_at, rowid")
    .all(parentId)
    .map((r) => getTask(db, String(r.id)) as Task);
}

export function addSpend(db: Db, rootId: string, usd: number): void {
  db.prepare("UPDATE tasks SET spent_usd = spent_usd + ? WHERE id = ?").run(usd, rootId);
}

/** Remaining shared budget of a delegation chain; Infinity when the root has none. */
export function remainingBudget(db: Db, rootId: string): number {
  const row = db.prepare("SELECT budget_usd, spent_usd FROM tasks WHERE id = ?").get(rootId);
  if (!row || row.budget_usd === null) return Number.POSITIVE_INFINITY;
  return Number(row.budget_usd) - Number(row.spent_usd);
}

/** A root task delegated by `caller` (normally the boss): depth 1, chain [caller]. */
export function enqueueRoot(
  db: Db,
  input: Parameters<typeof enqueue>[1] & { caller: string },
  now = Date.now(),
): Task {
  return transaction(db, () => {
    const { caller, ...rest } = input;
    const t = enqueue(db, rest, now);
    db.prepare("UPDATE tasks SET depth = 1, agent_chain = ? WHERE id = ?").run(
      JSON.stringify([caller]),
      t.id,
    );
    return getTask(db, t.id) as Task;
  });
}

/**
 * The run delegated work and ended: release the claim so the task is picked up again once its
 * children finish. The continuation does not use up an attempt.
 */
export function waitForChildren(db: Db, id: string, workerId: string, now = Date.now()): boolean {
  const r = db
    .prepare(
      `UPDATE tasks SET status = 'queued', attempts = MAX(attempts - 1, 0), claimed_by = NULL,
         lease_until = NULL, updated_at = ?
       WHERE id = ? AND status = 'claimed' AND claimed_by = ?`,
    )
    .run(now, id, workerId);
  return r.changes === 1;
}

/** The task asks the owner something; it is not claimable until `answerOwnerQuestion`. */
export function askOwner(db: Db, id: string, question: string, now = Date.now()): void {
  db.prepare(
    "UPDATE tasks SET waiting_owner = 1, owner_question = ?, owner_answer = NULL, updated_at = ? WHERE id = ?",
  ).run(question, now, id);
}

/** The oldest task in the thread still waiting for the owner, if any. */
export function openQuestion(db: Db, threadId: string): Task | undefined {
  const row = db
    .prepare(
      "SELECT id FROM tasks WHERE thread_id = ? AND waiting_owner = 1 ORDER BY updated_at, rowid LIMIT 1",
    )
    .get(threadId);
  return row ? getTask(db, String(row.id)) : undefined;
}

/** Routes the owner's message to the oldest open question in the thread (ADR-0029). */
export function answerOwnerQuestion(
  db: Db,
  threadId: string,
  answer: string,
  now = Date.now(),
): Task | undefined {
  const task = openQuestion(db, threadId);
  if (!task) return undefined;
  db.prepare(
    "UPDATE tasks SET waiting_owner = 0, owner_answer = ?, updated_at = ? WHERE id = ?",
  ).run(answer, now, task.id);
  return getTask(db, task.id);
}
