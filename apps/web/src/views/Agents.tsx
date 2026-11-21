import { Pencil, Plus } from "lucide-preact";
import { useEffect, useId, useState } from "preact/hooks";
import { api } from "../api.ts";
import { Modal } from "../components/Modal.tsx";
import { t } from "../i18n.ts";
import { usePoll } from "../poll.ts";
import type { Agent } from "../types.ts";

type Models = { default: string; allowed: string[] };
type AgentDetail = { id: string; name: string; models: Models; suggestions: string[] };

export function Agents() {
  const agents = usePoll(() => api<Agent[]>("/api/agents"), 10000);
  const [editing, setEditing] = useState<string>();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <div class="page-head">
        <h1>{t("nav.agents")}</h1>
        <button type="button" class="btn primary" onClick={() => setCreating(true)}>
          <Plus class="icon" />
          {t("agents.new")}
        </button>
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
                <td class="actions">
                  <button
                    type="button"
                    class="iconbtn"
                    aria-label={t("common.edit")}
                    title={t("common.edit")}
                    onClick={() => setEditing(a.id)}
                  >
                    <Pencil class="icon" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <ModelEditor
          key={editing}
          id={editing}
          onClose={() => setEditing(undefined)}
          onChanged={agents.refresh}
        />
      )}
      {creating && (
        <NewAgentForm
          agents={agents.data ?? []}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            agents.refresh();
            setEditing(id);
          }}
        />
      )}
    </>
  );
}

function ModelEditor({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<AgentDetail>();
  const [models, setModels] = useState<Models>();
  const [custom, setCustom] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();

  useEffect(() => {
    api<AgentDetail>(`/api/agents/${id}`)
      .then((d) => {
        setDetail(d);
        setModels(d.models);
        setName(d.name);
      })
      .catch((err: Error) => setStatus({ ok: false, text: err.message }));
  }, [id]);

  if (!detail || !models) {
    return (
      <Modal title={t("agents.settingsOf", { agent: id })} onClose={onClose}>
        <p class={status ? "error" : "muted"}>{status?.text ?? t("app.loading")}</p>
      </Modal>
    );
  }

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
      if (name.trim() !== detail.name) {
        await api(`/api/agents/${id}/name`, { method: "PUT", body: { name } });
        setDetail({ ...detail, name: name.trim() });
        onChanged();
      }
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
    <Modal
      title={t("agents.settingsOf", { agent: id })}
      onClose={onClose}
      footer={
        <>
          {status && <span class={`grow ${status.ok ? "muted" : "error"}`}>{status.text}</span>}
          <button type="button" class="btn ghost" onClick={onClose}>
            {t("common.close")}
          </button>
          <button type="button" class="btn primary" onClick={save}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <label class="field">
        {t("agents.name")}
        <input class="input" value={name} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
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
    </Modal>
  );
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** New persistent agent: every permission starts off and is switched on one by one. */
function NewAgentForm({
  agents,
  onClose,
  onCreated,
}: {
  agents: Agent[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [opts, setOpts] = useState<{ tools: string[]; models: string[] }>();
  const [f, setF] = useState({
    id: "",
    name: "",
    role: "",
    workspace: "",
    roles: "",
    description: "",
    model: "cli-claude/sonnet",
    tools: [] as string[],
    write: "",
    read: "",
    shell: "",
    network: "",
    acceptsFrom: [] as string[],
    delegatesTo: [] as string[],
    budget: "",
  });
  const [error, setError] = useState<string>();
  const formId = useId();
  useEffect(() => {
    api<{ tools: string[]; models: string[] }>("/api/agent-options")
      .then(setOpts)
      .catch((err: Error) => setError(err.message));
  }, []);
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  const workspaces = [...new Set(agents.map((a) => a.workspace))];
  const text = (key: keyof typeof f, label: string, help?: string) => (
    <label class="field">
      {label}
      <input
        class="input"
        value={f[key] as string}
        onInput={(e) => set({ [key]: e.currentTarget.value })}
      />
      {help && <span class="muted small">{help}</span>}
    </label>
  );
  const area = (key: keyof typeof f, label: string, help: string) => (
    <label class="field">
      {label}
      <textarea
        class="input mono"
        rows={2}
        value={f[key] as string}
        onInput={(e) => set({ [key]: e.currentTarget.value })}
      />
      <span class="muted small">{help}</span>
    </label>
  );

  const submit = async (e: Event) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api("/api/agents", {
        method: "POST",
        body: {
          id: f.id.trim(),
          name: f.name,
          role: f.role,
          workspace: f.workspace,
          roles: f.roles
            .split(",")
            .map((r) => r.trim())
            .filter(Boolean),
          description: f.description,
          models: { default: f.model, allowed: [f.model] },
          tools: f.tools,
          fs: { write: lines(f.write), read: lines(f.read) },
          ...(f.tools.includes("Bash") ? { shell: { allow: lines(f.shell) } } : {}),
          network: { allow: lines(f.network) },
          delegation: { can_delegate_to: f.delegatesTo, accepts_from: f.acceptsFrom },
          ...(Number(f.budget) > 0 ? { budget: { per_run_usd: Number(f.budget) } } : {}),
        },
      });
      onCreated(f.id.trim());
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal
      wide
      title={t("agents.new")}
      onClose={onClose}
      footer={
        <>
          <button type="button" class="btn ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" form={formId} class="btn primary">
            {t("agents.form.create")}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        {text("id", t("agents.form.id"), t("agents.form.idHelp"))}
        {text("name", t("agents.name"))}
        {text("role", t("agents.form.role"), t("agents.form.roleHelp"))}
        <label class="field">
          {t("agents.workspace")}
          <input
            class="input"
            list="workspaces"
            value={f.workspace}
            onInput={(e) => set({ workspace: e.currentTarget.value })}
          />
          <datalist id="workspaces">
            {workspaces.map((w) => (
              <option key={w} value={w} />
            ))}
          </datalist>
        </label>
        <label class="field">
          {t("agents.form.description")}
          <textarea
            class="input"
            rows={3}
            value={f.description}
            onInput={(e) => set({ description: e.currentTarget.value })}
          />
          <span class="muted small">{t("agents.form.descriptionHelp")}</span>
        </label>
        {text("roles", t("agents.form.roles"), t("agents.form.rolesHelp"))}
        <label class="field">
          {t("agents.form.model")}
          <select
            class="input"
            value={f.model}
            onChange={(e) => set({ model: e.currentTarget.value })}
          >
            {(opts?.models ?? [f.model]).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <h3 class="sec">{t("agents.form.permissions")}</h3>
        <p class="muted">{t("agents.form.permissionsHelp")}</p>
        <div class="field">
          {t("agents.form.tools")}
          <div class="row wrap">
            {(opts?.tools ?? []).map((tool) => (
              <label key={tool} class="row">
                <input
                  type="checkbox"
                  checked={f.tools.includes(tool)}
                  onChange={() => set({ tools: toggle(f.tools, tool) })}
                />
                <code>{tool}</code>
              </label>
            ))}
          </div>
        </div>
        {area("write", t("agents.form.write"), t("agents.form.pathsHelp"))}
        {area("read", t("agents.form.read"), t("agents.form.pathsHelp"))}
        {f.tools.includes("Bash") &&
          area("shell", t("agents.form.shell"), t("agents.form.shellHelp"))}
        {area("network", t("agents.form.network"), t("agents.form.networkHelp"))}
        <div class="field">
          {t("agents.form.acceptsFrom")}
          <div class="row wrap">
            {agents.map((a) => (
              <label key={a.id} class="row">
                <input
                  type="checkbox"
                  checked={f.acceptsFrom.includes(a.id)}
                  onChange={() => set({ acceptsFrom: toggle(f.acceptsFrom, a.id) })}
                />
                <code>{a.id}</code>
              </label>
            ))}
          </div>
        </div>
        <div class="field">
          {t("agents.form.delegatesTo")}
          <div class="row wrap">
            {agents.map((a) => (
              <label key={a.id} class="row">
                <input
                  type="checkbox"
                  checked={f.delegatesTo.includes(a.id)}
                  onChange={() => set({ delegatesTo: toggle(f.delegatesTo, a.id) })}
                />
                <code>{a.id}</code>
              </label>
            ))}
          </div>
        </div>
        {text("budget", t("agents.form.budget"), t("agents.form.budgetHelp"))}
        {error && <p class="error">{error}</p>}
      </form>
    </Modal>
  );
}
