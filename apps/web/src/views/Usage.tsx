import { useState } from "preact/hooks";
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
type SpendRow = {
  key: string;
  billing: string;
  usd: number;
  unpriced: number;
  inputTokens: number;
  outputTokens: number;
};
type Spend = Record<"today" | "month", Record<"provider" | "agent" | "project", SpendRow[]>>;

const PROVIDER_NAMES: Record<string, string> = {
  "cli-claude": "Claude",
  "cli-codex": "OpenAI",
  "cli-gemini": "Gemini",
  local: "Local model",
};

/** Phase 4: what work cost, by provider, agent and project; API money apart from estimates. */
function SpendTable(props: { rows: SpendRow[]; by: "provider" | "agent" | "project" }) {
  if (!props.rows.length) return <p class="muted small">{t("usage.nothing")}</p>;
  const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return (
    <table>
      <thead>
        <tr>
          <th>{t(`usage.by.${props.by}`)}</th>
          <th>{t("usage.billing")}</th>
          <th>{t("usage.cost")}</th>
          <th>{t("usage.tokens")}</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((r) => (
          <tr key={`${r.key}-${r.billing}`}>
            <td>{props.by === "provider" ? (PROVIDER_NAMES[r.key] ?? r.key) : r.key}</td>
            <td>{r.billing === "api" ? t("access.api") : t("access.subscription")}</td>
            <td>
              ${r.usd.toFixed(2)}
              {r.billing === "subscription" && (
                <span class="muted small"> {t("usage.estimate")}</span>
              )}
              {r.unpriced > 0 && (
                <span class="muted small"> {t("usage.unpriced", { n: r.unpriced })}</span>
              )}
            </td>
            <td class="muted small">
              {tokens(r.inputTokens)} / {tokens(r.outputTokens)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SpendPanel(props: { spend: Spend }) {
  const [period, setPeriod] = useState<"today" | "month">("today");
  const [by, setBy] = useState<"provider" | "agent" | "project">("provider");
  return (
    <div class="panel gap-top">
      <div class="row wrap">
        <h2>{t("usage.spend")}</h2>
        {(["today", "month"] as const).map((p) => (
          <button
            key={p}
            type="button"
            class={`btn ghost ${period === p ? "active" : ""}`}
            onClick={() => setPeriod(p)}
          >
            {t(`budget.${p === "today" ? "day" : "month"}`)}
          </button>
        ))}
        {(["provider", "agent", "project"] as const).map((b) => (
          <button
            key={b}
            type="button"
            class={`btn ghost ${by === b ? "active" : ""}`}
            onClick={() => setBy(b)}
          >
            {t(`usage.by.${b}`)}
          </button>
        ))}
      </div>
      <SpendTable rows={props.spend[period][by]} by={by} />
      <p class="muted small">{t("usage.spendHelp")}</p>
    </div>
  );
}

export function Usage() {
  const usage = usePoll(
    () => api<{ windows: Window[]; spentTodayUsd: number; spend?: Spend }>("/api/usage"),
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
      {usage.data?.spend && <SpendPanel spend={usage.data.spend} />}
      {usage.error && <p class="error">{usage.error}</p>}
    </>
  );
}
