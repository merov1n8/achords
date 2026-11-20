import { randomUUID } from "node:crypto";
import type { Db } from "./db/database.ts";

// Heartbeat monitors (ADR-0039): a cheap check every N minutes; the owner hears about a change
// of state (ok → alert, alert → ok), not about every check.

export type MonitorKind = "site" | "stuck" | "integration";
export type MonitorState = "unknown" | "ok" | "alert";

export interface Monitor {
  id: string;
  name: string;
  kind: MonitorKind;
  config: Record<string, unknown>;
  everyMinutes: number;
  enabled: boolean;
  state: MonitorState;
  detail: string | null;
  /** False while a change of state waits to be told (e.g. during quiet hours). */
  notified: boolean;
  nextCheckAt: number;
  lastCheckAt: number | null;
  lastChangeAt: number | null;
  /** Integration monitors: the previous result, to tell what is new. */
  lastResult: string | null;
}

export interface MonitorInput {
  name: string;
  kind: MonitorKind;
  config: Record<string, unknown>;
  everyMinutes: number;
  enabled?: boolean;
}

const toMonitor = (r: Record<string, unknown>): Monitor => ({
  id: r.id as string,
  name: r.name as string,
  kind: r.kind as MonitorKind,
  config: JSON.parse(r.config as string) as Record<string, unknown>,
  everyMinutes: Number(r.every_minutes),
  enabled: Number(r.enabled) === 1,
  state: r.state as MonitorState,
  detail: (r.detail as string | null) ?? null,
  notified: Number(r.notified) === 1,
  nextCheckAt: Number(r.next_check_at),
  lastCheckAt: r.last_check_at === null ? null : Number(r.last_check_at),
  lastChangeAt: r.last_change_at === null ? null : Number(r.last_change_at),
  lastResult: (r.last_result as string | null) ?? null,
});

const MIN_EVERY = 5;

function check(input: Partial<MonitorInput>): void {
  if (input.name !== undefined && !input.name.trim()) throw new Error("name is required");
  if (input.kind !== undefined && !["site", "stuck", "integration"].includes(input.kind)) {
    throw new Error("kind must be site, stuck or integration");
  }
  if (
    input.everyMinutes !== undefined &&
    (!Number.isInteger(input.everyMinutes) || input.everyMinutes < MIN_EVERY)
  ) {
    throw new Error(`every_minutes must be a whole number of at least ${MIN_EVERY}`);
  }
}

export function createMonitor(db: Db, input: MonitorInput, now = Date.now()): Monitor {
  check(input);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO monitors (id, name, kind, config, every_minutes, enabled, next_check_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name.trim(),
    input.kind,
    JSON.stringify(input.config),
    input.everyMinutes,
    input.enabled === false ? 0 : 1,
    now,
    now,
    now,
  );
  return getMonitor(db, id) as Monitor;
}

export function getMonitor(db: Db, id: string): Monitor | undefined {
  const r = db.prepare("SELECT * FROM monitors WHERE id = ?").get(id);
  return r ? toMonitor(r) : undefined;
}

export function listMonitors(db: Db): Monitor[] {
  return db.prepare("SELECT * FROM monitors ORDER BY name").all().map(toMonitor);
}

export function updateMonitor(
  db: Db,
  id: string,
  patch: Partial<MonitorInput>,
  now = Date.now(),
): Monitor {
  const cur = getMonitor(db, id);
  if (!cur) throw new Error("no such monitor");
  check(patch);
  const next = { ...cur, ...patch };
  // A changed check starts fresh: its old state says nothing about the new one.
  const reset = patch.kind !== undefined || patch.config !== undefined;
  db.prepare(
    `UPDATE monitors SET name = ?, kind = ?, config = ?, every_minutes = ?, enabled = ?,
       next_check_at = ?, updated_at = ?${reset ? ", state = 'unknown', detail = NULL, notified = 1" : ""}
     WHERE id = ?`,
  ).run(
    next.name.trim(),
    next.kind,
    JSON.stringify(next.config),
    next.everyMinutes,
    next.enabled ? 1 : 0,
    reset || patch.everyMinutes !== undefined ? now : cur.nextCheckAt,
    now,
    id,
  );
  return getMonitor(db, id) as Monitor;
}

export function deleteMonitor(db: Db, id: string): void {
  db.prepare("DELETE FROM monitors WHERE id = ?").run(id);
}

export function dueMonitors(db: Db, now = Date.now()): Monitor[] {
  return db
    .prepare(
      "SELECT * FROM monitors WHERE enabled = 1 AND next_check_at <= ? ORDER BY next_check_at",
    )
    .all(now)
    .map(toMonitor);
}

/**
 * Stores a check result. Returns the change of state the owner should hear about, if any: the
 * first check only sets the baseline unless it already finds a problem.
 */
export function recordCheck(
  db: Db,
  id: string,
  result: {
    state: "ok" | "alert";
    detail: string;
    /** Integration monitors: the raw result to compare next time. */
    result?: string;
    /** Integration monitors tell news, not changes of state: set means "tell this". */
    news?: boolean;
  },
  now = Date.now(),
): { changed: boolean; from: MonitorState } {
  const cur = getMonitor(db, id);
  if (!cur) throw new Error("no such monitor");
  const changed =
    result.news !== undefined
      ? result.news
      : cur.state === "unknown"
        ? result.state === "alert"
        : cur.state !== result.state;
  // Back where it was before the owner heard of it (e.g. within quiet hours): nothing to tell.
  // News never cancels: each piece is told.
  const cancels = changed && !cur.notified && result.news === undefined;
  db.prepare(
    `UPDATE monitors SET state = ?, detail = ?, last_check_at = ?, next_check_at = ?,
       last_change_at = CASE WHEN ? THEN ? ELSE last_change_at END,
       notified = CASE WHEN ? THEN ? ELSE notified END,
       last_result = COALESCE(?, last_result)
     WHERE id = ?`,
  ).run(
    result.state,
    result.detail,
    now,
    now + cur.everyMinutes * 60_000,
    changed ? 1 : 0,
    now,
    changed ? 1 : 0,
    cancels ? 1 : 0,
    result.result ?? null,
    id,
  );
  return { changed: changed && !cancels, from: cur.state };
}

/** Changes not told yet (quiet hours, or no channel at the time). */
export function unnotifiedMonitors(db: Db): Monitor[] {
  return db.prepare("SELECT * FROM monitors WHERE notified = 0").all().map(toMonitor);
}

export function markNotified(db: Db, id: string): void {
  db.prepare("UPDATE monitors SET notified = 1 WHERE id = ?").run(id);
}
