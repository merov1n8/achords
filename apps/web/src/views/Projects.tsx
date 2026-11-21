import { Plus, Trash2 } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { Confirm, Modal } from "../components/Modal.tsx";
import { Sites } from "../components/Sites.tsx";
import { t } from "../i18n.ts";
import { usePoll } from "../poll.ts";
import type { Agent, Project } from "../types.ts";

export function Projects() {
  const projects = usePoll(() => api<Project[]>("/api/projects"), 15000);
  const agents = usePoll(() => api<Agent[]>("/api/agents"), 60000);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [removed, setRemoved] = useState<string>();
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
          onDeleted={(movedTo) => {
            setEditing(undefined);
            setRemoved(movedTo);
            projects.refresh();
          }}
        />
      )}
      {removed && (
        <Modal title={t("projects.removedTitle")} onClose={() => setRemoved(undefined)}>
          <p>{t("projects.removedText")}</p>
          <p>
            <code class="select-all">{removed}</code>
          </p>
        </Modal>
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
    <Modal
      title={t("projects.new")}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" class="btn ghost" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" form="new-project" class="btn primary">
            {t("projects.create")}
          </button>
        </>
      }
    >
      <form id="new-project" onSubmit={submit}>
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
        {error && <p class="error">{error}</p>}
      </form>
    </Modal>
  );
}

// Suggested account channels; any lowercase id works. GA4 and Search Console values also limit
// what agents may query for this client (ADR-0036).
export const CHANNELS = [
  { id: "ga4", label: t("projects.channel.ga4") },
  { id: "search-console", label: t("projects.channel.searchConsole") },
  { id: "google-ads", label: t("projects.channel.googleAds") },
  { id: "meta-ads", label: t("projects.channel.metaAds") },
  { id: "facebook", label: t("projects.channel.facebook") },
  { id: "instagram", label: t("projects.channel.instagram") },
  { id: "tiktok", label: "TikTok" },
  { id: "youtube", label: "YouTube" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "x", label: "X" },
  { id: "pinterest", label: "Pinterest" },
  { id: "website", label: t("projects.channel.website") },
  { id: "repository", label: t("projects.channel.repository") },
];

// Channels with their own editor (several logins each, ADR-0047): kept out of the account rows,
// and carried over unchanged when the rows are saved.
export const SITE_CHANNELS = ["wordpress"];

export type Row = { channel: string; value: string };
export const toRows = (lists: Record<string, string[]>): Row[] =>
  Object.entries(lists)
    .filter(([channel]) => !SITE_CHANNELS.includes(channel))
    .flatMap(([channel, values]) => values.map((value) => ({ channel, value })));
/** The site lists of `lists`, to send back with edited account rows. */
export const siteLists = (lists: Record<string, string[]>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(lists).filter(([c]) => SITE_CHANNELS.includes(c)));
export const toLists = (rows: Row[]): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    const channel = r.channel.trim().toLowerCase();
    if (channel && r.value.trim()) out[channel] = [...(out[channel] ?? []), r.value.trim()];
  }
  return out;
};

/** One list per channel; a client can have several of each (two Instagram accounts, …). */
export function Accounts(props: {
  rows: Row[];
  onChange: (rows: Row[]) => void;
  /** Help under the rows; the project text by default. */
  help?: string;
}) {
  const set = (i: number, patch: Partial<Row>) =>
    props.onChange(props.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div class="field">
      {t("projects.accounts")}
      {props.rows.map((r, i) => (
        <div class="row" key={i}>
          <select
            class="input"
            style={{ maxWidth: "16rem" }}
            aria-label={t("projects.channel")}
            value={r.channel}
            onChange={(e) => set(i, { channel: e.currentTarget.value })}
          >
            <option value="" disabled>
              {t("projects.pickChannel")}
            </option>
            {CHANNELS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
            {/* A type set by hand in project.yaml stays selectable. */}
            {r.channel && !CHANNELS.some((c) => c.id === r.channel) && (
              <option value={r.channel}>{r.channel}</option>
            )}
          </select>
          <input
            class="input"
            placeholder={
              r.channel === "repository"
                ? "https://github.com/owner/repo"
                : t("projects.accountValue")
            }
            aria-label={t("projects.accountValue")}
            value={r.value}
            onInput={(e) => set(i, { value: e.currentTarget.value })}
          />
          <button
            type="button"
            class="btn ghost"
            aria-label={t("common.remove")}
            onClick={() => props.onChange(props.rows.filter((_, j) => j !== i))}
          >
            <Trash2 class="icon" />
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          class="btn ghost"
          onClick={() => props.onChange([...props.rows, { channel: "", value: "" }])}
        >
          <Plus class="icon" />
          {t("projects.addAccount")}
        </button>
      </div>
      <span class="muted small">{props.help ?? t("projects.accountsHelp")}</span>
    </div>
  );
}

/** Name, workspace, accounts and PROJECT.md; the slug (folder) and files/ stay as they are. */
function EditProject(props: {
  slug: string;
  workspaces: string[];
  onClose: () => void;
  onSaved: () => void;
  onDeleted: (movedTo: string) => void;
}) {
  const [f, setF] = useState<{ name: string; workspace: string; doc: string; rows: Row[] }>();
  const [deleting, setDeleting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();
  useEffect(() => {
    api<{
      name: string;
      workspace: string;
      doc: string;
      integrations: Record<string, string[]>;
    }>(`/api/projects/${props.slug}`)
      .then((p) =>
        setF({
          name: p.name,
          workspace: p.workspace,
          doc: p.doc,
          rows: toRows(p.integrations ?? {}),
        }),
      )
      .catch((err: Error) => setStatus({ ok: false, text: err.message }));
  }, [props.slug]);
  const save = async (e: Event) => {
    e.preventDefault();
    if (!f) return;
    setStatus(undefined);
    try {
      const { rows, ...rest } = f;
      // Sites are edited on their own (and may have changed meanwhile): keep the current ones.
      const current = await api<{ integrations: Record<string, string[]> }>(
        `/api/projects/${props.slug}`,
      );
      await api(`/api/projects/${props.slug}`, {
        method: "PUT",
        body: {
          ...rest,
          integrations: { ...toLists(rows), ...siteLists(current.integrations ?? {}) },
        },
      });
      props.onSaved();
      props.onClose();
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  };
  return (
    <Modal
      wide
      title={`${t("projects.edit")}: ${props.slug}`}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" class="btn danger" onClick={() => setDeleting(true)} disabled={!f}>
            <Trash2 class="icon" />
            {t("projects.delete")}
          </button>
          <span class={`grow ${status?.ok ? "muted" : "error"}`}>{status?.text}</span>
          <button type="button" class="btn ghost" onClick={props.onClose}>
            {t("common.close")}
          </button>
          <button type="submit" form="edit-project" class="btn primary" disabled={!f}>
            {t("common.save")}
          </button>
        </>
      }
    >
      {deleting && (
        <Confirm
          title={t("projects.deleteTitle", { name: f?.name ?? props.slug })}
          message={t("projects.deleteConfirm")}
          confirmLabel={t("projects.delete")}
          danger
          onConfirm={async () => {
            const r = await api<{ movedTo: string }>(`/api/projects/${props.slug}`, {
              method: "DELETE",
            });
            props.onDeleted(r.movedTo);
          }}
          onClose={() => setDeleting(false)}
        />
      )}
      {!f ? (
        !status && <p class="muted">{t("app.loading")}</p>
      ) : (
        <form id="edit-project" onSubmit={save}>
          <label class="field">
            {t("projects.name")}
            <input
              class="input"
              value={f.name}
              onInput={(e) => setF({ ...f, name: e.currentTarget.value })}
            />
          </label>
          <label class="field">
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
          <Accounts rows={f.rows} onChange={(rows) => setF({ ...f, rows })} />
          <label class="field">
            PROJECT.md
            <textarea
              class="input mono"
              rows={12}
              value={f.doc}
              onInput={(e) => setF({ ...f, doc: e.currentTarget.value })}
            />
            <span class="muted small">{t("projects.docHelp")}</span>
          </label>
        </form>
      )}
      {/* Outside the form: sites save on their own, not with the Save button. */}
      {f && <Sites slug={props.slug} />}
    </Modal>
  );
}
