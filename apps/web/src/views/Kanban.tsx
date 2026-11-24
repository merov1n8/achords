import { GripVertical, ListChecks, Plus } from "lucide-preact";
import { useRef, useState } from "preact/hooks";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import {
  ago,
  boardColumns,
  cardWorkspace,
  columnLabel,
  dropKind,
  type Matrix,
  unionColumns,
} from "../kanban.ts";
import { usePoll } from "../poll.ts";
import type { Agent, Project, Task } from "../types.ts";
import { CardModal } from "./CardModal.tsx";
import { NewCardModal } from "./NewCardModal.tsx";

const ALL = "*";
type Flow = { workflow: { columns: string[] }; matrix: Matrix };

const CHIP: Record<Task["status"], string> = {
  queued: "todo",
  claimed: "progress",
  done: "done",
  failed: "failed",
  cancelled: "failed",
};

type Drag = {
  task: Task;
  from: string;
  el: HTMLElement;
  x0: number;
  y0: number;
  active: boolean;
};

export function Kanban() {
  const agents = usePoll(() => api<Agent[]>("/api/agents"), 30000);
  const workspaces = [...new Set((agents.data ?? []).map((a) => a.workspace))].sort();
  const [picked, setPicked] = useState<string>();
  // "all" by default: every card at once, each with its assignee shown on the card.
  const ws = picked ?? ALL;
  const flows = usePoll(
    async () => {
      const list = await Promise.all(
        workspaces.map((w) => api<Flow>(`/api/workflow/${w}`).then((f) => [w, f] as const)),
      );
      return Object.fromEntries(list) as Record<string, Flow>;
    },
    30000,
    [workspaces.join(",")],
  );
  const tasks = usePoll(() => api<Task[]>("/api/tasks"), 3000);
  const projects = usePoll(() => api<Project[]>("/api/projects"), 60000);
  const [creating, setCreating] = useState(false);
  const [over, setOver] = useState<string>();
  const [keyMove, setKeyMove] = useState<{ task: Task; from: string; to: string }>();
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string>();
  const [showRules, setShowRules] = useState(false);
  const drag = useRef<Drag | undefined>(undefined);

  const flowOf = flows.data ?? {};
  const columns =
    ws === ALL
      ? unionColumns(workspaces.map((w) => flowOf[w]?.workflow.columns ?? []))
      : (flowOf[ws]?.workflow.columns ?? []);
  const agentWs = new Map((agents.data ?? []).map((a) => [a.id, a.workspace]));
  const projectWs = new Map((projects.data ?? []).map((p) => [p.slug, p.workspace]));
  const wsOf = (task: Task) => cardWorkspace(task, agentWs, projectWs);
  // Workflow rules belong to the card's workspace (its assignee's, else its project's).
  const matrixFor = (task: Task): Matrix => flowOf[wsOf(task) ?? ""]?.matrix ?? [];
  const board = boardColumns(columns, tasks.data ?? [], (task) => {
    const w = wsOf(task);
    return w !== undefined && (ws === ALL || w === ws);
  });
  const [open, setOpen] = useState<string>();
  // Phones show one column at a time: the picked one, else the first with cards.
  const [shown, setShown] = useState<string>();
  const current =
    (shown && columns.includes(shown) ? shown : undefined) ??
    board.find((c) => c.cards.length)?.id ??
    columns[0];

  const move = async (task: Task, from: string, to: string) => {
    if (from === to) return;
    setError(undefined);
    try {
      await api(`/api/tasks/${task.id}/move`, { method: "POST", body: { from, to } });
      setStatus(t("kanban.moved", { title: task.cardTitle, to: columnLabel(to) }));
    } catch (err) {
      setError((err as Error).message);
    }
    tasks.refresh();
  };

  // Pointer Events: one code path for mouse, pen and touch. Touch starts only from the grip so
  // the page still scrolls; a 5px threshold keeps clicks and text selection working.
  const onDown = (e: PointerEvent, task: Task, from: string) => {
    if (e.button !== 0) return;
    if (e.pointerType !== "mouse" && !(e.target as Element).closest(".grip")) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    drag.current = { task, from, el, x0: e.clientX, y0: e.clientY, active: false };
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.active && Math.hypot(dx, dy) < 5) return;
    d.active = true;
    d.el.classList.add("dragging");
    d.el.style.transform = `translate(${dx}px, ${dy}px)`;
    const col = document
      .elementsFromPoint(e.clientX, e.clientY)
      .find((n) => n instanceof HTMLElement && n.dataset.col) as HTMLElement | undefined;
    const to = col?.dataset.col;
    setOver(to);
    if (to && dropKind(matrixFor(d.task), d.from, to) === "override")
      setStatus(t("kanban.override"));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = undefined;
    if (!d) return;
    d.el.classList.remove("dragging");
    d.el.style.transform = "";
    const to = over;
    setOver(undefined);
    if (d.active && to) move(d.task, d.from, to);
    else if (!d.active) setOpen(d.task.id); // a click, not a drag: open the card
  };
  const onCancel = () => {
    const d = drag.current;
    drag.current = undefined;
    d?.el.classList.remove("dragging");
    if (d) d.el.style.transform = "";
    setOver(undefined);
  };

  // Keyboard: Enter opens the card; Space picks it up, arrows choose the column, Space or
  // Enter drops, Escape cancels.
  const onKey = (e: KeyboardEvent, task: Task, from: string) => {
    const idx = (c: string) => columns.indexOf(c);
    if (!keyMove || keyMove.task.id !== task.id) {
      if (e.key === "Enter") {
        e.preventDefault();
        setOpen(task.id);
      } else if (e.key === " ") {
        e.preventDefault();
        setKeyMove({ task, from, to: from });
        setStatus(t("kanban.picked", { title: task.cardTitle, to: columnLabel(from) }));
      }
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = columns[idx(keyMove.to) + (e.key === "ArrowRight" ? 1 : -1)];
      if (next) {
        setKeyMove({ ...keyMove, to: next });
        const kind = dropKind(matrixFor(task), from, next);
        setStatus(
          `${t("kanban.picked", { title: task.cardTitle, to: columnLabel(next) })}${kind === "override" ? ` ${t("kanban.override")}` : ""}`,
        );
      }
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setKeyMove(undefined);
      move(task, from, keyMove.to);
    } else if (e.key === "Escape") {
      setKeyMove(undefined);
      setStatus(t("kanban.cancelled"));
    }
  };

  const target = over ?? keyMove?.to;
  const source = drag.current?.from ?? keyMove?.from;
  const moving = drag.current?.task ?? keyMove?.task;
  const dropClass = (col: string) => {
    if (!target || !source || !moving || col !== target) return "";
    const kind = dropKind(matrixFor(moving), source, col);
    return kind === "same" ? "" : kind === "allowed" ? "drop-ok" : "drop-override";
  };

  return (
    <>
      <div class="page-head">
        <h1>{t("nav.kanban")}</h1>
        <div class="row">
          {workspaces.length > 1 && (
            <label class="row">
              <span class="muted">{t("kanban.workspace")}</span>
              <select class="input" value={ws} onChange={(e) => setPicked(e.currentTarget.value)}>
                <option value={ALL}>{t("kanban.allWorkspaces")}</option>
                {workspaces.map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
            </label>
          )}
          {ws !== ALL && (
            <button
              type="button"
              class="btn ghost"
              aria-pressed={showRules}
              onClick={() => setShowRules(!showRules)}
            >
              <ListChecks class="icon" />
              {t("kanban.rules")}
            </button>
          )}
          <button type="button" class="btn primary" onClick={() => setCreating(true)}>
            <Plus class="icon" />
            {t("kanban.newCard")}
          </button>
        </div>
      </div>
      <fieldset class="kanban-tabs" aria-label={t("kanban.columns")}>
        {board.map((col) => (
          <button
            key={col.id}
            type="button"
            aria-pressed={col.id === current}
            onClick={() => setShown(col.id)}
          >
            {columnLabel(col.id)} {col.cards.length}
          </button>
        ))}
      </fieldset>
      <div class="kanban" style={`--cols:${Math.max(columns.length, 1)}`}>
        {board.map((col) => (
          <section
            key={col.id}
            class={`column ${dropClass(col.id)} ${col.id === current ? "current" : ""}`}
            data-col={col.id}
          >
            <h2>
              {columnLabel(col.id)} <span class="muted">{col.cards.length}</span>
            </h2>
            {col.cards.map(({ task, children }) => (
              // biome-ignore lint/a11y/useSemanticElements: a draggable card, not a button
              <div
                key={task.id}
                class={`card kcard ${keyMove?.task.id === task.id ? "picked" : ""}`}
                tabIndex={0}
                role="button"
                aria-roledescription="draggable card"
                onPointerDown={(e) => onDown(e, task, col.id)}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onCancel}
                onKeyDown={(e) => onKey(e, task, col.id)}
              >
                <div class="top">
                  <span class="grip" aria-hidden="true">
                    <GripVertical class="icon" />
                  </span>
                  <span class="who" title={t("kanban.assignee")}>
                    {task.assigneeAgentId ?? t("kanban.unassigned")}
                  </span>
                </div>
                <div class="t">{task.cardTitle}</div>
                <div class="m">
                  {task.parked ? (
                    <span class="chip">{t("kanban.notStarted")}</span>
                  ) : (
                    <span class={`chip ${CHIP[task.status]}`}>{t(`status.${task.status}`)}</span>
                  )}
                  {ago(task.updatedAt)}
                  {children > 0 && <span>· {t("kanban.subtasks", { n: children })}</span>}
                </div>
                {task.error && task.status !== "done" && <div class="error">{task.error}</div>}
              </div>
            ))}
          </section>
        ))}
      </div>
      <p class="muted small kbd-help">{t("kanban.keyboardHelp")}</p>
      {open && (
        <CardModal
          id={open}
          columns={columns}
          agents={agents.data ?? []}
          onClose={() => setOpen(undefined)}
          onChanged={tasks.refresh}
        />
      )}
      {creating && (
        <NewCardModal
          {...(ws !== ALL ? { workspace: ws } : {})}
          agents={agents.data ?? []}
          projects={projects.data ?? []}
          columnsOf={(w) =>
            flowOf[w]?.workflow.columns ??
            unionColumns(workspaces.map((x) => flowOf[x]?.workflow.columns ?? []))
          }
          onClose={() => setCreating(false)}
          onCreated={(task) => {
            setCreating(false);
            setStatus(t("kanban.created", { title: task.title }));
            tasks.refresh();
          }}
        />
      )}
      {board.every((c) => c.cards.length === 0) && tasks.data && (
        <p class="muted">{t("kanban.empty")}</p>
      )}
      <p class="muted" aria-live="polite">
        {status}
      </p>
      {(error ?? tasks.error ?? flows.error) && (
        <p class="error">{error ?? tasks.error ?? flows.error}</p>
      )}
      {showRules && ws !== ALL && (
        <div class="panel gap-top">
          <h2>{t("kanban.rules")}</h2>
          <p class="muted">{t("kanban.rulesHelp", { ws: ws ?? "" })}</p>
          <table>
            <tbody>
              {(flowOf[ws]?.matrix ?? []).map((row) => (
                <tr key={row.to}>
                  <th>{columnLabel(row.to)}</th>
                  <td>
                    {row.rules.length === 0 ? (
                      <span class="muted">{t("kanban.noRules")}</span>
                    ) : (
                      row.rules.map((r) => (
                        <div key={`${r.from}-${r.by}`}>
                          <code>{r.by}</code> {t("kanban.ruleFrom", { from: columnLabel(r.from) })}
                          {r.not === "assignee" && (
                            <span class="muted"> · {t("kanban.ruleNotAssignee")}</span>
                          )}
                        </div>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
