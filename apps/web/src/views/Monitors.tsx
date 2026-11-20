import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { ago } from "../kanban.ts";
import { usePoll } from "../poll.ts";
import type { IntegrationStatus, Monitor, Project } from "../types.ts";

const STATE_CHIP = { ok: "done", alert: "failed", unknown: "todo" } as const;

/** Heartbeat monitors (ADR-0039): cheap checks that speak up only when something changes. */
export function Monitors() {
  const monitors = usePoll(() => api<Monitor[]>("/api/monitors"), 15000);
  const [confirm, setConfirm] = useState<string>();
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
                  <td>
                    {confirm === m.id ? (
                      <button
                        type="button"
                        class="btn danger"
                        onClick={() =>
                          act(() => api(`/api/monitors/${m.id}`, { method: "DELETE" }))
                        }
                      >
                        {t("schedules.confirmDelete")}
                      </button>
                    ) : (
                      <button type="button" class="btn ghost" onClick={() => setConfirm(m.id)}>
                        {t("schedules.delete")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {error && <p class="error">{error}</p>}
      </div>
      <NewMonitor onCreated={monitors.refresh} />
      <QuietHours />
    </>
  );
}

function NewMonitor(props: { onCreated: () => void }) {
  const empty = {
    name: "",
    kind: "site" as Monitor["kind"],
    url: "https://",
    hours: "48",
    every: "10",
    integration: "",
    tool: "",
    project: "",
    question: "",
    args: "{}",
  };
  const integrations = usePoll(() => api<IntegrationStatus[]>("/api/integrations"), 60000);
  const projects = usePoll(() => api<Project[]>("/api/projects"), 60000);
  const [f, setF] = useState(empty);
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
      await api("/api/monitors", {
        method: "POST",
        body: { name: f.name, kind: f.kind, every_minutes: Number(f.every), config },
      });
      setF(empty);
      props.onCreated();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form class="panel gap-top narrow" onSubmit={submit}>
      <h2>{t("monitors.new")}</h2>
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
      <button type="submit" class="btn primary">
        {t("monitors.create")}
      </button>
      {error && <p class="error">{error}</p>}
    </form>
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
