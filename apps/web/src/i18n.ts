import en from "./locales/en.json" with { type: "json" };

// All user-facing text lives in locales/<lang>.json (maintainer request): translating the UI
// means adding one file. English is the default and the fallback.
const catalog: Record<string, string> = en;

/** Looks up `key` and fills `{name}` placeholders; unknown keys render as the key itself. */
export function t(key: string, vars: Record<string, string | number> = {}): string {
  const text = catalog[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}
