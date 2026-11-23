import en from "../locales/en.json" with { type: "json" };

// All user-facing text (web UI, Telegram bot texts and buttons) lives in locales/<lang>.json
// (maintainer request): translating means adding one file, no code changes. English is the
// default and the fallback for missing keys.
const catalogs: Record<string, Record<string, string>> = { en };
let active: Record<string, string> = en;

export function setLanguage(lang: string): void {
  active = catalogs[lang] ?? en;
}

/** Looks up `key` and fills `{name}` placeholders; unknown keys render as the key itself. */
export function t(key: string, vars: Record<string, string | number> = {}): string {
  const text = active[key] ?? en[key as keyof typeof en] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export const catalog = en;
export { isHungarian, speakable } from "./speech.ts";
