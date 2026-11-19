import { useState } from "preact/hooks";
import { t } from "../i18n.ts";
import { type Accent, loadAppearance, saveAppearance, type ThemeChoice } from "../theme.ts";

export function Appearance() {
  const [a, setA] = useState(loadAppearance());
  const set = (next: Partial<typeof a>) => {
    const v = { ...a, ...next };
    setA(v);
    saveAppearance(v);
  };
  const themes: [ThemeChoice, string[]][] = [
    ["system", ["light", "dark"]],
    ["light", ["light"]],
    ["dark", ["dark"]],
  ];
  const accents: Accent[] = ["violet", "teal"];
  return (
    <>
      <div class="page-head">
        <h1>{t("nav.appearance")}</h1>
      </div>
      <h2>{t("appearance.theme")}</h2>
      <p class="muted">{t("appearance.themeHint")}</p>
      <div class="choices">
        {themes.map(([id, swatches]) => (
          <button
            key={id}
            type="button"
            class={`choice ${a.theme === id ? "sel" : ""}`}
            onClick={() => set({ theme: id })}
            aria-pressed={a.theme === id}
          >
            <span class="preview">
              {swatches.map((s) => (
                <span key={s} class={s} />
              ))}
            </span>
            <strong>{t(`appearance.theme.${id}`)}</strong>
          </button>
        ))}
      </div>
      <h2 class="gap-top">{t("appearance.accent")}</h2>
      <div class="choices">
        {accents.map((id) => (
          <button
            key={id}
            type="button"
            class={`choice ${a.accent === id ? "sel" : ""}`}
            onClick={() => set({ accent: id })}
            aria-pressed={a.accent === id}
          >
            <span class="preview">
              <span class={id} />
            </span>
            <strong>{t(`appearance.accent.${id}`)}</strong>
          </button>
        ))}
      </div>
    </>
  );
}
