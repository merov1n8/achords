import { Link, Pencil, Plus, Trash2 } from "lucide-preact";
import { useId, useState } from "preact/hooks";
import { api } from "../api.ts";
import { Confirm, Modal } from "../components/Modal.tsx";
import { t } from "../i18n.ts";
import { ago } from "../kanban.ts";
import { usePoll } from "../poll.ts";
import type { Skill, SkillProposal, SkillsPage } from "../types.ts";

type Draft = Omit<Skill, "enabled" | "updated">;

const skillPath = (s: { workspace: string; name: string }) =>
  `/api/skills/${encodeURIComponent(s.workspace)}/${encodeURIComponent(s.name)}`;
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Skills (ADR-0049): how-tos the agents follow; agents propose, the owner decides here. */
export function Skills() {
  const page = usePoll(() => api<SkillsPage>("/api/skills"), 15000);
  const [form, setForm] = useState<{ editing?: Skill; draft?: Draft }>();
  const [importing, setImporting] = useState(false);
  const [confirm, setConfirm] = useState<Skill>();
  const [error, setError] = useState<string>();
  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      page.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const data = page.data;
  return (
    <>
      <div class="page-head">
        <h1>{t("nav.skills")}</h1>
        <div class="row">
          <button type="button" class="btn" onClick={() => setImporting(true)}>
            <Link class="icon" />
            {t("skills.import")}
          </button>
          <button type="button" class="btn primary" onClick={() => setForm({})}>
            <Plus class="icon" />
            {t("skills.new")}
          </button>
        </div>
      </div>
      <p class="muted">{t("skills.help")}</p>
      {!!data?.proposals.length && (
        <Proposals
          proposals={data.proposals}
          onDecide={(id, verb) =>
            act(() =>
              api("/api/actions", { method: "POST", body: { data: `skill:${verb}:${id}` } }),
            )
          }
        />
      )}
      <div class={`panel ${data?.proposals.length ? "gap-top" : ""}`}>
        {data?.skills.length === 0 ? (
          <p class="muted">{t("skills.empty")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("skills.name")}</th>
                <th>{t("schedules.on")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.skills.map((s) => (
                <tr key={`${s.workspace}/${s.name}`}>
                  <td>
                    {s.name}
                    <div class="muted small">{s.description}</div>
                    {/* Workspace, source and date on one line keep the table narrow on phones. */}
                    <div class="muted small">
                      {s.workspace}
                      {s.source && (
                        <>
                          {" · "}
                          <a href={s.source} target="_blank" rel="noopener noreferrer">
                            {host(s.source)}
                          </a>
                        </>
                      )}
                      {s.updated && ` · ${t("skills.updatedOn", { date: s.updated })}`}
                    </div>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      aria-label={t("schedules.on")}
                      onChange={() =>
                        act(() =>
                          api(skillPath(s), { method: "PUT", body: { enabled: !s.enabled } }),
                        )
                      }
                    />
                  </td>
                  <td class="actions">
                    <button
                      type="button"
                      class="iconbtn"
                      aria-label={t("common.edit")}
                      title={t("common.edit")}
                      onClick={() => setForm({ editing: s })}
                    >
                      <Pencil class="icon" />
                    </button>
                    <button
                      type="button"
                      class="iconbtn"
                      aria-label={t("schedules.delete")}
                      title={t("schedules.delete")}
                      onClick={() => setConfirm(s)}
                    >
                      <Trash2 class="icon" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {error && <p class="error">{error}</p>}
      </div>
      {data && (
        <Modes
          modes={data.modes}
          onChange={(ws, mode) =>
            act(() =>
              api(`/api/skills-mode/${encodeURIComponent(ws)}`, { method: "PUT", body: { mode } }),
            )
          }
        />
      )}
      {form && data && (
        <SkillForm
          key={form.editing ? skillPath(form.editing) : "new"}
          editing={form.editing}
          draft={form.draft}
          workspaces={data.workspaces}
          onClose={() => setForm(undefined)}
          onSaved={() => {
            setForm(undefined);
            page.refresh();
          }}
        />
      )}
      {importing && (
        <ImportForm
          onClose={() => setImporting(false)}
          onFetched={(draft) => {
            setImporting(false);
            setForm({ draft: { ...draft, workspace: "shared" } });
          }}
        />
      )}
      {confirm && (
        <Confirm
          title={t("skills.deleteTitle")}
          message={t("skills.deleteConfirm", { name: confirm.name })}
          confirmLabel={t("schedules.delete")}
          danger
          onConfirm={async () => {
            await api(skillPath(confirm), { method: "DELETE" });
            page.refresh();
          }}
          onClose={() => setConfirm(undefined)}
        />
      )}
    </>
  );
}

function Proposals(props: {
  proposals: SkillProposal[];
  onDecide: (id: string, verb: "approve" | "reject") => void;
}) {
  return (
    <div class="panel">
      <h2>{t("skills.pending")}</h2>
      <table>
        <tbody>
          {props.proposals.map((p) => (
            <tr key={p.id}>
              <td>
                {p.replaces
                  ? t("skills.proposalChange", { name: p.replaces, agent: p.proposedBy })
                  : t("skills.proposalNew", { name: p.name, agent: p.proposedBy })}
                <div class="muted small">
                  {p.workspace} · {p.reason} · {ago(p.createdAt)}
                </div>
                <details class="small">
                  <summary>{t("skills.showText")}</summary>
                  <p>{p.description}</p>
                  <div class="pre mono">{p.body}</div>
                </details>
              </td>
              <td class="actions">
                <button
                  type="button"
                  class="btn primary"
                  onClick={() => props.onDecide(p.id, "approve")}
                >
                  {t("skills.approve")}
                </button>
                <button
                  type="button"
                  class="btn ghost"
                  onClick={() => props.onDecide(p.id, "reject")}
                >
                  {t("skills.reject")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Modes(props: {
  modes: Record<string, "review" | "auto">;
  onChange: (workspace: string, mode: "review" | "auto") => void;
}) {
  return (
    <div class="panel gap-top narrow">
      <h2>{t("skills.modes")}</h2>
      <p class="muted small">{t("skills.modesHelp")}</p>
      {Object.entries(props.modes).map(([ws, mode]) => (
        <label class="field" key={ws}>
          {ws}
          <select
            class="input"
            value={mode}
            onChange={(e) => props.onChange(ws, e.currentTarget.value as "review" | "auto")}
          >
            <option value="review">{t("skills.mode.review")}</option>
            <option value="auto">{t("skills.mode.auto")}</option>
          </select>
        </label>
      ))}
    </div>
  );
}

/** Add, edit, or save an imported draft: same form, PUT when editing. */
function SkillForm(props: {
  editing?: Skill | undefined;
  draft?: Draft | undefined;
  workspaces: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const s0 = props.editing ?? props.draft;
  const formId = useId();
  const [f, setF] = useState({
    workspace: s0?.workspace ?? "shared",
    name: s0?.name ?? "",
    description: s0?.description ?? "",
    body: s0?.body ?? "",
    source: s0?.source ?? "",
  });
  const [error, setError] = useState<string>();
  const submit = async (e: Event) => {
    e.preventDefault();
    setError(undefined);
    try {
      const body = { description: f.description, body: f.body, source: f.source.trim() };
      if (props.editing) await api(skillPath(props.editing), { method: "PUT", body });
      else
        await api("/api/skills", {
          method: "POST",
          body: { ...body, workspace: f.workspace, name: f.name },
        });
      props.onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal
      wide
      title={t(props.editing ? "skills.edit" : "skills.new")}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" class="btn ghost" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" form={formId} class="btn primary">
            {t("common.save")}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        <div class="row wrap">
          <label class="field">
            {t("skills.workspace")}
            <select
              class="input"
              value={f.workspace}
              disabled={!!props.editing}
              onChange={(e) => setF({ ...f, workspace: e.currentTarget.value })}
            >
              {props.workspaces.map((ws) => (
                <option key={ws} value={ws}>
                  {ws}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            {t("skills.name")}
            <input
              class="input"
              value={f.name}
              disabled={!!props.editing}
              placeholder="owner-report"
              onInput={(e) => setF({ ...f, name: e.currentTarget.value })}
            />
          </label>
        </div>
        <label class="field">
          {t("skills.description")}
          <input
            class="input"
            value={f.description}
            onInput={(e) => setF({ ...f, description: e.currentTarget.value })}
          />
          <span class="muted small">{t("skills.descriptionHelp")}</span>
        </label>
        <label class="field">
          {t("skills.body")}
          <textarea
            class="input mono"
            rows={14}
            value={f.body}
            onInput={(e) => setF({ ...f, body: e.currentTarget.value })}
          />
          <span class="muted small">{t("skills.bodyHelp")}</span>
        </label>
        <label class="field">
          {t("skills.source")}
          <input
            class="input"
            value={f.source}
            placeholder="https://"
            onInput={(e) => setF({ ...f, source: e.currentTarget.value })}
          />
        </label>
        {error && <p class="error">{error}</p>}
      </form>
    </Modal>
  );
}

/** The gateway fetches the link; the result opens in the Add form for the owner to check. */
function ImportForm(props: {
  onClose: () => void;
  onFetched: (draft: Omit<Draft, "workspace">) => void;
}) {
  const formId = useId();
  const [url, setUrl] = useState("https://");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (e: Event) => {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      props.onFetched(
        await api<Omit<Draft, "workspace">>("/api/skills/import", {
          method: "POST",
          body: { url },
        }),
      );
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("skills.import")}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" class="btn ghost" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" form={formId} class="btn primary" disabled={busy}>
            {t("skills.fetch")}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        <label class="field">
          {t("skills.url")}
          <input class="input" value={url} onInput={(e) => setUrl(e.currentTarget.value)} />
          <span class="muted small">{t("skills.importHelp")}</span>
        </label>
        {error && <p class="error">{error}</p>}
      </form>
    </Modal>
  );
}
