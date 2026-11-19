import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { usePoll } from "../poll.ts";
import type { Agent } from "../types.ts";

export function Agents() {
  const agents = usePoll(() => api<Agent[]>("/api/agents"), 10000);
  return (
    <>
      <div class="page-head">
        <h1>{t("nav.agents")}</h1>
      </div>
      <div class="panel">
        <table>
          <thead>
            <tr>
              <th>{t("agents.id")}</th>
              <th>{t("agents.name")}</th>
              <th>{t("agents.role")}</th>
              <th>{t("agents.workspace")}</th>
            </tr>
          </thead>
          <tbody>
            {agents.data?.map((a) => (
              <tr key={a.id}>
                <td>
                  <code>{a.id}</code>
                </td>
                <td>{a.name}</td>
                <td>{a.role}</td>
                <td>{a.workspace}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
