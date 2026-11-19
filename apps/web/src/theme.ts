export type ThemeChoice = "system" | "light" | "dark";
export type Accent = "violet" | "teal";
export interface Appearance {
  theme: ThemeChoice;
  accent: Accent;
}

const KEY = "achords.appearance";
const DEFAULT: Appearance = { theme: "system", accent: "violet" };

export function parseAppearance(raw: string | null): Appearance {
  try {
    const v = JSON.parse(raw ?? "") as Partial<Appearance>;
    return {
      theme: v.theme === "light" || v.theme === "dark" ? v.theme : "system",
      accent: v.accent === "teal" ? "teal" : "violet",
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): "light" | "dark" {
  return choice === "system" ? (systemDark ? "dark" : "light") : choice;
}

// Per browser (a display preference), so storage failures only mean "back to defaults".
export function loadAppearance(): Appearance {
  try {
    return parseAppearance(localStorage.getItem(KEY));
  } catch {
    return { ...DEFAULT };
  }
}

export function saveAppearance(a: Appearance): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    // private mode etc.: the choice simply is not remembered
  }
  applyAppearance(a);
}

export function applyAppearance(a: Appearance): void {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = resolveTheme(a.theme, dark);
  document.documentElement.dataset.accent = a.accent;
}
