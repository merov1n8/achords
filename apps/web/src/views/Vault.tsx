import { Lock, Plus, Trash } from "lucide-preact";
import { useState } from "preact/hooks";
import { api } from "../api.ts";
import { Confirm, Modal } from "../components/Modal.tsx";
import { t } from "../i18n.ts";
import { ago } from "../kanban.ts";
import { usePoll } from "../poll.ts";
import type { SecretStatus } from "../types.ts";

/** Write-only: values can be set or replaced, never shown (ADR-0012). */
export function Vault() {
  const secrets = usePoll(() => api<SecretStatus[]>("/api/vault"), 10000);
  const [editing, setEditing] = useState<{ id?: string }>();
  const [deleting, setDeleting] = useState<string>();
  const refresh = () => secrets.refresh();
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

/** Add (by id) or replace one secret. Integrations ask for their own secrets where they are set up. */
function SetSecret(props: { id?: string; onClose: () => void; onSaved: () => void }) {
  const [typed, setTyped] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const id = props.id ?? typed.trim();
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
            {t("vault.id")}
            <input
              class="input"
              value={typed}
              onInput={(e) => setTyped(e.currentTarget.value)}
              placeholder="telegram.bot-token"
              pattern="[a-z0-9][a-z0-9._\-]{0,63}"
              required
            />
            <span class="muted small">{t("vault.idHelp")}</span>
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
