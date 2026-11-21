import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { usePoll } from "../poll.ts";
import type { IntegrationStatus } from "../types.ts";
import { Accounts, type Row, toLists, toRows, WordPressConnection } from "./Projects.tsx";
import { SecretInput } from "./SecretInput.tsx";

/** What each integration still needs; secrets are set in the vault, accounts per project. */
function needs(s: IntegrationStatus): string[] {
  const out: string[] = [];
  if (!s.commandFound) out.push(t("integrations.noCommand", { command: s.command ?? "" }));
  if (s.missingSecrets.length) {
    out.push(t("integrations.missingSecrets", { ids: s.missingSecrets.join(", ") }));
  }
  if (s.perProject && !s.projectsReady.length) out.push(t("integrations.noProjectSecrets"));
  if (s.scoped && !s.projectsScoped.length) out.push(t("integrations.noAccounts"));
  return out;
}

/** One read call through the same path agents use; per-client ones run for a chosen project. */
function TestButton(props: { s: IntegrationStatus }) {
  const { s } = props;
  const projects = [...new Set([...s.projectsReady, ...s.projectsScoped])];
  const needsProject = s.perProject || s.scoped;
  const [project, setProject] = useState(projects[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ ok: boolean; text: string }>();
  if (!s.testable) return null;
  const run = async () => {
    setBusy(true);
    setOut(undefined);
    try {
      setOut(
        await api<{ ok: boolean; text: string }>(`/api/integrations/${s.id}/test`, {
          method: "POST",
          body: needsProject ? { project } : {},
        }),
      );
    } catch (err) {
      setOut({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="field">
      <div class="row">
        {needsProject && (
          <select
            class="input small"
            aria-label={t("chats.project")}
            value={project}
            onChange={(e) => setProject(e.currentTarget.value)}
          >
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          class="btn"
          disabled={busy || (needsProject && !project)}
          onClick={run}
        >
          {busy ? t("integrations.testing") : t("integrations.test")}
        </button>
      </div>
      {out && (
        <span class={out.ok ? "muted small" : "error small"}>
          {out.ok ? "✓ " : "✗ "}
          {out.text}
        </span>
      )}
    </div>
  );
}

/** The owner's own accounts (ADR-0042): what work without a client project may use. */
function OwnAccounts(props: { onSaved: () => void }) {
  const [rows, setRows] = useState<Row[]>();
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();
  useEffect(() => {
    api<{ integrations: Record<string, string[]> }>("/api/accounts")
      .then((r) => setRows(toRows(r.integrations)))
      .catch((err: Error) => setStatus({ ok: false, text: err.message }));
  }, []);
  if (!rows) return status ? <p class="error">{status.text}</p> : null;
  const save = async (e: Event) => {
    e.preventDefault();
    try {
      const out = await api<{ integrations: Record<string, string[]> }>("/api/accounts", {
        method: "PUT",
        body: { integrations: toLists(rows) },
      });
      setRows(toRows(out.integrations));
      setStatus({ ok: true, text: t("projects.saved") });
      props.onSaved();
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  };
  return (
    <form class="panel gap-top" onSubmit={save}>
      <h2>{t("integrations.own")}</h2>
      <p class="muted small">{t("integrations.ownHelp")}</p>
      <Accounts rows={rows} onChange={setRows} />
      <WordPressConnection slug="own" />
      <button type="submit" class="btn primary">
        {t("common.save")}
      </button>
      {status && <span class={status.ok ? "muted" : "error"}> {status.text}</span>}
    </form>
  );
}

export function Integrations() {
  const list = usePoll(() => api<IntegrationStatus[]>("/api/integrations"), 30000);
  return (
    <>
      <div class="page-head">
        <h1>{t("nav.integrations")}</h1>
      </div>
      <p class="muted">{t("integrations.help")}</p>
      <div class="panel">
        <table>
          <thead>
            <tr>
              <th>{t("integrations.name")}</th>
              <th>{t("integrations.usedBy")}</th>
              <th>{t("integrations.status")}</th>
              <th>{t("integrations.details")}</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((s) => {
              const missing = needs(s);
              const projects = [...new Set([...s.projectsReady, ...s.projectsScoped])];
              return (
                <tr key={s.id}>
                  <td>
                    {s.name} <code class="muted">{s.id}</code>
                  </td>
                  <td>{s.usedBy.join(", ") || <span class="muted">-</span>}</td>
                  <td>
                    {s.ready ? (
                      <span class="chip done">{t("integrations.ready")}</span>
                    ) : (
                      <span class={`chip ${s.usedBy.length ? "failed" : "todo"}`}>
                        {t("integrations.setup")}
                      </span>
                    )}
                  </td>
                  <td class="small">
                    {missing.map((m) => (
                      <div key={m}>{m}</div>
                    ))}
                    {/* Google comes from the sign-in (achords connect google), not typed values. */}
                    {s.missingSecrets
                      .filter((id) => !id.startsWith("google-"))
                      .map((id) => (
                        <SecretInput
                          key={id}
                          id={id}
                          label={t("integrations.setSecret")}
                          set={false}
                          onSaved={list.refresh}
                        />
                      ))}
                    <TestButton s={s} />
                    {projects.length > 0 && (
                      <div class="muted">
                        {t("integrations.projects", { projects: projects.join(", ") })}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p class="muted small">{t("integrations.hint")}</p>
      <OwnAccounts onSaved={list.refresh} />
      {list.error && <p class="error">{list.error}</p>}
    </>
  );
}
