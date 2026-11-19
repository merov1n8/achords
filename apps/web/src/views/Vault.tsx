import { useState } from "preact/hooks";
import { api } from "../api.ts";
import { ago } from "../kanban.ts";
import { usePoll } from "../poll.ts";
import type { SecretStatus } from "../types.ts";

/** Write-only: values can be set or replaced, never shown (ADR-0012). */
export function Vault() {
  const secrets = usePoll(() => api<SecretStatus[]>("/api/vault"), 10000);
  const [id, setId] = useState("");
  const [value, setValue] = useState("");
  const [confirming, setConfirming] = useState<string>();
  const [error, setError] = useState<string>();

  const save = async (e: Event) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api(`/api/vault/${encodeURIComponent(id.trim())}`, { method: "PUT", body: { value } });
      setValue("");
      setId("");
      secrets.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (secretId: string) => {
    setConfirming(undefined);
    await api(`/api/vault/${encodeURIComponent(secretId)}`, { method: "DELETE" });
    secrets.refresh();
  };

  return (
    <div class="vault">
      <table>
        <thead>
          <tr>
            <th>Secret</th>
            <th>Value</th>
            <th>Updated</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {secrets.data?.map((s) => (
            <tr key={s.id}>
              <td>
                <code>{s.id}</code>
              </td>
              <td class="muted">{s.last4 ? `••••${s.last4}` : "••••"}</td>
              <td class="muted">{s.updatedAt ? ago(s.updatedAt) : ""}</td>
              <td>
                {confirming === s.id ? (
                  <>
                    <button type="button" class="danger" onClick={() => remove(s.id)}>
                      Delete
                    </button>{" "}
                    <button type="button" onClick={() => setConfirming(undefined)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => setConfirming(s.id)}>
                    Delete…
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={save} autocomplete="off">
        <h2>Set or replace a secret</h2>
        <label>
          Id
          <input
            value={id}
            onInput={(e) => setId(e.currentTarget.value)}
            placeholder="telegram.bot-token"
            pattern="[a-z0-9][a-z0-9._\-]{0,63}"
            required
          />
        </label>
        <label>
          Value
          <input
            type="password"
            value={value}
            onInput={(e) => setValue(e.currentTarget.value)}
            autocomplete="new-password"
            required
          />
        </label>
        <button type="submit">Save</button>
        {error && <p class="error">{error}</p>}
      </form>
    </div>
  );
}
