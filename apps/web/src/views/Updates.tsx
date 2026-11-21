import { useState } from "preact/hooks";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { ago } from "../kanban.ts";
import { usePoll } from "../poll.ts";

type Status = {
  auto: boolean;
  service: boolean;
  current: string;
  check: { at: number; status: string; reason?: string; summary?: string } | null;
  ready: { sha: string; summary: string } | null;
  last: { at: number; ok: boolean; text: string } | null;
};

/** Auto-update from main: on by default, applied when nothing is running. */
export function Updates() {
  const status = usePoll(() => api<Status>("/api/update"), 15000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const s = status.data;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      status.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const describe = (c: NonNullable<Status["check"]>) =>
    c.status === "current"
      ? t("updates.current")
      : c.status === "available"
        ? t("updates.available")
        : (c.reason ?? c.status);
  return (
    <>
      <div class="page-head">
        <h1>{t("nav.updates")}</h1>
      </div>
      <p class="muted">{t("updates.help")}</p>
      {s && (
        <div class="panel narrow">
          <label class="row">
            <input
              type="checkbox"
              checked={s.auto}
              disabled={busy}
              onChange={() =>
                act(() => api("/api/update", { method: "PUT", body: { auto: !s.auto } }))
              }
            />
            {t("updates.auto")}
          </label>
          <p>
            {t("updates.running")} <code>{s.current}</code>
          </p>
          {s.check && (
            <p class="muted small">
              {t("updates.lastCheck", { when: ago(s.check.at) })}: {describe(s.check)}
            </p>
          )}
          {s.ready && <p class="small">{t("updates.waiting", { sha: s.ready.sha.slice(0, 7) })}</p>}
          {s.last && (
            <p class={s.last.ok ? "small" : "error small"}>
              {ago(s.last.at)}: {s.last.text}
            </p>
          )}
          {!s.service && <p class="muted small">{t("updates.notService")}</p>}
          <button
            type="button"
            class="btn"
            disabled={busy || !s.service}
            onClick={() => act(() => api("/api/update/check", { method: "POST" }))}
          >
            {busy ? t("updates.checking") : t("updates.checkNow")}
          </button>
          {error && <p class="error">{error}</p>}
        </div>
      )}
    </>
  );
}
