import { Plus } from "lucide-preact";
import { useState } from "preact/hooks";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { usePoll } from "../poll.ts";
import type { Agent, Project } from "../types.ts";

type Schedule = {
  id: string;
  name: string;
  cron: string;
  agentId: string;
  title: string;
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
      {view === "list" && <List schedules={schedules.data ?? []} onChange={schedules.refresh} />}
      {view === "today" && <Timeline days={1} />}
      {view === "week" && <Timeline days={7} />}
      {creating && (
        <NewSchedule
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

function List({ schedules, onChange }: { schedules: Schedule[]; onChange: () => void }) {
  const [confirm, setConfirm] = useState<string>();
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
              <td>
                <code>{s.cron}</code>
              </td>
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
              <td>
                {confirm === s.id ? (
                  <button
                    type="button"
                    class="btn danger"
                    onClick={() => act(() => api(`/api/schedules/${s.id}`, { method: "DELETE" }))}
                  >
                    {t("schedules.confirmDelete")}
                  </button>
                ) : (
                  <button type="button" class="btn ghost" onClick={() => setConfirm(s.id)}>
                    {t("schedules.delete")}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p class="error">{error}</p>}
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

function NewSchedule(props: { onClose: () => void; onCreated: () => void }) {
  const agents = usePoll(() => api<Agent[]>("/api/agents"), 60000);
  const projects = usePoll(() => api<Project[]>("/api/projects"), 60000);
  const [f, setF] = useState({
    name: "",
    cron: "0 9 * * 1-5",
    agentId: "",
    title: "",
    instructions: "",
    project: "",
    enabled: true,
  });
  const [error, setError] = useState<string>();
  const workers = (agents.data ?? []).filter((a) => a.id !== "boss");
  const submit = async (e: Event) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api("/api/schedules", {
        method: "POST",
        body: { ...f, agentId: f.agentId || workers[0]?.id, project: f.project || null },
      });
      props.onCreated();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const field = (key: "name" | "cron" | "title", label: string, help?: string) => (
    <label class="field">
      {label}
      <input
        class={`input ${key === "cron" ? "mono" : ""}`}
        value={f[key]}
        onInput={(e) => setF({ ...f, [key]: e.currentTarget.value })}
      />
      {help && <span class="muted small">{help}</span>}
    </label>
  );
  return (
    <form class="panel gap-top narrow" onSubmit={submit}>
      <div class="page-head">
        <h2>{t("schedules.new")}</h2>
        <button type="button" class="btn ghost" onClick={props.onClose}>
          {t("common.close")}
        </button>
      </div>
      {field("name", t("schedules.name"))}
      {field("cron", t("schedules.when"), t("schedules.cronHelp"))}
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
      <button type="submit" class="btn primary">
        {t("schedules.create")}
      </button>
      {error && <p class="error">{error}</p>}
    </form>
  );
}
