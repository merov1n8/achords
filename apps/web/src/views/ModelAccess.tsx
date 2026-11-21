import { useState } from "preact/hooks";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { usePoll } from "../poll.ts";
import { SecretInput } from "./SecretInput.tsx";

type Provider = { provider: string; label: string; mode: string; keyId: string; keySet: boolean };

/** Phase 4: each model provider on its subscription login or on an API key. */
export function ModelAccess() {
  const list = usePoll(() => api<Provider[]>("/api/billing"), 30000);
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
        </div>
      ))}
      {error && <p class="error">{error}</p>}
    </>
  );
}
