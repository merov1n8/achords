import { KeyRound, Plus, Trash2 } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { Modal } from "../components/Modal.tsx";
import { Sites } from "../components/Sites.tsx";
import { t } from "../i18n.ts";
import { usePoll } from "../poll.ts";
import type { IntegrationStatus } from "../types.ts";
import { CHANNELS, type Row, siteLists, toLists, toRows } from "./Projects.tsx";
import { SecretInput } from "./SecretInput.tsx";

/** What each integration still needs, in plain words. */
function needs(s: IntegrationStatus): string[] {
  const out: string[] = [];
  if (!s.commandFound) out.push(t("integrations.noCommand", { command: s.command ?? "" }));
  if (s.missingSecrets.some((id) => id.startsWith("google-")))
    out.push(t("integrations.googleSignIn"));
  else if (s.missingSecrets.length)
    out.push(t("integrations.missingSecrets", { ids: s.missingSecrets.join(", ") }));
  if (s.kind === "client" && !s.projectsReady.length) out.push(t("integrations.noProjectSecrets"));
  if (s.scoped && s.kind !== "client" && !s.projectsScoped.length)
    out.push(t("integrations.noAccounts"));
  return out;
}

/** One read call through the same path agents use; per-client ones run for a chosen project. */
function TestButton(props: { s: IntegrationStatus }) {
  const { s } = props;
  const projects = [...new Set([...s.projectsReady, ...s.projectsScoped])];
  const needsProject = s.perProject || s.scoped;
  const [project, setProject] = useState(projects[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ ok: boolean; text: string }>();
  if (!s.testable) return null;
  const run = async () => {
    setBusy(true);
    setOut(undefined);
    try {
      setOut(
        await api<{ ok: boolean; text: string }>(`/api/integrations/${s.id}/test`, {
          method: "POST",
          body: needsProject ? { project } : {},
        }),
      );
    } catch (err) {
      setOut({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="test">
      <div class="row">
        {needsProject && projects.length > 1 && (
          <select
            class="input small"
            aria-label={t("chats.project")}
            value={project}
            onChange={(e) => setProject(e.currentTarget.value)}
          >
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          class="btn ghost"
          disabled={busy || (needsProject && !project)}
          onClick={run}
        >
          {busy ? t("integrations.testing") : t("integrations.test")}
        </button>
      </div>
      {out && (
        <div class={`small pre ${out.ok ? "muted" : "error"}`}>
          {out.ok ? "✓ " : "✗ "}
          {out.text}
        </div>
      )}
    </div>
  );
}

function Status(props: { s: IntegrationStatus }) {
  return props.s.ready ? (
    <span class="chip done">{t("integrations.ready")}</span>
  ) : (
    <span class={`chip ${props.s.usedBy.length ? "failed" : "todo"}`}>
      {t("integrations.setup")}
    </span>
  );
}

/** One table of integrations; `extra` adds the group's own cell (sign-in, sites, …). */
function Group(props: {
  title: string;
  help: string;
  items: IntegrationStatus[];
  extra: (s: IntegrationStatus) => preact.ComponentChildren;
}) {
  if (!props.items.length) return null;
  return (
    <section class="gap-top">
      <h2>{props.title}</h2>
      <p class="muted small">{props.help}</p>
      <div class="panel">
        <table>
          <thead>
            <tr>
              <th>{t("integrations.name")}</th>
              <th>{t("integrations.usedBy")}</th>
              <th>{t("integrations.status")}</th>
              <th>{t("integrations.details")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {props.items.map((s) => (
              <tr key={s.id}>
                <td>
                  <strong>{s.name}</strong>
                </td>
                <td>{s.usedBy.join(", ") || <span class="muted">-</span>}</td>
                <td>
                  <Status s={s} />
                </td>
                <td class="small">
                  {needs(s).map((m) => (
                    <div key={m}>{m}</div>
                  ))}
                  {props.extra(s)}
                </td>
                <td class="actions">
                  <TestButton s={s} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The token of a shared sign-in that is typed in (Meta); Google comes from `achords connect`. */
function SetToken(props: { s: IntegrationStatus; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const ids = props.s.missingSecrets.filter((id) => !id.startsWith("google-"));
  if (!ids.length) return null;
  return (
    <>
      <button type="button" class="btn" onClick={() => setOpen(true)}>
        <KeyRound class="icon" />
        {t("integrations.setToken")}
      </button>
      {open && (
        <Modal title={props.s.name} onClose={() => setOpen(false)}>
          {ids.map((id) => (
            <SecretInput
              key={id}
              id={id}
              label={t("integrations.setSecret")}
              set={false}
              onSaved={() => {
                setOpen(false);
                props.onSaved();
              }}
            />
          ))}
        </Modal>
      )}
    </>
  );
}

/** The owner's own pages and properties (ADR-0042): what work without a client may use. */
function OwnAccounts(props: { onSaved: () => void }) {
  const [lists, setLists] = useState<Record<string, string[]>>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const load = () =>
    api<{ integrations: Record<string, string[]> }>("/api/accounts")
      .then((r) => setLists(r.integrations))
      .catch((err: Error) => setError(err.message));
  useEffect(() => {
    load();
  }, []);
  const save = async (rows: Row[]) => {
    setError(undefined);
    try {
      // Sites are edited below on their own: send the current ones back unchanged.
      const current = await api<{ integrations: Record<string, string[]> }>("/api/accounts");
      const out = await api<{ integrations: Record<string, string[]> }>("/api/accounts", {
        method: "PUT",
        body: { integrations: { ...toLists(rows), ...siteLists(current.integrations) } },
      });
      setLists(out.integrations);
      props.onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const rows = lists ? toRows(lists) : [];
  const label = (c: string) => CHANNELS.find((x) => x.id === c)?.label ?? c;
  return (
    <section class="gap-top">
      <div class="page-head">
        <div>
          <h2>{t("integrations.own")}</h2>
          <p class="muted small">{t("integrations.ownHelp")}</p>
        </div>
        <button type="button" class="btn primary" onClick={() => setAdding(true)}>
          <Plus class="icon" />
          {t("projects.addAccount")}
        </button>
      </div>
      <div class="panel">
        {rows.length === 0 ? (
          <p class="muted">{t("integrations.ownEmpty")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("projects.channel")}</th>
                <th>{t("projects.accountValue")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.channel}-${r.value}`}>
                  <td>{label(r.channel)}</td>
                  <td>
                    <code>{r.value}</code>
                  </td>
                  <td class="actions">
                    <button
                      type="button"
                      class="iconbtn"
                      aria-label={t("common.remove")}
                      title={t("common.remove")}
                      onClick={() => save(rows.filter((_, j) => j !== i))}
                    >
                      <Trash2 class="icon" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Sites slug="own" />
      </div>
      {error && <p class="error">{error}</p>}
      {adding && (
        <AddAccount
          onClose={() => setAdding(false)}
          onAdd={async (row) => {
            await save([...rows, row]);
            setAdding(false);
          }}
        />
      )}
    </section>
  );
}

function AddAccount(props: { onClose: () => void; onAdd: (row: Row) => Promise<void> }) {
  const [row, setRow] = useState<Row>({ channel: CHANNELS[0]?.id ?? "", value: "" });
  return (
    <Modal
      title={t("projects.addAccount")}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" class="btn ghost" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" form="add-account" class="btn primary" disabled={!row.value.trim()}>
            {t("card.add")}
          </button>
        </>
      }
    >
      <form
        id="add-account"
        onSubmit={(e) => {
          e.preventDefault();
          props.onAdd(row);
        }}
      >
        <label class="field">
          {t("projects.channel")}
          <select
            class="input"
            value={row.channel}
            onChange={(e) => setRow({ ...row, channel: e.currentTarget.value })}
          >
            {CHANNELS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label class="field">
          {t("projects.accountValue")}
          <input
            class="input"
            value={row.value}
            onInput={(e) => setRow({ ...row, value: e.currentTarget.value })}
          />
        </label>
      </form>
    </Modal>
  );
}

export function Integrations() {
  const list = usePoll(() => api<IntegrationStatus[]>("/api/integrations"), 30000);
  const of = (kind: IntegrationStatus["kind"]) => (list.data ?? []).filter((s) => s.kind === kind);
  return (
    <>
      <div class="page-head">
        <h1>{t("nav.integrations")}</h1>
      </div>
      <p class="muted">{t("integrations.help")}</p>
      <Group
        title={t("integrations.group.account")}
        help={t("integrations.group.accountHelp")}
        items={of("account")}
        extra={(s) => <SetToken s={s} onSaved={list.refresh} />}
      />
      <OwnAccounts onSaved={list.refresh} />
      <Group
        title={t("integrations.group.client")}
        help={t("integrations.group.clientHelp")}
        items={of("client")}
        extra={(s) =>
          s.sites.map((site) => (
            <div key={`${site.project}-${site.url}`}>
              {site.project === "own" ? t("integrations.ownShort") : site.project}: {site.url}{" "}
              <span class={site.ready ? "muted" : "error"}>
                {site.ready ? "✓" : t("sites.needsLogin")}
              </span>
            </div>
          ))
        }
      />
      <Group
        title={t("integrations.group.local")}
        help={t("integrations.group.localHelp")}
        items={of("local")}
        extra={() => null}
      />
      {list.error && <p class="error">{list.error}</p>}
    </>
  );
}
