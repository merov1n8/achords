import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { t } from "../i18n.ts";

type Guide = { text: string; custom: boolean };

/** Settings → Guide: rules every agent and the boss get with each run. */
export function Guide() {
  const [guide, setGuide] = useState<Guide>();
  const [text, setText] = useState("");
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const show = (g: Guide) => {
    setGuide(g);
    setText(g.text);
  };
  useEffect(() => {
    api<Guide>("/api/guide").then(show, (e: Error) => setError(e.message));
  }, []);
  const save = async (value: string) => {
    setError(undefined);
    setNote(undefined);
    try {
      show(await api<Guide>("/api/guide", { method: "PUT", body: { text: value } }));
      setNote(t("guide.saved"));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <>
      <div class="page-head">
        <h1>{t("nav.guide")}</h1>
      </div>
      <p class="muted">{t("guide.help")}</p>
      <div class="panel">
        <label class="field">
          <textarea
            class="input mono guide-text"
            rows={18}
            value={text}
            onInput={(e) => setText(e.currentTarget.value)}
          />
          <span class="muted small">{guide?.custom ? t("guide.custom") : t("guide.default")}</span>
        </label>
        <div class="row">
          <button
            type="button"
            class="btn primary"
            disabled={!guide || text === guide.text}
            onClick={() => save(text)}
          >
            {t("guide.save")}
          </button>
          {guide?.custom && (
            <button type="button" class="btn" onClick={() => save("")}>
              {t("guide.reset")}
            </button>
          )}
          {note && <span class="muted">{note}</span>}
        </div>
        {error && <p class="error">{error}</p>}
      </div>
    </>
  );
}
