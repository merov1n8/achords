import { Lock, Trash } from "lucide-preact";
import { useState } from "preact/hooks";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { ago } from "../kanban.ts";
import { usePoll } from "../poll.ts";
import type { SecretStatus } from "../types.ts";

/** Write-only: values can be set or replaced, never shown (ADR-0012). */
export function Vault() {
  const secrets = usePoll(() => api<SecretStatus[]>("/api/vault"), 10000);
  const [id, setId] = useState("");
  const [value, setValue] = useState("");
  const [confirming, setConfirming] = useState<string>();
  const [error, setError] = useState<string>();

  const save = async (e: Event) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api(`/api/vault/${encodeURIComponent(id.trim())}`, { method: "PUT", body: { value } });
      setValue("");
      setId("");
      secrets.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async (secretId: string) => {
    setConfirming(undefined);
    await api(`/api/vault/${encodeURIComponent(secretId)}`, { method: "DELETE" });
    secrets.refresh();
  };

  return (
    <>
      <div class="page-head">
        <h1>{t("nav.vault")}</h1>
      </div>
      <p class="muted">{t("vault.hint")}</p>
      <div class="panel">
        <table>
          <thead>
            <tr>
              <th>{t("vault.secret")}</th>
              <th>{t("vault.value")}</th>
              <th>{t("vault.updated")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {secrets.data?.map((s) => (
              <tr key={s.id}>
                <td>
                  <code>{s.id}</code>
                </td>
                <td class="muted">
                  <Lock class="icon" /> {s.last4 ? `••••${s.last4}` : "••••"}
                </td>
                <td class="muted">{s.updatedAt ? ago(s.updatedAt) : ""}</td>
                <td>
                  {confirming === s.id ? (
                    <>
                      <button type="button" class="btn danger" onClick={() => remove(s.id)}>
                        {t("vault.confirmDelete")}
                      </button>{" "}
                      <button
                        type="button"
                        class="btn ghost"
                        onClick={() => setConfirming(undefined)}
                      >
                        {t("common.cancel")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      class="btn ghost"
                      onClick={() => setConfirming(s.id)}
                      aria-label={t("vault.delete")}
                    >
                      <Trash class="icon" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form class="panel gap-top narrow" onSubmit={save} autocomplete="off">
        <h2>{t("vault.setTitle")}</h2>
        <label class="field">
          {t("vault.id")}
          <input
            class="input"
            value={id}
            onInput={(e) => setId(e.currentTarget.value)}
            placeholder="telegram.bot-token"
            pattern="[a-z0-9][a-z0-9._\-]{0,63}"
            required
          />
        </label>
        <label class="field">
          {t("vault.value")}
          <input
            class="input"
            type="password"
            value={value}
            onInput={(e) => setValue(e.currentTarget.value)}
            autocomplete="new-password"
            required
          />
        </label>
        <button type="submit" class="btn primary">
          {t("common.save")}
        </button>
        {error && <p class="error">{error}</p>}
      </form>
    </>
  );
}
