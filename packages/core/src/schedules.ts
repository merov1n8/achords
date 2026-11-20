import { randomUUID } from "node:crypto";
import { nextRun, parseCron } from "./cron.ts";
import type { Db } from "./db/database.ts";

// Scheduler (ADR-0033): what runs when; the gateway tick turns due schedules into tasks.

export interface Schedule {
  id: string;
  seedId: string | null;
  name: string;
  cron: string;
  agentId: string;
  title: string;
  instructions: string;
  project: string | null;
  enabled: boolean;
  nextRunAt: number;
  threadId: string | null;
  lastTaskId: string | null;
  lastRunAt: number | null;
  /** Status of the last task (queued, claimed, done, failed, cancelled), if any. */
  lastStatus: string | null;
}

const toSchedule = (r: Record<string, unknown>): Schedule => ({
  id: r.id as string,
  seedId: r.seed_id as string | null,
  name: r.name as string,
  cron: r.cron as string,
  agentId: r.agent_id as string,
  title: r.title as string,
  instructions: r.instructions as string,
  project: r.project as string | null,
  enabled: Number(r.enabled) === 1,
  nextRunAt: Number(r.next_run_at),
  threadId: r.thread_id as string | null,
  lastTaskId: r.last_task_id as string | null,
  lastRunAt: r.last_run_at === null ? null : Number(r.last_run_at),
  lastStatus: (r.last_status as string | null) ?? null,
});

const SELECT = `SELECT s.*, t.status AS last_status FROM schedules s
  LEFT JOIN tasks t ON t.id = s.last_task_id`;

export interface ScheduleInput {
  name: string;
  cron: string;
  agentId: string;
  title: string;
  instructions: string;
  project?: string | null;
  enabled?: boolean;
  seedId?: string;
}

export function createSchedule(db: Db, input: ScheduleInput, now = Date.now()): Schedule {
  parseCron(input.cron); // throws with the reason
  const id = randomUUID();
  db.prepare(
    `INSERT INTO schedules (id, seed_id, name, cron, agent_id, title, instructions, project, enabled,
       next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.seedId ?? null,
    input.name,
    input.cron,
    input.agentId,
    input.title,
    input.instructions,
    input.project ?? null,
    input.enabled === false ? 0 : 1,
    nextRun(input.cron, now),
    now,
    now,
  );
  return getSchedule(db, id) as Schedule;
}

export function getSchedule(db: Db, id: string): Schedule | undefined {
  const row = db.prepare(`${SELECT} WHERE s.id = ?`).get(id);
  return row ? toSchedule(row) : undefined;
}

export function listSchedules(db: Db): Schedule[] {
  return db.prepare(`${SELECT} ORDER BY s.next_run_at, s.name`).all().map(toSchedule);
}

export function updateSchedule(
  db: Db,
  id: string,
  patch: Partial<Omit<ScheduleInput, "seedId">>,
  now = Date.now(),
): Schedule {
  const cur = getSchedule(db, id);
  if (!cur) throw new Error(`no schedule ${id}`);
  const next = {
    ...cur,
    ...patch,
    project: patch.project === undefined ? cur.project : patch.project,
  };
  parseCron(next.cron);
  db.prepare(
    `UPDATE schedules SET name = ?, cron = ?, agent_id = ?, title = ?, instructions = ?, project = ?,
       enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
  ).run(
    next.name,
    next.cron,
    next.agentId,
    next.title,
    next.instructions,
    next.project,
    next.enabled ? 1 : 0,
    // A changed rule or a re-enabled schedule starts counting from now (no burst of old runs).
    nextRun(next.cron, now),
    now,
    id,
  );
  return getSchedule(db, id) as Schedule;
}

export function deleteSchedule(db: Db, id: string): void {
  db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
}

export function dueSchedules(db: Db, now = Date.now()): Schedule[] {
  return db
    .prepare(`${SELECT} WHERE s.enabled = 1 AND s.next_run_at <= ? ORDER BY s.next_run_at`)
    .all(now)
    .map(toSchedule);
}

/**
 * Records that a schedule fired (or was skipped: no task) and moves it to its next run after
 * `now`, so occurrences missed while the gateway was down are run once, not one by one.
 */
export function markScheduleRun(
  db: Db,
  id: string,
  run: { taskId: string | null; threadId: string | null },
  now = Date.now(),
): void {
  const cur = getSchedule(db, id);
  if (!cur) return;
  db.prepare(
    `UPDATE schedules SET next_run_at = ?, last_task_id = COALESCE(?, last_task_id),
       last_run_at = CASE WHEN ? IS NULL THEN last_run_at ELSE ? END,
       thread_id = COALESCE(?, thread_id), updated_at = ? WHERE id = ?`,
  ).run(nextRun(cur.cron, now), run.taskId, run.taskId, now, run.threadId, now, id);
}

/** Inserts a shipped schedule unless one with this seed id exists (never overwrites edits). */
export function seedSchedule(
  db: Db,
  input: ScheduleInput & { seedId: string },
  now = Date.now(),
): boolean {
  if (db.prepare("SELECT 1 FROM schedules WHERE seed_id = ?").get(input.seedId)) return false;
  createSchedule(db, input, now);
  return true;
}
