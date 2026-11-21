import { useState } from "preact/hooks";
import { t } from "../i18n.ts";
import {
  ACCENTS,
  type Appearance as Look,
  loadAppearance,
  saveAppearance,
  type ThemeChoice,
} from "../theme.ts";

export function Appearance() {
  const [a, setA] = useState(loadAppearance());
  const set = (next: Partial<Look>) => {
    const v = { ...a, ...next };
    setA(v);
    saveAppearance(v);
  };
  const themes: [ThemeChoice, string[]][] = [
    ["system", ["warm", "graphite"]],
    ["light", ["warm"]],
    ["dark", ["graphite"]],
  ];
  const accents = (mode: "light" | "dark") => {
    return (
      <>
        <h2 class="gap-top">{t(`appearance.${mode}Accent`)}</h2>
        <div class="row wrap">
          {ACCENTS.map((id) => {
            const k = mode === "light" ? "lightAccent" : "darkAccent";
            return (
              <button
                key={id}
                type="button"
                class={`sw ${mode}-${id}`}
                title={t(`appearance.accent.${id}`)}
                aria-label={t(`appearance.accent.${id}`)}
                onClick={() => set({ [k]: id })}
                aria-pressed={a[k] === id}
              />
            );
          })}
        </div>
      </>
    );
  };
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
                <span key={s} class={`base-${s}`} />
              ))}
            </span>
            <strong>{t(`appearance.theme.${id}`)}</strong>
          </button>
        ))}
      </div>
      {accents("light")}
      {accents("dark")}
    </>
  );
}
