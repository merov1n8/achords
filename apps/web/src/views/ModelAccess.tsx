import { useState } from "preact/hooks";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { usePoll } from "../poll.ts";
import { SecretInput } from "./SecretInput.tsx";

type Provider = { provider: string; label: string; mode: string; keyId: string; keySet: boolean };
type Budget = { day: number; month: number; spentDay: number; spentMonth: number };

/** API budget of one provider: warn at 80%, new work waits at 100% (Phase 4). */
function BudgetForm(props: { provider: string; budget: Budget | undefined; onSaved: () => void }) {
  const b = props.budget;
  const [day, setDay] = useState(String(b?.day ?? 0));
  const [month, setMonth] = useState(String(b?.month ?? 0));
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();
  const save = async (e: Event) => {
    e.preventDefault();
    try {
      await api(`/api/budgets/${props.provider}`, {
        method: "PUT",
        body: { day: Number(day), month: Number(month) },
      });
      setStatus({ ok: true, text: t("projects.saved") });
      props.onSaved();
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  };
  return (
    <form class="field" onSubmit={save}>
      {t("access.budget")}
      <div class="row wrap">
        <label class="row small">
          {t("access.budgetDay")}
          <input
            class="input small"
            inputMode="decimal"
            value={day}
            onInput={(e) => setDay(e.currentTarget.value)}
          />
        </label>
        <label class="row small">
          {t("access.budgetMonth")}
          <input
            class="input small"
            inputMode="decimal"
            value={month}
            onInput={(e) => setMonth(e.currentTarget.value)}
          />
        </label>
        <button type="submit" class="btn">
          {t("common.save")}
        </button>
      </div>
      {b && (
        <span class="muted small">
          {t("access.spent", { day: b.spentDay.toFixed(2), month: b.spentMonth.toFixed(2) })}
        </span>
      )}
      {status && <span class={status.ok ? "muted small" : "error small"}>{status.text}</span>}
    </form>
  );
}

/** Phase 4: each model provider on its subscription login or on an API key. */
export function ModelAccess() {
  const list = usePoll(() => api<Provider[]>("/api/billing"), 30000);
  const budgets = usePoll(() => api<Record<string, Budget>>("/api/budgets"), 30000);
  const [error, setError] = useState<string>();
  const setMode = async (p: Provider, mode: string) => {
    setError(undefined);
    try {
      await api(`/api/billing/${p.provider}`, { method: "PUT", body: { mode } });
      list.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <>
      <div class="page-head">
        <h1>{t("nav.modelAccess")}</h1>
      </div>
      <p class="muted">{t("access.help")}</p>
      {list.data?.map((p) => (
        <div key={p.provider} class="panel gap-top narrow">
          <h2>{p.label}</h2>
          <div class="row wrap">
            {(["subscription", "api"] as const).map((m) => (
              <label key={m} class="row">
                <input
                  type="radio"
                  name={`mode-${p.provider}`}
                  checked={p.mode === m}
                  onChange={() => setMode(p, m)}
                />
                {t(`access.${m}`)}
              </label>
            ))}
          </div>
          {p.mode === "api" && !p.keySet && <p class="error small">{t("access.keyMissing")}</p>}
          <SecretInput id={p.keyId} label={t("access.key")} set={p.keySet} onSaved={list.refresh} />
          {budgets.data && (
            <BudgetForm
              key={`${p.provider}-${budgets.data[p.provider]?.day}-${budgets.data[p.provider]?.month}`}
              provider={p.provider}
              budget={budgets.data[p.provider]}
              onSaved={budgets.refresh}
            />
          )}
        </div>
      ))}
      {error && <p class="error">{error}</p>}
    </>
  );
}
