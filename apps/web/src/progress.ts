import { t } from "./i18n.ts";
import { ago } from "./kanban.ts";

/**
 * % from the agent's own checklist; time left extrapolated from the elapsed time, shown only
 * once a step is done (before that there is nothing to extrapolate from).
 */
export function describeProgress(
  p: { startedAt: number; done: number | null; total: number | null },
  now = Date.now(),
): { percent: number | null; elapsed: string; left: string | null } {
  const elapsed = ago(p.startedAt, now);
  if (!p.total || p.done === null) return { percent: null, elapsed, left: null };
  const percent = Math.round((p.done / p.total) * 100);
  if (p.done === 0 || p.done >= p.total) return { percent, elapsed, left: null };
  const leftMs = ((now - p.startedAt) * (p.total - p.done)) / p.done;
  const minutes = Math.round(leftMs / 60_000);
  return {
    percent,
    elapsed,
    left: minutes < 1 ? t("progress.lessThanMinute") : t("progress.minutesLeft", { n: minutes }),
  };
}
