import { randomUUID } from "node:crypto";
import type { Db } from "./db/database.ts";

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface Run {
  id: string;
  taskId: string | null;
  agentId: string | null;
  provider: string;
  model: string | null;
  status: RunStatus;
  pid: number | null;
  pgid: number | null;
  startedAt: number;
}

const toRun = (r: Record<string, unknown>): Run => ({
  id: r.id as string,
  taskId: r.task_id as string | null,
  agentId: r.agent_id as string | null,
  provider: r.provider as string,
  model: r.model as string | null,
  status: r.status as RunStatus,
  pid: r.pid === null ? null : Number(r.pid),
  pgid: r.pgid === null ? null : Number(r.pgid),
  startedAt: Number(r.started_at),
});

export function startRun(
  db: Db,
  input: {
    provider: string;
    model?: string;
    taskId?: string;
    agentId?: string;
    pid?: number;
    pgid?: number;
  },
  now = Date.now(),
): Run {
  const row = db
    .prepare(
      `INSERT INTO runs (id, task_id, agent_id, provider, model, pid, pgid, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      randomUUID(),
      input.taskId ?? null,
      input.agentId ?? null,
      input.provider,
      input.model ?? null,
      input.pid ?? null,
      input.pgid ?? null,
      now,
    );
  return toRun(row as Record<string, unknown>);
}

/** Spawned runs lead their own process group, so pgid = pid. */
export function setRunPid(db: Db, id: string, pid: number): void {
  db.prepare("UPDATE runs SET pid = ?, pgid = ? WHERE id = ?").run(pid, pid, id);
}

export function listActiveRuns(db: Db): Run[] {
  return db
    .prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at, rowid")
    .all()
    .map(toRun);
}

/** Returns false if the run had already finished. */
export function finishRun(
  db: Db,
  id: string,
  status: Exclude<RunStatus, "running">,
  info: { exitCode?: number; error?: string },
  now = Date.now(),
): boolean {
  const r = db
    .prepare(
      `UPDATE runs SET status = ?, exit_code = ?, error = ?, ended_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(status, info.exitCode ?? null, info.error ?? null, now, id);
  return r.changes === 1;
}

/** Latest checklist state of a running run (done of total, the step in progress). */
export function setRunProgress(
  db: Db,
  id: string,
  p: { done: number; total: number; current?: string },
  now = Date.now(),
): void {
  db.prepare(
    `UPDATE runs SET progress_done = ?, progress_total = ?, progress_label = ?, progress_at = ?
     WHERE id = ? AND status = 'running'`,
  ).run(p.done, p.total, p.current ?? null, now, id);
}

export interface LiveProgress {
  runId: string;
  taskId: string | null;
  agentId: string | null;
  title: string | null;
  startedAt: number;
  done: number | null;
  total: number | null;
  current: string | null;
  progressAt: number | null;
}

/** What is running right now, with progress, for the web's live bar. */
export function liveProgress(db: Db): LiveProgress[] {
  return db
    .prepare(
      `SELECT r.id, r.task_id, r.agent_id, t.title, r.started_at, r.progress_done,
              r.progress_total, r.progress_label, r.progress_at
       FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
       WHERE r.status = 'running' ORDER BY r.started_at, r.rowid`,
    )
    .all()
    .map((r) => ({
      runId: r.id as string,
      taskId: r.task_id as string | null,
      agentId: r.agent_id as string | null,
      title: r.title as string | null,
      startedAt: Number(r.started_at),
      done: r.progress_done === null ? null : Number(r.progress_done),
      total: r.progress_total === null ? null : Number(r.progress_total),
      current: r.progress_label as string | null,
      progressAt: r.progress_at === null ? null : Number(r.progress_at),
    }));
}
