import { Plus } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { usePoll } from "../poll.ts";
import type { Agent, Project } from "../types.ts";

export function Projects() {
  const projects = usePoll(() => api<Project[]>("/api/projects"), 15000);
  const agents = usePoll(() => api<Agent[]>("/api/agents"), 60000);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string>();
  return (
    <>
      <div class="page-head">
        <h1>{t("nav.projects")}</h1>
        <button type="button" class="btn primary" onClick={() => setCreating(true)}>
          <Plus class="icon" />
          {t("projects.new")}
        </button>
      </div>
      <p class="muted">{t("projects.help")}</p>
      <div class="panel">
        {projects.data?.length === 0 ? (
          <p class="muted">{t("projects.empty")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("projects.name")}</th>
                <th>{t("agents.workspace")}</th>
                <th>{t("projects.folder")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {projects.data?.map((p) => (
                <tr key={p.slug}>
                  <td>
                    {p.name} <code class="muted">{p.slug}</code>
                  </td>
                  <td>{p.workspace}</td>
                  <td>
                    <code>{p.filesDir}</code>
                  </td>
                  <td>
                    <button type="button" class="btn ghost" onClick={() => setEditing(p.slug)}>
                      {t("common.edit")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p class="muted small">{t("projects.finderHint")}</p>
      {projects.error && <p class="error">{projects.error}</p>}
      {editing && (
        <EditProject
          key={editing}
          slug={editing}
          workspaces={[...new Set((agents.data ?? []).map((a) => a.workspace))]}
          onClose={() => setEditing(undefined)}
          onSaved={projects.refresh}
        />
      )}
      {creating && (
        <NewProject
          workspaces={[...new Set((agents.data ?? []).map((a) => a.workspace))]}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            projects.refresh();
          }}
        />
      )}
    </>
  );
}

function NewProject(props: { workspaces: string[]; onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({ slug: "", name: "", workspace: props.workspaces[0] ?? "" });
  const [error, setError] = useState<string>();
  const submit = async (e: Event) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api("/api/projects", { method: "POST", body: f });
      props.onCreated();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form class="panel gap-top narrow" onSubmit={submit}>
      <div class="page-head">
        <h2>{t("projects.new")}</h2>
        <button type="button" class="btn ghost" onClick={props.onClose}>
          {t("common.close")}
        </button>
      </div>
      <label class="field">
        {t("projects.name")}
        <input
          class="input"
          value={f.name}
          onInput={(e) => setF({ ...f, name: e.currentTarget.value })}
        />
      </label>
      <label class="field">
        {t("projects.slug")}
        <input
          class="input"
          value={f.slug}
          onInput={(e) => setF({ ...f, slug: e.currentTarget.value })}
        />
        <span class="muted small">{t("projects.slugHelp")}</span>
      </label>
      <label class="field">
        {t("agents.workspace")}
        <input
          class="input"
          list="project-workspaces"
          value={f.workspace}
          onInput={(e) => setF({ ...f, workspace: e.currentTarget.value })}
        />
        <datalist id="project-workspaces">
          {props.workspaces.map((w) => (
            <option key={w} value={w} />
          ))}
        </datalist>
        <span class="muted small">{t("projects.workspaceHelp")}</span>
      </label>
      <button type="submit" class="btn primary">
        {t("projects.create")}
      </button>
      {error && <p class="error">{error}</p>}
    </form>
  );
}

/** Name, workspace and PROJECT.md; the slug (folder) and files/ stay as they are. */
function EditProject(props: {
  slug: string;
  workspaces: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState<{ name: string; workspace: string; doc: string }>();
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();
  useEffect(() => {
    api<{ name: string; workspace: string; doc: string }>(`/api/projects/${props.slug}`)
      .then((p) => setF({ name: p.name, workspace: p.workspace, doc: p.doc }))
      .catch((err: Error) => setStatus({ ok: false, text: err.message }));
  }, [props.slug]);
  if (!f) return status ? <p class="error">{status.text}</p> : null;
  const save = async (e: Event) => {
    e.preventDefault();
    setStatus(undefined);
    try {
      await api(`/api/projects/${props.slug}`, { method: "PUT", body: f });
      setStatus({ ok: true, text: t("projects.saved") });
      props.onSaved();
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  };
  return (
    <form class="panel gap-top" onSubmit={save}>
      <div class="page-head">
        <h2>
          {t("projects.edit")} <code class="muted">{props.slug}</code>
        </h2>
        <button type="button" class="btn ghost" onClick={props.onClose}>
          {t("common.close")}
        </button>
      </div>
      <label class="field narrow">
        {t("projects.name")}
        <input
          class="input"
          value={f.name}
          onInput={(e) => setF({ ...f, name: e.currentTarget.value })}
        />
      </label>
      <label class="field narrow">
        {t("agents.workspace")}
        <input
          class="input"
          list="edit-project-workspaces"
          value={f.workspace}
          onInput={(e) => setF({ ...f, workspace: e.currentTarget.value })}
        />
        <datalist id="edit-project-workspaces">
          {props.workspaces.map((w) => (
            <option key={w} value={w} />
          ))}
        </datalist>
      </label>
      <label class="field">
        PROJECT.md
        <textarea
          class="input mono"
          rows={16}
          value={f.doc}
          onInput={(e) => setF({ ...f, doc: e.currentTarget.value })}
        />
        <span class="muted small">{t("projects.docHelp")}</span>
      </label>
      <button type="submit" class="btn primary">
        {t("common.save")}
      </button>
      {status && <span class={status.ok ? "muted" : "error"}> {status.text}</span>}
    </form>
  );
}
