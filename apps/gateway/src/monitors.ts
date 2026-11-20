// Heartbeat monitors (ADR-0039): runs due checks from the gateway tick and tells the owner about
// changes of state, outside quiet hours. Checks are cheap: no model, no agent run.
import {
  type Db,
  dueMonitors,
  getSetting,
  type Monitor,
  markNotified,
  recordCheck,
  unnotifiedMonitors,
} from "@achords/core";
import { t } from "@achords/i18n";

export const QUIET_HOURS_KEY = "monitors.quiet_hours";

export interface MonitorDeps {
  db: Db;
  notify: (text: string) => void;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Integration checks (5b), run by the orchestrator: launcher + local-model triage. */
  checkIntegration?: (
    m: Monitor,
  ) => Promise<{ state: "ok" | "alert"; detail: string; result?: string; news: boolean }>;
}

type Result = { state: "ok" | "alert"; detail: string };

async function checkSite(m: Monitor, f: typeof fetch): Promise<Result> {
  const url = String(m.config.url ?? "");
  const started = Date.now();
  try {
    const res = await f(url, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
    const ms = Date.now() - started;
    return res.status < 400
      ? { state: "ok", detail: t("monitor.siteOk", { status: res.status, ms }) }
      : { state: "alert", detail: t("monitor.siteStatus", { url, status: res.status }) };
  } catch (err) {
    return {
      state: "alert",
      detail: t("monitor.siteDown", { url, reason: (err as Error).name }),
    };
  }
}

function checkStuck(m: Monitor, db: Db, now: number): Result {
  const hours = Number(m.config.hours ?? 48);
  const columns = Array.isArray(m.config.columns)
    ? (m.config.columns as string[])
    : ["todo", "in_progress", "review"];
  const rows = db
    .prepare(
      `SELECT title, board_column FROM tasks WHERE board_column IN (${columns.map(() => "?").join(",")})
       AND status NOT IN ('done', 'cancelled') AND updated_at < ? ORDER BY updated_at LIMIT 20`,
    )
    .all(...columns, now - hours * 3_600_000);
  if (!rows.length) return { state: "ok", detail: t("monitor.stuckNone", { hours }) };
  const list = rows.map((r) => `- ${r.title} (${r.board_column})`).join("\n");
  return { state: "alert", detail: t("monitor.stuck", { n: rows.length, hours, list }) };
}

/** "22-7" → is this local hour inside it (ranges may pass midnight). */
export function inQuietHours(spec: string | undefined, hour: number): boolean {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(spec?.trim() ?? "");
  if (!m) return false;
  const [from, to] = [Number(m[1]), Number(m[2])];
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

export async function runMonitors(deps: MonitorDeps): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const f = deps.fetch ?? fetch;
  for (const m of dueMonitors(deps.db, now.getTime())) {
    if (m.kind === "integration") {
      if (!deps.checkIntegration) continue;
      const r = await deps.checkIntegration(m);
      recordCheck(deps.db, m.id, r, now.getTime());
      continue;
    }
    const result =
      m.kind === "site" ? await checkSite(m, f) : checkStuck(m, deps.db, now.getTime());
    recordCheck(deps.db, m.id, result, now.getTime());
  }
  if (inQuietHours(getSetting(deps.db, QUIET_HOURS_KEY), now.getHours())) return;
  for (const m of unnotifiedMonitors(deps.db)) {
    deps.notify(
      t(
        m.kind === "integration"
          ? "monitor.news"
          : m.state === "alert"
            ? "monitor.alert"
            : "monitor.recovered",
        {
          name: m.name,
          detail: m.detail ?? "",
        },
      ),
    );
    markNotified(deps.db, m.id);
  }
}
