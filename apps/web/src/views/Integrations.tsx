import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { usePoll } from "../poll.ts";
import type { IntegrationStatus } from "../types.ts";
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
      {list.error && <p class="error">{list.error}</p>}
    </>
  );
}
