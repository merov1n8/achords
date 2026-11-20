import { type Db, transaction } from "./db/database.ts";

export interface UsageWindowRow {
  provider: string;
  kind: string;
  utilization: number;
  resetsAt: number;
  status: string;
  updatedAt: number;
}

/** Upserts the windows a run reported; a run without window info changes nothing. */
export function recordUsageWindows(
  db: Db,
  provider: string,
  windows: { kind: string; utilization: number; resetsAt: number; status: string }[],
  now = Date.now(),
): void {
  if (windows.length === 0) return;
  transaction(db, () => {
    const upsert = db.prepare(
      `INSERT INTO usage_windows (provider, kind, utilization, resets_at, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, kind) DO UPDATE SET utilization = excluded.utilization,
         resets_at = excluded.resets_at, status = excluded.status, updated_at = excluded.updated_at`,
    );
    for (const w of windows) upsert.run(provider, w.kind, w.utilization, w.resetsAt, w.status, now);
  });
}

export function listUsageWindows(db: Db): UsageWindowRow[] {
  return db
    .prepare("SELECT * FROM usage_windows ORDER BY provider, kind")
    .all()
    .map((r) => ({
      provider: r.provider as string,
      kind: r.kind as string,
      utilization: Number(r.utilization),
      resetsAt: Number(r.resets_at),
      status: r.status as string,
      updatedAt: Number(r.updated_at),
    }));
}

/** Total cost of runs that ended at or after `since` (subscription runs report an equivalent). */
export function spendSince(db: Db, since: number): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE ended_at >= ?")
    .get(since);
  return Number(row?.total ?? 0);
}
