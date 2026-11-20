import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { ago } from "../kanban.ts";
import { usePoll } from "../poll.ts";

type Window = {
  provider: string;
  kind: string;
  utilization: number;
  resetsAt: number;
  status: string;
  updatedAt: number;
};

const windowLabel = (kind: string) => {
  const key = `usage.window.${kind}`;
  return t(key) === key ? kind : t(key);
};

/** Quota windows per provider, as the CLI reports them with every run (there is nothing to poll). */
export function Usage() {
  const usage = usePoll(
    () => api<{ windows: Window[]; spentTodayUsd: number }>("/api/usage"),
    15000,
  );
  const windows = usage.data?.windows ?? [];
  return (
    <>
      <div class="page-head">
        <h1>{t("nav.usage")}</h1>
      </div>
      <p class="muted">{t("usage.help")}</p>
      <div class="panel">
        {windows.length === 0 ? (
          <p class="muted">{t("usage.empty")}</p>
        ) : (
          <div class="meters">
            {windows.map((w) => {
              const minutes = Math.max(0, Math.round((w.resetsAt - Date.now()) / 60_000));
              return (
                <div key={`${w.provider}-${w.kind}`} class="meter-row">
                  <div class="row">
                    <strong class="grow">
                      {w.provider} · {windowLabel(w.kind)}
                    </strong>
                    <span>{Math.round(w.utilization * 100)}%</span>
                  </div>
                  {/* <meter> turns amber/red by itself at the warning levels; no inline styles. */}
                  <meter min={0} max={1} low={0.8} high={0.95} optimum={0} value={w.utilization} />
                  <div class="muted small">
                    {t("usage.resetsIn", { h: Math.floor(minutes / 60), m: minutes % 60 })} ·{" "}
                    {t("usage.updated", { ago: ago(w.updatedAt) })}
                    {w.status !== "allowed" && (
                      // "allowed_warning" is a heads-up (amber); anything else means refused (red).
                      <span class={`chip ${w.status.includes("warning") ? "local" : "failed"}`}>
                        {" "}
                        {w.status}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <p class="muted gap-top">
        {t("usage.spentToday", { usd: (usage.data?.spentTodayUsd ?? 0).toFixed(2) })}
      </p>
      {usage.error && <p class="error">{usage.error}</p>}
    </>
  );
}
