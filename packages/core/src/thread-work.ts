import type { Db } from "./db/database.ts";
import { killRun } from "./emergency.ts";
import { cancel } from "./queue.ts";
import { finishRun, listActiveRuns } from "./runs.ts";

export type ParticipantStatus = "running" | "queued" | "idle" | "waiting";

export interface ThreadSummary {
  agentsWorking: number;
  agentsTotal: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  participants: { agent: string; name: string; status: ParticipantStatus }[];
}

// Delegated children carry the thread too; the root clause also catches older rows without it.
const THREAD_TASKS =
  "SELECT id FROM tasks WHERE thread_id = ? OR root_id IN (SELECT id FROM tasks WHERE thread_id = ?)";

// When an agent has several tasks in the chat, the busiest one decides its badge.
const RANK: ParticipantStatus[] = ["idle", "queued", "waiting", "running"];

/** The chat's run details: who works on it, and the tokens and cost of its runs (boss turns excluded). */
export function threadSummary(db: Db, threadId: string): ThreadSummary {
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o,
         COALESCE(SUM(cost_usd), 0) AS usd
       FROM runs WHERE task_id IN (${THREAD_TASKS})`,
    )
    .get(threadId, threadId);
  const rows = db
    .prepare(
      `SELECT x.*, a.name FROM (
         SELECT t.status, t.waiting_children, t.waiting_owner, t.parked, t.created_at,
           t.rowid AS seq, COALESCE(t.assignee_agent_id, (SELECT r.agent_id FROM runs r
             WHERE r.task_id = t.id ORDER BY r.started_at DESC LIMIT 1)) AS agent
         FROM tasks t WHERE t.id IN (${THREAD_TASKS})
       ) x LEFT JOIN agents a ON a.id = x.agent ORDER BY x.created_at, x.seq`,
    )
    .all(threadId, threadId);
  const byAgent = new Map<string, ThreadSummary["participants"][number]>();
  for (const r of rows) {
    if (r.agent === null) continue;
    const status: ParticipantStatus =
      r.status === "claimed"
        ? "running"
        : r.status !== "queued" || Number(r.parked) === 1
          ? "idle"
          : Number(r.waiting_children) > 0 || Number(r.waiting_owner) === 1
            ? "waiting"
            : "queued";
    const agent = String(r.agent);
    const seen = byAgent.get(agent);
    if (!seen) byAgent.set(agent, { agent, name: String(r.name ?? agent), status });
    else if (RANK.indexOf(status) > RANK.indexOf(seen.status)) seen.status = status;
  }
  const participants = [...byAgent.values()];
  return {
    agentsWorking: participants.filter((p) => p.status === "running").length,
    agentsTotal: participants.length,
    tokensIn: Number(totals?.i ?? 0),
    tokensOut: Number(totals?.o ?? 0),
    costUsd: Number(totals?.usd ?? 0),
    participants,
  };
}

/**
 * The owner's Stop for one chat: its queued and waiting tasks are cancelled, its running ones
 * too, and their runs' process groups are killed the way `achords kill` does it. Tasks are
 * cancelled first, so the worker that sees its run die cannot put the task back in the queue.
 */
export function stopThread(db: Db, threadId: string): { cancelled: number; stopped: number } {
  const open = db
    .prepare(
      `SELECT id FROM tasks WHERE id IN (${THREAD_TASKS}) AND status IN ('queued', 'claimed')`,
    )
    .all(threadId, threadId)
    .map((r) => String(r.id));
  let cancelled = 0;
  for (const id of open) if (cancel(db, id)) cancelled++;
  const ids = new Set(open);
  let stopped = 0;
  for (const run of listActiveRuns(db)) {
    if (!run.taskId || !ids.has(run.taskId)) continue;
    killRun(run.pid, run.pgid, run.startedAt);
    if (finishRun(db, run.id, "cancelled", { error: "stopped by the owner" })) stopped++;
  }
  return { cancelled, stopped };
}
