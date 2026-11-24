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
    /** Ephemeral worker: runs the caller's agent with these restricted permissions. */
    workerSpec?: { tools: string[]; paths: string[] };
    /** A discussion turn (ADR-0032). */
    roomId?: string;
  },
  now = Date.now(),
): Task {
  return transaction(db, () => {
    const sensitivity =
      parent.sensitivity === "local-only" ? "local-only" : (input.sensitivity ?? "normal");
    const row = db
      .prepare(
        `INSERT INTO tasks (id, thread_id, parent_id, root_id, depth, agent_chain, title,
           description, assignee_agent_id, max_attempts, sensitivity, worker_spec, project,
           room_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
        input.workerSpec ? JSON.stringify(input.workerSpec) : null,
        parent.project,
        input.roomId ?? null,
        now,
        now,
      );
    db.prepare("UPDATE tasks SET waiting_children = waiting_children + 1 WHERE id = ?").run(
      parent.id,
    );
    return getTask(db, String(row?.id)) as Task;
  });
}

/**
 * Handoff (ADR-0055): the successor of `caller` continues its work as a sibling (same parent,
 * root and depth), so a pipeline does not use up delegation depth. The caller joins the chain, so
 * no earlier step of the line can be handed back to. A waiting parent now also waits for the
 * successor; the caller's own finish releases its place as before.
 */
export function enqueueSuccessor(
  db: Db,
  caller: Task,
  input: {
    title: string;
    description?: string;
    assigneeAgentId?: string;
    caller: string;
    runMode?: "accounts" | "web";
  },
  now = Date.now(),
): Task {
  return transaction(db, () => {
    const row = db
      .prepare(
        `INSERT INTO tasks (id, thread_id, parent_id, root_id, depth, agent_chain, title,
           description, assignee_agent_id, max_attempts, sensitivity, project, continues_from,
           run_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        randomUUID(),
        caller.threadId,
        caller.parentId,
        caller.rootId ?? caller.id,
        caller.depth,
        JSON.stringify([...caller.agentChain, input.caller]),
        input.title,
        input.description ?? null,
        input.assigneeAgentId ?? null,
        caller.maxAttempts,
        caller.sensitivity,
        caller.project,
        caller.id,
        input.runMode ?? null,
        now,
        now,
      );
    if (caller.parentId) {
      db.prepare("UPDATE tasks SET waiting_children = waiting_children + 1 WHERE id = ?").run(
        caller.parentId,
      );
    }
    return getTask(db, String(row?.id)) as Task;
  });
}

/** Stores the handoff a running task asked for; the run's end turns it into the successor. */
export function requestHandoff(
  db: Db,
  id: string,
  handoff: NonNullable<Task["handoff"]>,
  now = Date.now(),
): void {
  db.prepare("UPDATE tasks SET handoff = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(handoff),
    now,
    id,
  );
}

/** How many handoffs led to this task along its line. */
export function handoffHops(db: Db, task: Task): number {
  let hops = 0;
  let from = task.continuesFrom;
  while (from) {
    hops++;
    from = getTask(db, from)?.continuesFrom ?? null;
  }
  return hops;
}

/** Delegated and handed-off tasks under one root, the root included (helpers and turns not). */
export function lineTaskCount(db: Db, rootId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks
       WHERE (id = ? OR root_id = ?) AND worker_spec IS NULL AND room_id IS NULL`,
    )
    .get(rootId, rootId);
  return Number(row?.n ?? 0);
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

/**
 * A delegated task asks its parent (ADR-0066): it waits for the answer, and its question wakes
 * the parent although the parent still waits for its children. Separate from `askOwner`, so the
 * owner's chat reply never answers it.
 */
export function askParent(db: Db, id: string, question: string, now = Date.now()): void {
  db.prepare(
    `UPDATE tasks SET waiting_parent = 1, parent_question = ?, parent_answer = NULL,
       parent_questions = parent_questions + 1, updated_at = ? WHERE id = ?`,
  ).run(question, now, id);
}

/** The parent's answer: the child is claimable again and resumes with it. */
export function answerParentQuestion(
  db: Db,
  childId: string,
  answer: string,
  now = Date.now(),
): boolean {
  const r = db
    .prepare(
      "UPDATE tasks SET waiting_parent = 0, parent_answer = ?, updated_at = ? WHERE id = ? AND waiting_parent > 0",
    )
    .run(answer, now, childId);
  return r.changes === 1;
}

/** Children of `parentId` with an open question to it, oldest first. */
export function childQuestions(db: Db, parentId: string): Task[] {
  return db
    .prepare(
      "SELECT id FROM tasks WHERE parent_id = ? AND waiting_parent > 0 ORDER BY updated_at, rowid",
    )
    .all(parentId)
    .map((r) => getTask(db, String(r.id)) as Task);
}

/**
 * A parent run saw these questions and ended without answering: they stay open, but no longer
 * wake the parent (else an unanswered question would wake it again and again).
 */
export function childQuestionsSeen(db: Db, childIds: string[]): void {
  const stmt = db.prepare(
    "UPDATE tasks SET waiting_parent = 2 WHERE id = ? AND waiting_parent = 1",
  );
  for (const id of childIds) stmt.run(id);
}
