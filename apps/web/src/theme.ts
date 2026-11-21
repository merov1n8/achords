export type ThemeChoice = "system" | "light" | "dark";
export type LightBase = "paper" | "warm" | "slate";
export type DarkBase = "void" | "graphite" | "midnight";
export type Accent = "violet" | "teal" | "amber" | "rose";
export interface Appearance {
  theme: ThemeChoice;
  lightBase: LightBase;
  darkBase: DarkBase;
  lightAccent: Accent;
  darkAccent: Accent;
}

export const LIGHT_BASES: LightBase[] = ["paper", "warm", "slate"];
export const DARK_BASES: DarkBase[] = ["void", "graphite", "midnight"];
export const ACCENTS: Accent[] = ["violet", "teal", "amber", "rose"];

const KEY = "achords.appearance";
const DEFAULT: Appearance = {
  theme: "system",
  lightBase: "warm",
  darkBase: "graphite",
  lightAccent: "violet",
  darkAccent: "teal",
};

const pick = <T extends string>(list: T[], v: unknown, fallback: T): T =>
  list.includes(v as T) ? (v as T) : fallback;

export function parseAppearance(raw: string | null): Appearance {
  try {
    const v = JSON.parse(raw ?? "") as Record<string, unknown>;
    // The old shape { theme, accent } had one accent for both modes.
    const old = v.accent;
    return {
      theme: v.theme === "light" || v.theme === "dark" ? v.theme : "system",
      lightBase: pick(LIGHT_BASES, v.lightBase, DEFAULT.lightBase),
      darkBase: pick(DARK_BASES, v.darkBase, DEFAULT.darkBase),
      lightAccent: pick(ACCENTS, v.lightAccent ?? old, DEFAULT.lightAccent),
      darkAccent: pick(ACCENTS, v.darkAccent ?? old, DEFAULT.darkAccent),
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

/** The data-* attributes for <html>: base and accent follow the resolved mode. */
export function appearanceAttrs(a: Appearance, systemDark: boolean) {
  const theme = resolveTheme(a.theme, systemDark);
  return theme === "dark"
    ? { theme, base: a.darkBase, accent: a.darkAccent }
    : { theme, base: a.lightBase, accent: a.lightAccent };
}

export function applyAppearance(a: Appearance): void {
  const attrs = appearanceAttrs(a, matchMedia("(prefers-color-scheme: dark)").matches);
  Object.assign(document.documentElement.dataset, attrs);
}

const SIDEBAR_KEY = "achords.sidebar";
export function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "collapsed";
  } catch {
    return false;
  }
}
export function saveCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "open");
  } catch {
    // not remembered
  }
}
