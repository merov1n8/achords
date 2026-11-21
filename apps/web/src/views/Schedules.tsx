import { Pencil, Plus, Trash2 } from "lucide-preact";
import { useId, useState } from "preact/hooks";
import { api } from "../api.ts";
import { Confirm, Modal } from "../components/Modal.tsx";
import { t } from "../i18n.ts";
import { usePoll } from "../poll.ts";
import { clock, fromCron, KINDS, type Repeat, summary, toCron, withKind } from "../repeat.ts";
import type { Agent, Project } from "../types.ts";

type Schedule = {
  id: string;
  name: string;
  cron: string;
  agentId: string;
  title: string;
  instructions: string;
  enabled: boolean;
  nextRunAt: number;
  lastStatus: string | null;
  project: string | null;
};
type Upcoming = { scheduleId: string; name: string; agentId: string; at: number };

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (ms: number) =>
  new Date(ms).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
const STATUS_CHIP: Record<string, string> = {
  queued: "todo",
  claimed: "progress",
  done: "done",
  failed: "failed",
  cancelled: "failed",
};

export function Schedules() {
  const [view, setView] = useState<"list" | "today" | "week">("list");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Schedule>();
  const schedules = usePoll(() => api<Schedule[]>("/api/schedules"), 10000);
  return (
    <>
      <div class="page-head">
        <h1>{t("nav.schedules")}</h1>
        <div class="row">
          {(["list", "today", "week"] as const).map((v) => (
            <button
              key={v}
              type="button"
              class="btn ghost"
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              {t(`schedules.view.${v}`)}
            </button>
          ))}
          <button type="button" class="btn primary" onClick={() => setCreating(true)}>
            <Plus class="icon" />
            {t("schedules.new")}
          </button>
        </div>
      </div>
      {view === "list" && (
        <List schedules={schedules.data ?? []} onChange={schedules.refresh} onEdit={setEditing} />
      )}
      {view === "today" && <Timeline days={1} />}
      {view === "week" && <Timeline days={7} />}
      {editing && (
        <ScheduleForm
          key={editing.id}
          editing={editing}
          onClose={() => setEditing(undefined)}
          onCreated={() => {
            setEditing(undefined);
            schedules.refresh();
          }}
        />
      )}
      {creating && (
        <ScheduleForm
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            schedules.refresh();
          }}
        />
      )}
      {schedules.error && <p class="error">{schedules.error}</p>}
    </>
  );
}

function List({
  schedules,
  onChange,
  onEdit,
}: {
  schedules: Schedule[];
  onChange: () => void;
  onEdit: (s: Schedule) => void;
}) {
  const [confirm, setConfirm] = useState<Schedule>();
  const [error, setError] = useState<string>();
  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (schedules.length === 0) return <p class="muted">{t("schedules.empty")}</p>;
  return (
    <div class="panel">
      <table>
        <thead>
          <tr>
            <th>{t("schedules.name")}</th>
            <th>{t("schedules.agent")}</th>
            <th>{t("schedules.when")}</th>
            <th>{t("schedules.next")}</th>
            <th>{t("schedules.last")}</th>
            <th>{t("schedules.on")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {schedules.map((s) => (
            <tr key={s.id}>
              <td>
                {s.name}
                {s.project && <span class="muted"> · {s.project}</span>}
              </td>
              <td>
                <code>{s.agentId}</code>
              </td>
              <td title={s.cron}>{summary(fromCron(s.cron))}</td>
              <td>{s.enabled ? `${day(s.nextRunAt)} ${time(s.nextRunAt)}` : "–"}</td>
              <td>
                {s.lastStatus ? (
                  <span class={`chip ${STATUS_CHIP[s.lastStatus] ?? "todo"}`}>
                    {t(`status.${s.lastStatus}`)}
                  </span>
                ) : (
                  "–"
                )}
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={s.enabled}
                  aria-label={t("schedules.on")}
                  onChange={() =>
                    act(() =>
                      api(`/api/schedules/${s.id}`, {
                        method: "PUT",
                        body: { enabled: !s.enabled },
                      }),
                    )
                  }
                />
              </td>
              <td class="row-actions">
                <button
                  type="button"
                  class="iconbtn"
                  aria-label={t("common.edit")}
                  title={t("common.edit")}
                  onClick={() => onEdit(s)}
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
      {error && <p class="error">{error}</p>}
      {confirm && (
        <Confirm
          title={t("schedules.deleteTitle")}
          message={t("schedules.deleteConfirm", { name: confirm.name })}
          confirmLabel={t("schedules.delete")}
          danger
          onConfirm={async () => {
            await api(`/api/schedules/${confirm.id}`, { method: "DELETE" });
            onChange();
          }}
          onClose={() => setConfirm(undefined)}
        />
      )}
    </div>
  );
}

/** Today as a list of times; the week as seven columns. Past runs today are dimmed. */
function Timeline({ days }: { days: number }) {
  const upcoming = usePoll(() => api<Upcoming[]>(`/api/schedules/upcoming?days=${days}`), 30000, [
    days,
  ]);
  const items = upcoming.data ?? [];
  if (upcoming.data && items.length === 0) return <p class="muted">{t("schedules.nothing")}</p>;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const columns = Array.from({ length: days }, (_, i) => {
    const from = new Date(start);
    from.setDate(from.getDate() + i);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return {
      from: from.getTime(),
      items: items.filter((u) => u.at >= from.getTime() && u.at < to.getTime()),
    };
  });
  return (
    <div class={days > 1 ? "week" : ""}>
      {columns.map((c) => (
        <section key={c.from} class="panel day">
          <h2>{days > 1 ? day(c.from) : t("schedules.view.today")}</h2>
          {c.items.length === 0 && <p class="muted small">–</p>}
          {c.items.map((u) => (
            <div key={`${u.scheduleId}-${u.at}`} class={`slot ${u.at < Date.now() ? "past" : ""}`}>
              <code>{time(u.at)}</code> {u.name} <span class="muted">· {u.agentId}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/** New schedule, or edit an existing one (`editing`): same form, PUT instead of POST. */
function ScheduleForm(props: { editing?: Schedule; onClose: () => void; onCreated: () => void }) {
  const agents = usePoll(() => api<Agent[]>("/api/agents"), 60000);
  const projects = usePoll(() => api<Project[]>("/api/projects"), 60000);
  const formId = useId();
  const e0 = props.editing;
  const [f, setF] = useState({
    name: e0?.name ?? "",
    agentId: e0?.agentId ?? "",
    title: e0?.title ?? "",
    instructions: e0?.instructions ?? "",
    project: e0?.project ?? "",
    enabled: e0?.enabled ?? true,
  });
  const [repeat, setRepeat] = useState<Repeat>(fromCron(e0?.cron ?? "0 9 * * 1-5"));
  const [error, setError] = useState<string>();
  const workers = (agents.data ?? []).filter((a) => a.id !== "boss");
  const submit = async (e: Event) => {
    e.preventDefault();
    setError(undefined);
    if (repeat.kind === "weekly" && repeat.days.length === 0) {
      setError(t("repeat.noDays"));
      return;
    }
    try {
      const body = {
        ...f,
        cron: toCron(repeat),
        agentId: f.agentId || workers[0]?.id,
        project: f.project || null,
      };
      if (e0) await api(`/api/schedules/${e0.id}`, { method: "PUT", body });
      else await api("/api/schedules", { method: "POST", body });
      props.onCreated();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const field = (key: "name" | "title", label: string) => (
    <label class="field">
      {label}
      <input
        class="input"
        value={f[key]}
        onInput={(e) => setF({ ...f, [key]: e.currentTarget.value })}
      />
    </label>
  );
  return (
    <Modal
      title={t(e0 ? "schedules.edit" : "schedules.new")}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" class="btn ghost" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" form={formId} class="btn primary">
            {e0 ? t("common.save") : t("schedules.create")}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        {field("name", t("schedules.name"))}
        <RepeatPicker value={repeat} onChange={setRepeat} />
        <label class="field">
          {t("schedules.agent")}
          <select
            class="input"
            value={f.agentId || workers[0]?.id}
            onChange={(e) => setF({ ...f, agentId: e.currentTarget.value })}
          >
            {workers.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.id})
              </option>
            ))}
          </select>
        </label>
        {field("title", t("schedules.taskTitle"))}
        <label class="field">
          {t("schedules.instructions")}
          <textarea
            class="input"
            rows={4}
            value={f.instructions}
            onInput={(e) => setF({ ...f, instructions: e.currentTarget.value })}
          />
          <span class="muted small">{t("schedules.instructionsHelp")}</span>
        </label>
        {!!projects.data?.length && (
          <label class="field">
            {t("chat.project")}
            <select
              class="input"
              value={f.project}
              onChange={(e) => setF({ ...f, project: e.currentTarget.value })}
            >
              <option value="">{t("chat.noProject")}</option>
              {projects.data.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <p class="error">{error}</p>}
      </form>
    </Modal>
  );
}

// Monday first, as people read a week; cron keeps Sunday as 0.
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/** Repeat + when, like a todo app; Custom keeps raw cron for anything the picker cannot say. */
function RepeatPicker({ value: r, onChange }: { value: Repeat; onChange: (r: Repeat) => void }) {
  const time = "hour" in r && (
    <label class="field">
      {t("repeat.time")}
      <input
        type="time"
        class="input"
        value={clock(r.hour, r.minute)}
        onInput={(e) => {
          const [h, m] = e.currentTarget.value.split(":").map(Number);
          if (Number.isInteger(h) && Number.isInteger(m))
            onChange({ ...r, hour: h as number, minute: m as number });
        }}
      />
    </label>
  );
  return (
    <fieldset class="repeat">
      <div class="row wrap">
        <label class="field grow">
          {t("repeat.label")}
          <select
            class="input"
            value={r.kind}
            onChange={(e) => onChange(withKind(r, e.currentTarget.value as Repeat["kind"]))}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`repeat.kind.${k}`)}
              </option>
            ))}
          </select>
        </label>
        {r.kind === "hourly" && (
          <label class="field grow">
            {t("repeat.minute")}
            <input
              type="number"
              class="input"
              min={0}
              max={59}
              value={r.minute}
              onInput={(e) => {
                const m = Number(e.currentTarget.value);
                if (Number.isInteger(m) && m >= 0 && m <= 59) onChange({ ...r, minute: m });
              }}
            />
          </label>
        )}
        {r.kind === "monthly" && (
          <label class="field grow">
            {t("repeat.dayOfMonth")}
            <select
              class="input"
              value={r.day}
              onChange={(e) => onChange({ ...r, day: Number(e.currentTarget.value) })}
            >
              {Array.from({ length: 31 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1}
                </option>
              ))}
            </select>
          </label>
        )}
        {r.kind !== "custom" && r.kind !== "hourly" && <div class="grow">{time}</div>}
      </div>
      {r.kind === "weekly" && (
        <div class="field">
          {t("repeat.days")}
          <div class="row wrap days">
            {WEEK.map((d) => (
              <button
                key={d}
                type="button"
                class="btn"
                aria-pressed={r.days.includes(d)}
                onClick={() =>
                  onChange({
                    ...r,
                    days: r.days.includes(d)
                      ? r.days.filter((x) => x !== d)
                      : [...r.days, d].sort((a, b) => a - b),
                  })
                }
              >
                {t(`repeat.day.${d}`)}
              </button>
            ))}
          </div>
        </div>
      )}
      {r.kind === "monthly" && r.day > 28 && (
        <p class="muted small">{t("repeat.dayOfMonthHelp")}</p>
      )}
      {r.kind === "custom" ? (
        <label class="field">
          {t("repeat.cron")}
          <input
            class="input mono"
            value={r.cron}
            onInput={(e) => onChange({ kind: "custom", cron: e.currentTarget.value })}
          />
          <span class="muted small">{t("schedules.cronHelp")}</span>
        </label>
      ) : (
        <p class="muted small repeat-sum">{summary(r)}</p>
      )}
    </fieldset>
  );
}
