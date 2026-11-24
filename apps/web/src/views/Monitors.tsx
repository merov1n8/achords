import { Pencil, Plus, Trash2 } from "lucide-preact";
import { useEffect, useId, useState } from "preact/hooks";
import { api } from "../api.ts";
import { Confirm, Modal } from "../components/Modal.tsx";
import { t } from "../i18n.ts";
import { ago } from "../kanban.ts";
import { usePoll } from "../poll.ts";
import type { IntegrationStatus, Monitor, Project } from "../types.ts";

const STATE_CHIP = { ok: "done", alert: "failed", unknown: "todo" } as const;

/** Heartbeat monitors (ADR-0039): cheap checks that speak up only when something changes. */
export function Monitors() {
  const monitors = usePoll(() => api<Monitor[]>("/api/monitors"), 15000);
  const [confirm, setConfirm] = useState<Monitor>();
  const [editing, setEditing] = useState<Monitor>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      monitors.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const target = (m: Monitor) =>
    m.kind === "site"
      ? String(m.config.url ?? "")
      : m.kind === "integration"
        ? [m.config.integration, m.config.tool, m.config.project].filter(Boolean).join(" · ")
        : t("monitors.stuckTarget", { hours: Number(m.config.hours ?? 48) });
  return (
    <>
      <div class="page-head">
        <h1>{t("nav.monitors")}</h1>
        <button type="button" class="btn primary" onClick={() => setCreating(true)}>
          <Plus class="icon" />
          {t("monitors.new")}
        </button>
      </div>
      <p class="muted">{t("monitors.help")}</p>
      <div class="panel">
        {monitors.data?.length === 0 ? (
          <p class="muted">{t("monitors.empty")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("monitors.name")}</th>
                <th>{t("monitors.checks")}</th>
                <th>{t("monitors.state")}</th>
                <th>{t("monitors.lastCheck")}</th>
                <th>{t("schedules.on")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {monitors.data?.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.name}
                    <div class="muted small">
                      {target(m)} · {t("monitors.every", { n: m.everyMinutes })}
                    </div>
                  </td>
                  <td class="small">{m.detail ?? "–"}</td>
                  <td>
                    <span class={`chip ${STATE_CHIP[m.state]}`}>
                      {t(`monitors.state.${m.state}`)}
                    </span>
                  </td>
                  <td class="muted small">{m.lastCheckAt ? ago(m.lastCheckAt) : "–"}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={m.enabled}
                      aria-label={t("schedules.on")}
                      onChange={() =>
                        act(() =>
                          api(`/api/monitors/${m.id}`, {
                            method: "PUT",
                            body: { enabled: !m.enabled },
                          }),
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
                      onClick={() => setEditing(m)}
                    >
                      <Pencil class="icon" />
                    </button>
                    <button
                      type="button"
                      class="iconbtn"
                      aria-label={t("schedules.delete")}
                      title={t("schedules.delete")}
                      onClick={() => setConfirm(m)}
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
      <QuietHours />
      <StallThresholds />
      {(creating || editing) && (
        <MonitorForm
          key={editing?.id ?? "new"}
          editing={editing}
          onClose={() => {
            setCreating(false);
            setEditing(undefined);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(undefined);
            monitors.refresh();
          }}
        />
      )}
      {confirm && (
        <Confirm
          title={t("monitors.deleteTitle")}
          message={t("monitors.deleteConfirm", { name: confirm.name })}
          confirmLabel={t("schedules.delete")}
          danger
          onConfirm={async () => {
            await api(`/api/monitors/${confirm.id}`, { method: "DELETE" });
            monitors.refresh();
          }}
          onClose={() => setConfirm(undefined)}
        />
      )}
    </>
  );
}

/** New monitor, or edit one (`editing`): same form, PUT instead of POST. */
function MonitorForm(props: {
  editing?: Monitor | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const m0 = props.editing;
  const c0 = m0?.config ?? {};
  const formId = useId();
  const integrations = usePoll(() => api<IntegrationStatus[]>("/api/integrations"), 60000);
  const projects = usePoll(() => api<Project[]>("/api/projects"), 60000);
  const [f, setF] = useState({
    name: m0?.name ?? "",
    kind: m0?.kind ?? ("site" as Monitor["kind"]),
    url: String(c0.url ?? "https://"),
    hours: String(c0.hours ?? 48),
    every: String(m0?.everyMinutes ?? 10),
    integration: String(c0.integration ?? ""),
    tool: String(c0.tool ?? ""),
    project: String(c0.project ?? ""),
    question: String(c0.question ?? ""),
    args: JSON.stringify(c0.args ?? {}),
  });
  const [error, setError] = useState<string>();
  const submit = async (e: Event) => {
    e.preventDefault();
    setError(undefined);
    try {
      const config =
        f.kind === "site"
          ? { url: f.url.trim() }
          : f.kind === "stuck"
            ? { hours: Number(f.hours) }
            : {
                integration: f.integration,
                tool: f.tool.trim(),
                ...(f.project ? { project: f.project } : {}),
                question: f.question.trim(),
                args: JSON.parse(f.args || "{}") as object,
              };
      const body = { name: f.name, kind: f.kind, every_minutes: Number(f.every), config };
      if (!m0) await api("/api/monitors", { method: "POST", body });
      else {
        // An unchanged check keeps its state; sending kind or config would start it fresh.
        const same = f.kind === m0.kind && JSON.stringify(config) === JSON.stringify(m0.config);
        const patch = same ? { name: body.name, every_minutes: body.every_minutes } : body;
        await api(`/api/monitors/${m0.id}`, { method: "PUT", body: patch });
      }
      props.onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal
      title={t(m0 ? "monitors.edit" : "monitors.new")}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" class="btn ghost" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" form={formId} class="btn primary">
            {m0 ? t("common.save") : t("monitors.create")}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        <label class="field">
          {t("monitors.name")}
          <input
            class="input"
            value={f.name}
            onInput={(e) => setF({ ...f, name: e.currentTarget.value })}
          />
        </label>
        <label class="field">
          {t("monitors.kind")}
          <select
            class="input"
            value={f.kind}
            onChange={(e) => setF({ ...f, kind: e.currentTarget.value as Monitor["kind"] })}
          >
            <option value="site">{t("monitors.kind.site")}</option>
            <option value="stuck">{t("monitors.kind.stuck")}</option>
            <option value="integration">{t("monitors.kind.integration")}</option>
          </select>
        </label>
        {f.kind === "integration" ? (
          <>
            <label class="field">
              {t("monitors.integration")}
              <select
                class="input"
                value={f.integration}
                onChange={(e) => setF({ ...f, integration: e.currentTarget.value })}
              >
                <option value="" />
                {(integrations.data ?? []).map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
            <label class="field">
              {t("monitors.tool")}
              <input
                class="input"
                value={f.tool}
                onInput={(e) => setF({ ...f, tool: e.currentTarget.value })}
              />
              <span class="muted small">{t("monitors.toolHelp")}</span>
            </label>
            <label class="field">
              {t("chats.project")}
              <select
                class="input"
                value={f.project}
                onChange={(e) => setF({ ...f, project: e.currentTarget.value })}
              >
                <option value="" />
                {(projects.data ?? []).map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label class="field">
              {t("monitors.question")}
              <textarea
                class="input"
                rows={2}
                value={f.question}
                onInput={(e) => setF({ ...f, question: e.currentTarget.value })}
              />
            </label>
            <label class="field">
              {t("monitors.args")}
              <input
                class="input mono"
                value={f.args}
                onInput={(e) => setF({ ...f, args: e.currentTarget.value })}
              />
            </label>
          </>
        ) : f.kind === "site" ? (
          <label class="field">
            {t("monitors.url")}
            <input
              class="input"
              value={f.url}
              onInput={(e) => setF({ ...f, url: e.currentTarget.value })}
            />
          </label>
        ) : (
          <label class="field">
            {t("monitors.hours")}
            <input
              class="input"
              inputMode="numeric"
              value={f.hours}
              onInput={(e) => setF({ ...f, hours: e.currentTarget.value })}
            />
          </label>
        )}
        <label class="field">
          {t("monitors.everyLabel")}
          <input
            class="input"
            inputMode="numeric"
            value={f.every}
            onInput={(e) => setF({ ...f, every: e.currentTarget.value })}
          />
        </label>
        {error && <p class="error">{error}</p>}
      </form>
    </Modal>
  );
}

function QuietHours() {
  const [hours, setHours] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();
  useEffect(() => {
    api<{ hours: string }>("/api/monitors/quiet")
      .then((r) => setHours(r.hours))
      .catch(() => {});
  }, []);
  const save = async (e: Event) => {
    e.preventDefault();
    try {
      await api("/api/monitors/quiet", { method: "PUT", body: { hours } });
      setStatus({ ok: true, text: t("projects.saved") });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  };
  return (
    <form class="panel gap-top narrow" onSubmit={save}>
      <h2>{t("monitors.quiet")}</h2>
      <label class="field">
        <input
          class="input"
          placeholder="22-7"
          aria-label={t("monitors.quiet")}
          value={hours}
          onInput={(e) => setHours(e.currentTarget.value)}
        />
        <span class="muted small">{t("monitors.quietHelp")}</span>
      </label>
      <button type="submit" class="btn">
        {t("common.save")}
      </button>
      {status && <span class={status.ok ? "muted" : "error"}> {status.text}</span>}
    </form>
  );
}

// ADR-0066: when the boss is told about stuck work.
function StallThresholds() {
  const [v, setV] = useState({ minutes: "", percent: "" });
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();
  useEffect(() => {
    api<{ minutes: number; percent: number }>("/api/monitors/stalls")
      .then((r) => setV({ minutes: String(r.minutes), percent: String(r.percent) }))
      .catch(() => {});
  }, []);
  const save = async (e: Event) => {
    e.preventDefault();
    try {
      await api("/api/monitors/stalls", {
        method: "PUT",
        body: { minutes: Number(v.minutes), percent: Number(v.percent) },
      });
      setStatus({ ok: true, text: t("projects.saved") });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  };
  return (
    <form class="panel gap-top narrow" onSubmit={save}>
      <h2>{t("monitors.stalls")}</h2>
      <label class="field">
        {t("monitors.stallMinutes")}
        <input
          class="input"
          type="number"
          min={1}
          max={1440}
          value={v.minutes}
          onInput={(e) => setV({ ...v, minutes: e.currentTarget.value })}
        />
      </label>
      <label class="field">
        {t("monitors.stallPercent")}
        <input
          class="input"
          type="number"
          min={1}
          max={100}
          value={v.percent}
          onInput={(e) => setV({ ...v, percent: e.currentTarget.value })}
        />
      </label>
      <p class="muted small">{t("monitors.stallsHelp")}</p>
      <button type="submit" class="btn">
        {t("common.save")}
      </button>
      {status && <span class={status.ok ? "muted" : "error"}> {status.text}</span>}
    </form>
  );
}
