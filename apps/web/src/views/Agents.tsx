import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { usePoll } from "../poll.ts";
import type { Agent } from "../types.ts";

type Models = { default: string; allowed: string[] };
type AgentDetail = { id: string; models: Models; suggestions: string[] };

export function Agents() {
  const agents = usePoll(() => api<Agent[]>("/api/agents"), 10000);
  const [editing, setEditing] = useState<string>();
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
              <th />
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
                <td>
                  <button type="button" class="btn ghost" onClick={() => setEditing(a.id)}>
                    {t("agents.models")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <ModelEditor key={editing} id={editing} onClose={() => setEditing(undefined)} />}
    </>
  );
}

function ModelEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const [detail, setDetail] = useState<AgentDetail>();
  const [models, setModels] = useState<Models>();
  const [custom, setCustom] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();

  useEffect(() => {
    api<AgentDetail>(`/api/agents/${id}`)
      .then((d) => {
        setDetail(d);
        setModels(d.models);
      })
      .catch((err: Error) => setStatus({ ok: false, text: err.message }));
  }, [id]);

  if (!detail || !models) return status ? <p class="error">{status.text}</p> : null;

  // Everything the owner can pick: the agent's current models, aliases and pulled local models.
  const options = [...new Set([...models.allowed, models.default, ...detail.suggestions])];
  const toggle = (m: string) => {
    const allowed = models.allowed.includes(m)
      ? models.allowed.filter((x) => x !== m)
      : [...models.allowed, m];
    setModels({ ...models, allowed });
  };
  const addCustom = (e: Event) => {
    e.preventDefault();
    const m = custom.trim();
    if (m && !models.allowed.includes(m)) setModels({ ...models, allowed: [...models.allowed, m] });
    setCustom("");
  };
  const save = async () => {
    setStatus(undefined);
    try {
      const out = await api<{ models: Models }>(`/api/agents/${id}/models`, {
        method: "PUT",
        body: models,
      });
      setModels(out.models);
      setStatus({ ok: true, text: t("agents.saved") });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  };

  return (
    <div class="panel gap-top narrow">
      <div class="page-head">
        <h2>{t("agents.modelsOf", { agent: id })}</h2>
        <button type="button" class="btn ghost" onClick={onClose}>
          {t("common.close")}
        </button>
      </div>
      <p class="muted">{t("agents.allowedHelp")}</p>
      <div class="model-list">
        {options.map((m) => (
          <label key={m} class="model">
            <input
              type="checkbox"
              checked={models.allowed.includes(m)}
              onChange={() => toggle(m)}
            />
            <code>{m}</code>
            <input
              type="radio"
              name="default"
              title={t("agents.default")}
              checked={models.default === m}
              disabled={!models.allowed.includes(m)}
              onChange={() => setModels({ ...models, default: m })}
            />
            <span>
              {models.default === m && <span class="chip progress">{t("agents.default")}</span>}
            </span>
          </label>
        ))}
      </div>
      <form class="composer" onSubmit={addCustom}>
        <input
          class="input mono"
          placeholder="provider/model"
          value={custom}
          onInput={(e) => setCustom((e.target as HTMLInputElement).value)}
        />
        <button type="submit" class="btn">
          {t("agents.add")}
        </button>
      </form>
      <div class="gap-top">
        <button type="button" class="btn primary" onClick={save}>
          {t("common.save")}
        </button>
        {status && <span class={status.ok ? "muted" : "error"}> {status.text}</span>}
      </div>
    </div>
  );
}
