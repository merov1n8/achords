import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { usePoll } from "../poll.ts";
import { describeProgress } from "../progress.ts";

type Live = {
  runId: string;
  agentId: string | null;
  title: string | null;
  startedAt: number;
  done: number | null;
  total: number | null;
  current: string | null;
};

/** Bottom bar: what every agent is doing right now, % done and an estimate of the time left. */
export function LiveBar() {
  const live = usePoll(() => api<Live[]>("/api/runs/live"), 3000);
  if (!live.data?.length) return null;
  return (
    <section class="livebar" aria-label={t("progress.running")} aria-live="polite">
      {live.data.map((r) => {
        const p = describeProgress(r);
        return (
          <div key={r.runId} class="liverun">
            <div class="row">
              <code>{r.agentId}</code>
              <span class="grow">
                {r.title}
                {r.current && <span class="muted"> · {r.current}</span>}
              </span>
              <span class="muted small">
                {r.total
                  ? `${t("progress.steps", { done: r.done ?? 0, total: r.total })} · ${p.percent}% · `
                  : ""}
                {p.elapsed}
                {p.left ? ` · ${t("progress.left", { time: p.left })}` : ""}
              </span>
            </div>
            {/* <progress> keeps the CSP strict: no inline width styles. No value = indeterminate. */}
            {r.total ? <progress max={r.total} value={r.done ?? 0} /> : <progress />}
          </div>
        );
      })}
    </section>
  );
}
