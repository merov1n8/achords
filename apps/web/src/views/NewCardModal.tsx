import { useId, useState } from "preact/hooks";
import { api } from "../api.ts";
import { Modal } from "../components/Modal.tsx";
import { t } from "../i18n.ts";
import { cardWorkspace, columnLabel } from "../kanban.ts";
import type { Agent, Project, Task } from "../types.ts";

/**
 * A card made by hand. Without "Start now" it waits (parked) until the owner presses Start in
 * the card; with it, the agent begins right away. Either way it gets its own chat.
 */
export function NewCardModal(props: {
  /** The picked workspace, or undefined on the "All" board. */
  workspace?: string;
  agents: Agent[];
  projects: Project[];
  /** Workflow columns per workspace. */
  columnsOf: (workspace: string) => string[];
  onClose: () => void;
  onCreated: (task: Task) => void;
}) {
  const formId = useId();
  const [f, setF] = useState({ title: "", description: "", agent: "", project: "", start: false });
  const [column, setColumn] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const workers = props.agents.filter(
    (a) => a.id !== "boss" && (!props.workspace || a.workspace === props.workspace),
  );
  const groups = [...new Set(workers.map((a) => a.workspace))].sort();
  // The columns of the workflow the card will follow (decided like the gateway does).
  const space = cardWorkspace(
    { assigneeAgentId: f.agent || null, project: f.project || null },
    new Map(props.agents.map((a) => [a.id, a.workspace])),
    new Map(props.projects.map((p) => [p.slug, p.workspace])),
  );
  const columns = props.columnsOf(space ?? "shared");
  const fallback = columns.includes("backlog") ? "backlog" : columns[0];
  const col = column && columns.includes(column) ? column : fallback;
  const lost = props.workspace && !f.agent && space !== props.workspace;

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!f.title.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const task = await api<Task>("/api/tasks", {
        method: "POST",
        body: {
          title: f.title.trim(),
          description: f.description.trim(),
          agent: f.agent || null,
          project: f.project || null,
          column: col ?? null,
          start: Boolean(f.agent) && f.start,
        },
      });
      props.onCreated(task);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const option = (a: Agent) => (
    <option key={a.id} value={a.id}>
      {a.name} ({a.id})
    </option>
  );

  return (
    <Modal
      title={t("card.new")}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" class="btn ghost" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            form={formId}
            class="btn primary"
            disabled={busy || !f.title.trim()}
          >
            {t("card.create")}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        <label class="field">
          {t("card.title")}
          <input
            class="input"
            required
            maxLength={200}
            value={f.title}
            onInput={(e) => setF({ ...f, title: e.currentTarget.value })}
          />
        </label>
        <label class="field">
          {t("card.description")}
          <textarea
            class="input"
            rows={4}
            maxLength={20000}
            value={f.description}
            onInput={(e) => setF({ ...f, description: e.currentTarget.value })}
          />
        </label>
        <label class="field">
          {t("card.agent")}
          <select
            class="input"
            value={f.agent}
            onChange={(e) => setF({ ...f, agent: e.currentTarget.value })}
          >
            <option value="">{t("card.noAgent")}</option>
            {groups.length > 1
              ? groups.map((g) => (
                  <optgroup key={g} label={g}>
                    {workers.filter((a) => a.workspace === g).map(option)}
                  </optgroup>
                ))
              : workers.map(option)}
          </select>
        </label>
        {props.projects.length > 0 && (
          <label class="field">
            {t("chat.project")}
            <select
              class="input"
              value={f.project}
              onChange={(e) => setF({ ...f, project: e.currentTarget.value })}
            >
              <option value="">{t("chat.noProject")}</option>
              {props.projects.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {columns.length > 0 && (
          <label class="field">
            {t("card.column")}
            {/* Started at once, it goes to the workflow's start column instead. */}
            <select
              class="input"
              value={col}
              disabled={Boolean(f.agent) && f.start}
              onChange={(e) => setColumn(e.currentTarget.value)}
            >
              {columns.map((c) => (
                <option key={c} value={c}>
                  {columnLabel(c)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label class="row">
          <input
            type="checkbox"
            checked={Boolean(f.agent) && f.start}
            disabled={!f.agent}
            onChange={(e) => setF({ ...f, start: e.currentTarget.checked })}
          />
          {t("card.startNow")}
        </label>
        <p class="muted small">{t(f.agent ? "card.startNowHelp" : "card.startNowNeedsAgent")}</p>
        {lost && <p class="muted small">{t("card.sharedHint", { ws: space ?? "shared" })}</p>}
        {error && <p class="error">{error}</p>}
      </form>
    </Modal>
  );
}
