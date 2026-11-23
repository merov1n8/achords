import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { t } from "../i18n.ts";

/** Settings → Storage: how long images dropped into chats are kept. */
export function Storage() {
  const [saved, setSaved] = useState<number | null>();
  const [value, setValue] = useState("");
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const show = (keepDays: number | null) => {
    setSaved(keepDays);
    setValue(keepDays === null ? "" : String(keepDays));
  };
  useEffect(() => {
    api<{ keepDays: number | null }>("/api/settings/images").then(
      (r) => show(r.keepDays),
      (e: Error) => setError(e.message),
    );
  }, []);
  const save = async (e: Event) => {
    e.preventDefault();
    setError(undefined);
    setNote(undefined);
    try {
      const keepDays = value.trim() ? Number(value) : null;
      const r = await api<{ keepDays: number | null }>("/api/settings/images", {
        method: "PUT",
        body: { keepDays },
      });
      show(r.keepDays);
      setNote(t("storage.saved"));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <>
      <div class="page-head">
        <h1>{t("nav.storage")}</h1>
      </div>
      <form class="panel" onSubmit={save}>
        <label class="field">
          {t("storage.imagesKeep")}
          <input
            class="input"
            type="number"
            min={1}
            max={3650}
            inputMode="numeric"
            value={value}
            placeholder={t("storage.forever")}
            onInput={(e) => setValue(e.currentTarget.value)}
          />
          <span class="muted small">{t("storage.imagesHelp")}</span>
        </label>
        <div class="row">
          <button
            type="submit"
            class="btn primary"
            disabled={saved === undefined || value === (saved === null ? "" : String(saved))}
          >
            {t("storage.save")}
          </button>
          {note && <span class="muted">{note}</span>}
        </div>
        {error && <p class="error">{error}</p>}
      </form>
    </>
  );
}
