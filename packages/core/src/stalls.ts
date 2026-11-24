// Stall watcher (ADR-0066 part 1): root chains that make no progress, or have spent most of
// their budget. Pure database checks on the gateway tick; the notice itself is the boss's.
import type { Db } from "./db/database.ts";
import { getSetting } from "./settings.ts";

export const STALL_MINUTES_KEY = "stalls.minutes";
export const STALL_PERCENT_KEY = "stalls.percent";

export function stallSettings(db: Db): { minutes: number; percent: number } {
  const num = (key: string, fallback: number) => {
    const v = Number(getSetting(db, key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return { minutes: num(STALL_MINUTES_KEY, 15), percent: num(STALL_PERCENT_KEY, 80) };
}

export type StallReason = "idle" | "spend";

export interface Stall {
  rootId: string;
  threadId: string | null;
  reason: StallReason;
  /** The chain's latest progress and what it was. */
  lastAt: number;
  lastWhat: string;
  budgetUsd: number | null;
  spentUsd: number;
}

const CHAIN = "(SELECT id FROM tasks WHERE id = ? OR root_id = ?)";

/**
 * The chain's latest progress: a run started or ended or reported, a message or move was posted,
 * a task of it was created or finished. Lease renewal (tasks.updated_at of a claimed task) is not
 * progress; a finished task's updated_at is its finish. The boss's own posts are not the chain's.
 */
export function chainProgress(db: Db, rootId: string): { at: number; what: string } {
  const row = db
    .prepare(
      `SELECT at, what FROM (
         SELECT started_at AS at, 'run started' AS what FROM runs WHERE task_id IN ${CHAIN}
         UNION ALL SELECT ended_at, 'run ended' FROM runs WHERE task_id IN ${CHAIN}
         UNION ALL SELECT progress_at, 'checklist update' FROM runs WHERE task_id IN ${CHAIN}
         UNION ALL SELECT created_at, 'card move' FROM task_moves WHERE task_id IN ${CHAIN}
         UNION ALL SELECT created_at, 'task created' FROM tasks WHERE id IN ${CHAIN}
         UNION ALL SELECT updated_at, 'task finished' FROM tasks WHERE id IN ${CHAIN}
           AND status IN ('done', 'failed', 'cancelled')
         UNION ALL SELECT m.created_at, 'message' FROM messages m
           WHERE m.thread_id = (SELECT thread_id FROM tasks WHERE id = ?)
             AND (m.role = 'user' OR COALESCE(m.author, '') NOT IN ('boss', 'system'))
       ) WHERE at IS NOT NULL ORDER BY at DESC LIMIT 1`,
    )
    .get(...Array<string>(13).fill(rootId));
  return { at: Number(row?.at ?? 0), what: String(row?.what ?? "none") };
}

/**
 * Chains to notice now. Skipped: finished chains, parked cards, chains waiting on the owner, and
 * chains with a task the worker can claim (they wait for the single worker, not stalled).
 * `activity` adds what only the gateway knows in memory: claims and stream events.
 */
export function findStalls(
  db: Db,
  opts: {
    now: number;
    minutes: number;
    percent: number;
    activity?: (rootId: string) => number | undefined;
  },
): Stall[] {
  const roots = db
    .prepare(
      `SELECT r.id, r.thread_id, r.budget_usd, r.spent_usd, r.stall_noticed_at, r.stall_reason
       FROM tasks r WHERE r.root_id IS NULL
         AND EXISTS (SELECT 1 FROM tasks t WHERE (t.id = r.id OR t.root_id = r.id)
           AND t.status IN ('queued', 'claimed') AND t.parked = 0)
         AND NOT EXISTS (SELECT 1 FROM tasks t WHERE (t.id = r.id OR t.root_id = r.id)
           AND t.status = 'queued' AND t.waiting_owner = 1)
         AND NOT EXISTS (SELECT 1 FROM tasks p WHERE (p.id = r.id OR p.root_id = r.id)
           AND p.status = 'queued' AND p.waiting_owner = 0 AND p.waiting_parent = 0
           AND p.parked = 0 AND (p.not_before IS NULL OR p.not_before <= ?)
           AND (p.waiting_children = 0 OR EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = p.id
             AND c.waiting_parent = 1 AND c.status = 'queued')))`,
    )
    .all(opts.now);
  const out: Stall[] = [];
  for (const r of roots) {
    const rootId = String(r.id);
    const budget = r.budget_usd === null ? null : Number(r.budget_usd);
    const spent = Number(r.spent_usd);
    const noticed = r.stall_noticed_at === null ? null : Number(r.stall_noticed_at);
    let last = chainProgress(db, rootId);
    const mem = opts.activity?.(rootId);
    if (mem !== undefined && mem > last.at) last = { at: mem, what: "agent activity" };
    const base = {
      rootId,
      threadId: (r.thread_id as string | null) ?? null,
      lastAt: last.at,
      lastWhat: last.what,
      budgetUsd: budget,
      spentUsd: spent,
    };
    if (
      budget !== null &&
      budget > 0 &&
      spent >= (budget * opts.percent) / 100 &&
      r.stall_reason !== "spend"
    ) {
      out.push({ ...base, reason: "spend" });
    } else if (
      opts.now - last.at >= opts.minutes * 60_000 &&
      (noticed === null || last.at > noticed)
    ) {
      out.push({ ...base, reason: "idle" });
    }
  }
  return out;
}

export function markStallNoticed(db: Db, rootId: string, reason: StallReason, now = Date.now()) {
  db.prepare(
    `UPDATE tasks SET stall_noticed_at = ?,
       stall_reason = CASE WHEN stall_reason = 'spend' THEN 'spend' ELSE ? END WHERE id = ?`,
  ).run(now, reason, rootId);
}

/** The chain as the boss reads it in a notice: every task, its agent and state. */
export function chainTasks(
  db: Db,
  rootId: string,
): { id: string; title: string; agent: string | null; state: string }[] {
  return db
    .prepare(
      `SELECT id, title, assignee_agent_id, status, waiting_children, waiting_owner,
         waiting_parent, not_before FROM tasks WHERE id = ? OR root_id = ? ORDER BY created_at, rowid`,
    )
    .all(rootId, rootId)
    .map((r) => {
      const waits = [
        Number(r.waiting_children) > 0 ? `waiting for ${r.waiting_children} child task(s)` : "",
        Number(r.waiting_owner) === 1 ? "waiting for the owner" : "",
        Number(r.waiting_parent) > 0 ? "asked its parent, no answer yet" : "",
        Number(r.not_before ?? 0) > Date.now() ? "deferred" : "",
      ].filter(Boolean);
      return {
        id: String(r.id),
        title: String(r.title),
        agent: (r.assignee_agent_id as string | null) ?? null,
        state: r.status === "queued" && waits.length ? waits.join(", ") : String(r.status),
      };
    });
}
