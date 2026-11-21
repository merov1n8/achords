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

export interface SpendRow {
  key: string;
  billing: string;
  usd: number;
  /** Runs without a known cost (no price for the model): counted in tokens only. */
  unpriced: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Spend since a time, grouped by provider, agent or the task's project (Phase 4). Subscription
 * runs are listed apart: their cost is what the CLI estimates, not money spent.
 */
export function spendBy(db: Db, since: number, by: "provider" | "agent" | "project"): SpendRow[] {
  const key =
    by === "provider"
      ? "r.provider"
      : by === "agent"
        ? "COALESCE(r.agent_id, '-')"
        : "COALESCE(t.project, '-')";
  return db
    .prepare(
      `SELECT ${key} AS key, r.billing AS billing, COALESCE(SUM(r.cost_usd), 0) AS usd,
         SUM(CASE WHEN r.cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
         COALESCE(SUM(r.input_tokens), 0) AS input_tokens, COALESCE(SUM(r.output_tokens), 0) AS output_tokens
       FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
       WHERE r.ended_at >= ? GROUP BY 1, 2 ORDER BY usd DESC`,
    )
    .all(since)
    .map((r) => ({
      key: String(r.key),
      billing: String(r.billing),
      usd: Number(r.usd),
      unpriced: Number(r.unpriced),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
    }));
}

/** API money spent on one provider since a time (budgets). */
export function apiSpendSince(db: Db, provider: string, since: number): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE provider = ? AND billing = 'api' AND ended_at >= ?",
    )
    .get(provider, since);
  return Number(row?.total ?? 0);
}
