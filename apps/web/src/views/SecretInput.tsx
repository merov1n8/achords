import { Lock } from "lucide-preact";
import { useState } from "preact/hooks";
import { api } from "../api.ts";
import { t } from "../i18n.ts";

/**
 * Sets one vault secret (write-only, ADR-0012): shows whether it is set, never its value.
 * `type="url"` etc. only changes the keyboard; every value is stored as a secret.
 */
export function SecretInput(props: {
  id: string;
  label: string;
  set: boolean;
  type?: "password" | "url" | "text";
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const save = async () => {
    setError(undefined);
    try {
      await api(`/api/vault/${encodeURIComponent(props.id)}`, {
        method: "PUT",
        body: { value: value.trim() },
      });
      setValue("");
      props.onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div class="field">
      <span>
        {props.label} <code class="muted small">{props.id}</code>{" "}
        {props.set && (
          <span class="muted small">
            <Lock class="icon" /> {t("secretInput.set")}
          </span>
        )}
      </span>
      <div class="row">
        {props.type && props.type !== "password" ? (
          <input
            class="input"
            type="text"
            inputMode={props.type === "url" ? "url" : "text"}
            autocomplete="off"
            placeholder={props.set ? t("secretInput.replace") : ""}
            aria-label={props.label}
            value={value}
            onInput={(e) => setValue(e.currentTarget.value)}
          />
        ) : (
          <input
            class="input"
            type="password"
            autocomplete="new-password"
            placeholder={props.set ? t("secretInput.replace") : ""}
            aria-label={props.label}
            value={value}
            onInput={(e) => setValue(e.currentTarget.value)}
          />
        )}
        <button type="button" class="btn" disabled={!value.trim()} onClick={save}>
          {t("common.save")}
        </button>
      </div>
      {error && <span class="error small">{error}</span>}
    </div>
  );
}
