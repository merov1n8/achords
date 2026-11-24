import { Pencil, Plus, Trash2 } from "lucide-preact";
import { useEffect, useId, useState } from "preact/hooks";
import { api } from "../api.ts";
import { Modal } from "../components/Modal.tsx";
import { t } from "../i18n.ts";
import {
  type EffectiveRow,
  LEVELS,
  levelLabel,
  type Override,
  overrideProblem,
  parseSkills,
  reasonText,
} from "../levels.ts";
import { usePoll } from "../poll.ts";
import type { Agent } from "../types.ts";

type Models = { default: string; allowed: string[] };
/** GET /api/agents/:id: the same fields as the create form, for editing. */
type AgentDetail = {
  id: string;
  name: string;
  role: string;
  workspace: string;
  roles: string[];
  effort?: string;
  models: Models;
  tools: string[];
  fs: { read: string[]; write: string[] };
  shell?: { allow: string[] };
  network: { allow: string[] };
  /** Only with "*" in network.allow (ADR-0051). */
  container?: boolean;
  delegation: { can_delegate_to: string[]; accepts_from: string[] };
  budget?: { per_run_usd: number };
  doc: string;
  mcp: string[];
  /** ADR-0067: only on agents with a level. */
  level?: number;
  unsandboxed?: string[];
  keys_beside_host_shell?: boolean;
  overrides?: Override[];
  effectiveLevels?: EffectiveRow[];
  conflicts?: string[];
};
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
                  <div class="agent-name">{a.name}</div>
                  <div class="muted small">@{a.id}</div>
                </td>
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
      {(editing || creating) && (
        <AgentForm
          key={editing ?? "new"}
          {...(editing ? { id: editing } : {})}
          agents={agents.data ?? []}
          onClose={() => {
            setCreating(false);
            setEditing(undefined);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(undefined);
            agents.refresh();
          }}
        />
      )}
    </>
  );
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * Create or edit an agent with one form. New agents start at level 1 (ADR-0067); editing loads
 * the same fields (fields the form does not show, like integrations, stay as they are). Agents
 * without a level keep the old per-agent lists until `achords levels migrate`.
 */
function AgentForm({
  id,
  agents,
  onClose,
  onSaved,
}: {
  id?: string;
  agents: Agent[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [opts, setOpts] = useState<{ tools: string[]; models: string[]; roles: string[] }>();
  const [newRole, setNewRole] = useState("");
  const [f, setF] = useState({
    id: "",
    name: "",
    role: "",
    workspace: "",
    roles: [] as string[],
    effort: "",
    description: "",
    models: { default: "cli-claude/sonnet", allowed: ["cli-claude/sonnet"] } as Models,
    /** null: an agent without a level (old per-agent lists). */
    level: 1 as number | null,
    tools: [] as string[],
    write: "",
    read: "",
    shell: "",
    network: "",
    container: true,
    acceptsFrom: [] as string[],
    delegatesTo: [] as string[],
    budget: "",
  });
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(!id);
  const [info, setInfo] = useState<AgentDetail>();
  const [custom, setCustom] = useState("");
  const formId = useId();
  useEffect(() => {
    api<{ tools: string[]; models: string[]; roles: string[] }>("/api/agent-options")
      .then(setOpts)
      .catch((err: Error) => setError(err.message));
    if (!id) return;
    api<AgentDetail>(`/api/agents/${id}`)
      .then((d) => {
        setInfo(d);
        setF({
          id: d.id,
          name: d.name,
          role: d.role,
          workspace: d.workspace,
          roles: d.roles,
          effort: d.effort ?? "",
          description: d.doc,
          models: { default: d.models.default, allowed: d.models.allowed ?? [d.models.default] },
          level: d.level ?? null,
          tools: d.tools,
          write: d.fs.write.join("\n"),
          read: d.fs.read.join("\n"),
          shell: d.shell?.allow.join("\n") ?? "",
          network: d.network.allow.join("\n"),
          container: d.container ?? true,
          acceptsFrom: d.delegation.accepts_from,
          delegatesTo: d.delegation.can_delegate_to,
          budget: d.budget ? String(d.budget.per_run_usd) : "",
        });
        setLoaded(true);
      })
      .catch((err: Error) => setError(err.message));
  }, [id]);
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const leveled = f.level !== null;
  // After an override change: the effective levels change, the form's own edits stay.
  const reloadInfo = () => {
    if (!id) return;
    api<AgentDetail>(`/api/agents/${id}`)
      .then((d) => setInfo(d))
      .catch((err: Error) => setError(err.message));
  };
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
      const form = {
        name: f.name,
        role: f.role,
        workspace: f.workspace,
        roles: f.roles,
        ...(f.effort ? { effort: f.effort } : {}),
        models: f.models,
        fs: { write: lines(f.write), read: lines(f.read) },
        // ADR-0067: the level replaces the tool, shell, network and container lists.
        ...(f.level !== null
          ? { level: f.level }
          : {
              tools: f.tools,
              ...(f.tools.includes("Bash") ? { shell: { allow: lines(f.shell) } } : {}),
              network: { allow: lines(f.network) },
              ...(lines(f.network).includes("*") || f.tools.includes("Bash")
                ? { container: f.container }
                : {}),
            }),
        delegation: { can_delegate_to: f.delegatesTo, accepts_from: f.acceptsFrom },
        ...(Number(f.budget) > 0 ? { budget: { per_run_usd: Number(f.budget) } } : {}),
      };
      if (id) {
        await api(`/api/agents/${id}`, { method: "PUT", body: { ...form, doc: f.description } });
      } else {
        await api("/api/agents", {
          method: "POST",
          body: { ...form, id: f.id.trim(), description: f.description },
        });
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal
      wide
      title={id ? t("agents.edit", { agent: id }) : t("agents.new")}
      onClose={onClose}
      footer={
        <>
          <button type="button" class="btn ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" form={formId} class="btn primary">
            {id ? t("common.save") : t("agents.form.create")}
          </button>
        </>
      }
    >
      {!loaded && <p class="muted">{error ?? t("app.loading")}</p>}
      <form id={formId} onSubmit={submit} hidden={!loaded}>
        {!id && text("id", t("agents.form.id"), t("agents.form.idHelp"))}
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
            class={`input ${id ? "mono" : ""}`}
            rows={id ? 10 : 3}
            value={f.description}
            onInput={(e) => set({ description: e.currentTarget.value })}
          />
          <span class="muted small">{t("agents.form.descriptionHelp")}</span>
        </label>
        <div class="field">
          {t("agents.form.roles")}
          <div class="row wrap">
            {[...new Set([...(opts?.roles ?? []), ...f.roles])].map((r) => (
              <label key={r} class="row">
                <input
                  type="checkbox"
                  checked={f.roles.includes(r)}
                  onChange={() => set({ roles: toggle(f.roles, r) })}
                />
                <code>{r}</code>
              </label>
            ))}
          </div>
          <div class="row">
            <input
              class="input"
              placeholder={t("agents.form.newRole")}
              value={newRole}
              onInput={(e) => setNewRole(e.currentTarget.value.toLowerCase())}
            />
            <button
              type="button"
              class="btn"
              disabled={!/^[a-z0-9][a-z0-9-]{0,63}$/.test(newRole.trim())}
              onClick={() => {
                if (!f.roles.includes(newRole.trim())) set({ roles: [...f.roles, newRole.trim()] });
                setNewRole("");
              }}
            >
              {t("agents.add")}
            </button>
          </div>
          <span class="muted small">{t("agents.form.rolesHelp")}</span>
        </div>
        <label class="field">
          {t("agents.form.effort")}
          <select
            class="input"
            value={f.effort}
            onChange={(e) => set({ effort: e.currentTarget.value })}
          >
            <option value="">{t("agents.form.effortDefault")}</option>
            {["low", "medium", "high", "xhigh", "max"].map((x) => (
              <option key={x} value={x}>
                {t(`agents.form.effort.${x}`)}
              </option>
            ))}
          </select>
          <span class="muted small">{t("agents.form.effortHelp")}</span>
        </label>
        <div class="field">
          {t("agents.form.models")}
          <span class="muted small">{t("agents.allowedHelp")}</span>
          <div class="model-list">
            {[...new Set([...f.models.allowed, f.models.default, ...(opts?.models ?? [])])].map(
              (m) => (
                <label key={m} class="model">
                  <input
                    type="checkbox"
                    checked={f.models.allowed.includes(m)}
                    onChange={() =>
                      set({ models: { ...f.models, allowed: toggle(f.models.allowed, m) } })
                    }
                  />
                  <code>{m}</code>
                  <input
                    type="radio"
                    name={`${formId}-default`}
                    title={t("agents.default")}
                    checked={f.models.default === m}
                    disabled={!f.models.allowed.includes(m)}
                    onChange={() => set({ models: { ...f.models, default: m } })}
                  />
                  <span>
                    {f.models.default === m && (
                      <span class="chip progress">{t("agents.default")}</span>
                    )}
                  </span>
                </label>
              ),
            )}
          </div>
          <div class="row">
            <input
              class="input mono"
              placeholder="provider/model"
              value={custom}
              onInput={(e) => setCustom(e.currentTarget.value)}
            />
            <button
              type="button"
              class="btn"
              disabled={!custom.trim()}
              onClick={() => {
                const m = custom.trim();
                if (!f.models.allowed.includes(m))
                  set({ models: { ...f.models, allowed: [...f.models.allowed, m] } });
                setCustom("");
              }}
            >
              {t("agents.add")}
            </button>
          </div>
        </div>

        {leveled ? (
          <>
            <h3 class="sec">{t("agents.form.level")}</h3>
            <p class="muted">{t("agents.form.levelHelp")}</p>
            <div class="level-pick">
              {LEVELS.map((l, n) => (
                <label key={l.name}>
                  <input
                    type="radio"
                    name={`${formId}-level`}
                    checked={f.level === n}
                    onChange={() => set({ level: n })}
                  />
                  <span>
                    <strong>{levelLabel(n)}</strong>
                    <span class="muted small">{l.meaning}</span>
                  </span>
                </label>
              ))}
            </div>
            <h3 class="sec">{t("agents.form.remit")}</h3>
            <p class="muted">{t("agents.form.remitHelp")}</p>
            {area("write", t("agents.form.write"), t("agents.form.pathsHelp"))}
            {area("read", t("agents.form.read"), t("agents.form.pathsHelp"))}
            <div class="field">
              {t("agents.form.integrations")}
              <div class="row wrap">
                {info?.mcp.length ? (
                  info.mcp.map((m) => (
                    <span key={m} class="chip">
                      {m}
                    </span>
                  ))
                ) : (
                  <span class="muted small">{t("agents.form.noIntegrations")}</span>
                )}
              </div>
              <span class="muted small">{t("agents.form.integrationsHelp")}</span>
            </div>
            {(info?.unsandboxed?.length || info?.keys_beside_host_shell) && (
              <div class="field exception">
                <strong>{t("agents.form.exception")}</strong>
                {info.unsandboxed?.length ? (
                  <span>
                    {t("agents.form.unsandboxed")}{" "}
                    {info.unsandboxed.map((p) => (
                      <code key={p}>{p} </code>
                    ))}
                  </span>
                ) : null}
                {info.keys_beside_host_shell && <span>{t("agents.form.keysBeside")}</span>}
                <span class="muted small">{t("agents.form.exceptionHelp")}</span>
              </div>
            )}
            {info?.conflicts?.map((c) => (
              <p key={c} class="error small">
                {c}
              </p>
            ))}
          </>
        ) : (
          <>
            <h3 class="sec">{t("agents.form.permissions")}</h3>
            <p class="muted">{t("agents.form.legacy")}</p>
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
            {(lines(f.network).includes("*") || f.tools.includes("Bash")) && (
              <div class="field">
                <label class="row">
                  <input
                    type="checkbox"
                    checked={f.container}
                    onChange={() => set({ container: !f.container })}
                  />
                  {t("agents.form.container")}
                </label>
                <span class="muted small">
                  {t(
                    lines(f.network).includes("*")
                      ? "agents.form.containerHelp"
                      : "agents.form.containerShellHelp",
                  )}
                </span>
                {!f.container && lines(f.network).includes("*") && (
                  <p class="error">{t("agents.form.containerOff")}</p>
                )}
                {f.container &&
                  !f.models.default.startsWith("cli-claude/") &&
                  !/^local(-[a-z0-9-]+)?\//.test(f.models.default) && (
                    <p class="error">{t("agents.form.containerModel")}</p>
                  )}
              </div>
            )}
          </>
        )}
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
      {/* Outside the form: overrides save on their own, not with the Save button. */}
      {id && leveled && info?.level !== undefined && (
        <>
          <Overrides
            agentId={id}
            base={info.level}
            overrides={info.overrides ?? []}
            projects={info.effectiveLevels ?? []}
            onSaved={reloadInfo}
          />
          <h3 class="sec">{t("agents.form.effective")}</h3>
          <p class="muted small">{t("agents.form.effectiveHelp")}</p>
          <table>
            <thead>
              <tr>
                <th>{t("agents.form.project")}</th>
                <th>{t("agents.form.level")}</th>
                <th>{t("agents.form.why")}</th>
              </tr>
            </thead>
            <tbody>
              {info.effectiveLevels?.map((r) => (
                <tr key={r.project}>
                  <td>{r.name}</td>
                  <td>{levelLabel(r.level)}</td>
                  <td class="muted small">{reasonText(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Modal>
  );
}

/** Level overrides of one agent per project (ADR-0067), saved on each add or remove. */
function Overrides(props: {
  agentId: string;
  base: number;
  overrides: Override[];
  projects: EffectiveRow[];
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState({ project: "", level: props.base, skills: "" });
  const [error, setError] = useState<string>();
  const name = (slug: string) => props.projects.find((p) => p.project === slug)?.name ?? slug;
  const save = async (overrides: Override[]) => {
    setError(undefined);
    try {
      await api(`/api/agents/${props.agentId}/overrides`, {
        method: "PUT",
        body: { overrides },
      });
      props.onSaved();
      return true;
    } catch (err) {
      // The server's refusal (overrideRefusal), shown where the owner made the change.
      setError((err as Error).message);
      return false;
    }
  };
  const add = async () => {
    const o = {
      project: draft.project,
      level: draft.level,
      requires_skills: parseSkills(draft.skills),
    };
    const problem = overrideProblem(o, props.overrides, props.base, props.projects);
    if (problem) {
      setError(problem);
      return;
    }
    if (await save([...props.overrides, o])) {
      setDraft({ project: "", level: props.base, skills: "" });
    }
  };
  return (
    <>
      <h3 class="sec">{t("overrides.title")}</h3>
      <p class="muted small">{t("overrides.help")}</p>
      {props.overrides.length === 0 ? (
        <p class="muted small">{t("overrides.empty")}</p>
      ) : (
        <table>
          <tbody>
            {props.overrides.map((o) => (
              <tr key={o.project}>
                <td>{name(o.project)}</td>
                <td>{levelLabel(o.level)}</td>
                <td class="muted small">{o.requires_skills.join(", ")}</td>
                <td class="actions">
                  <button
                    type="button"
                    class="iconbtn"
                    aria-label={t("common.remove")}
                    title={t("common.remove")}
                    onClick={() => save(props.overrides.filter((x) => x.project !== o.project))}
                  >
                    <Trash2 class="icon" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div class="row wrap">
        <select
          class="input"
          aria-label={t("agents.form.project")}
          value={draft.project}
          onChange={(e) => setDraft({ ...draft, project: e.currentTarget.value })}
        >
          <option value="" disabled>
            {t("agents.form.project")}
          </option>
          {props.projects
            .filter((p) => !props.overrides.some((o) => o.project === p.project))
            .map((p) => (
              <option key={p.project} value={p.project}>
                {p.name}
              </option>
            ))}
        </select>
        <select
          class="input"
          aria-label={t("agents.form.level")}
          value={String(draft.level)}
          onChange={(e) => setDraft({ ...draft, level: Number(e.currentTarget.value) })}
        >
          {LEVELS.map((l, n) => (
            <option key={l.name} value={String(n)}>
              {levelLabel(n)}
            </option>
          ))}
        </select>
        <input
          class="input"
          aria-label={t("overrides.skills")}
          placeholder={t("overrides.skillsPlaceholder")}
          value={draft.skills}
          onInput={(e) => setDraft({ ...draft, skills: e.currentTarget.value })}
        />
        <button type="button" class="btn" onClick={add}>
          <Plus class="icon" />
          {t("overrides.add")}
        </button>
      </div>
      {error && <p class="error">{error}</p>}
    </>
  );
}
