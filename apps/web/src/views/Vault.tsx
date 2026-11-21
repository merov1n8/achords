import { Lock, Plus, Trash } from "lucide-preact";
import { useState } from "preact/hooks";
import { api } from "../api.ts";
import { Confirm, Modal } from "../components/Modal.tsx";
import { t } from "../i18n.ts";
import { ago } from "../kanban.ts";
import { usePoll } from "../poll.ts";
import type { IntegrationStatus, SecretStatus } from "../types.ts";

const OTHER = "";

/** What the integrations still miss: offered first when adding a secret. */
function suggestions(list: IntegrationStatus[]): { id: string; label: string }[] {
  const out = new Map<string, string>();
  for (const s of list) {
    // Google comes from the sign-in (achords connect google), not typed values.
    for (const id of s.missingSecrets.filter((x) => !x.startsWith("google-"))) out.set(id, s.name);
    for (const site of s.sites) {
      for (const id of site.missing) out.set(id, `${s.name}: ${site.url}`);
    }
  }
  return [...out].map(([id, label]) => ({ id, label }));
}

/** Write-only: values can be set or replaced, never shown (ADR-0012). */
export function Vault() {
  const secrets = usePoll(() => api<SecretStatus[]>("/api/vault"), 10000);
  const integrations = usePoll(() => api<IntegrationStatus[]>("/api/integrations"), 30000);
  const [editing, setEditing] = useState<{ id?: string }>();
  const [deleting, setDeleting] = useState<string>();
  const refresh = () => {
    secrets.refresh();
    integrations.refresh();
  };
  return (
    <>
      <div class="page-head">
        <h1>{t("nav.vault")}</h1>
        <button type="button" class="btn primary" onClick={() => setEditing({})}>
          <Plus class="icon" />
          {t("vault.add")}
        </button>
      </div>
      <p class="muted">{t("vault.hint")}</p>
      <div class="panel">
        <table>
          <thead>
            <tr>
              <th>{t("vault.secret")}</th>
              <th>{t("vault.value")}</th>
              <th>{t("vault.updated")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {secrets.data?.map((s) => (
              <tr key={s.id}>
                <td>
                  <code>{s.id}</code>
                </td>
                <td class="muted">
                  <Lock class="icon" /> {s.last4 ? `••••${s.last4}` : "••••"}
                </td>
                <td class="muted">{s.updatedAt ? ago(s.updatedAt) : ""}</td>
                <td class="actions">
                  <button type="button" class="btn ghost" onClick={() => setEditing({ id: s.id })}>
                    {t("vault.replace")}
                  </button>
                  <button
                    type="button"
                    class="iconbtn"
                    onClick={() => setDeleting(s.id)}
                    aria-label={t("vault.delete")}
                    title={t("vault.delete")}
                  >
                    <Trash class="icon" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <SetSecret
          {...(editing.id ? { id: editing.id } : {})}
          suggested={suggestions(integrations.data ?? [])}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            refresh();
          }}
        />
      )}
      {deleting && (
        <Confirm
          title={t("vault.deleteTitle")}
          message={t("vault.deleteConfirm", { id: deleting })}
          confirmLabel={t("vault.confirmDelete")}
          danger
          onConfirm={async () => {
            await api(`/api/vault/${encodeURIComponent(deleting)}`, { method: "DELETE" });
            refresh();
          }}
          onClose={() => setDeleting(undefined)}
        />
      )}
    </>
  );
}

/** Add (choose what it is for, or type an id) or replace one secret. */
function SetSecret(props: {
  id?: string;
  suggested: { id: string; label: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [choice, setChoice] = useState(props.id ?? props.suggested[0]?.id ?? OTHER);
  const [typed, setTyped] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const id = props.id ?? (choice === OTHER ? typed.trim() : choice);
  const save = async (e: Event) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api(`/api/vault/${encodeURIComponent(id)}`, { method: "PUT", body: { value } });
      props.onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal
      title={props.id ? t("vault.replaceTitle", { id: props.id }) : t("vault.add")}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" class="btn ghost" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" form="set-secret" class="btn primary" disabled={!id || !value}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <form id="set-secret" onSubmit={save} autocomplete="off">
        {!props.id && (
          <label class="field">
            {t("vault.for")}
            <select class="input" value={choice} onChange={(e) => setChoice(e.currentTarget.value)}>
              {props.suggested.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} ({s.id})
                </option>
              ))}
              <option value={OTHER}>{t("vault.other")}</option>
            </select>
            {props.suggested.length === 0 && (
              <span class="muted small">{t("vault.nothingMissing")}</span>
            )}
          </label>
        )}
        {!props.id && choice === OTHER && (
          <label class="field">
            {t("vault.id")}
            <input
              class="input"
              value={typed}
              onInput={(e) => setTyped(e.currentTarget.value)}
              placeholder="telegram.bot-token"
              pattern="[a-z0-9][a-z0-9._\-]{0,63}"
              required
            />
          </label>
        )}
        <label class="field">
          {t("vault.value")}
          <input
            class="input"
            type="password"
            value={value}
            onInput={(e) => setValue(e.currentTarget.value)}
            autocomplete="new-password"
            required
          />
        </label>
        {error && <p class="error">{error}</p>}
      </form>
    </Modal>
  );
}
