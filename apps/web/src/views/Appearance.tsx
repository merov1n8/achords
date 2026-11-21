import { useState } from "preact/hooks";
import { t } from "../i18n.ts";
import {
  ACCENTS,
  DARK_BASES,
  LIGHT_BASES,
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
    ["system", ["paper", "graphite"]],
    ["light", ["paper"]],
    ["dark", ["graphite"]],
  ];
  const bases = (mode: "light" | "dark") => {
    const key = mode === "light" ? "lightBase" : "darkBase";
    const list: string[] = mode === "light" ? LIGHT_BASES : DARK_BASES;
    return (
      <>
        <h2 class="gap-top">{t(`appearance.${mode}Base`)}</h2>
        <div class="choices">
          {list.map((id) => (
            <button
              key={id}
              type="button"
              class={`choice ${a[key] === id ? "sel" : ""}`}
              onClick={() => set({ [key]: id })}
              aria-pressed={a[key] === id}
            >
              <span class="preview">
                <span class={`base-${id}`} />
              </span>
              <strong>{t(`appearance.base.${id}`)}</strong>
            </button>
          ))}
        </div>
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
      {bases("light")}
      {bases("dark")}
    </>
  );
}
