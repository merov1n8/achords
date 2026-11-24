// Account rows of the project form and of "Your own accounts": one row per entry, each tagged
// live or staging (ADR-0067), sent as `{value, env}` entries.

export type Env = "live" | "staging";
export interface Entry {
  value: string;
  env: Env;
}
export type ProjectClass = "secured" | "experimental";

// Channels with their own editor (several logins each, ADR-0047): kept out of the account rows,
// and carried over unchanged when the rows are saved.
export const SITE_CHANNELS = ["wordpress"];

/** One account, page, property or repository of a channel. */
export type Row = { channel: string; value: string; env: Env };

export const toRows = (lists: Record<string, Entry[]>): Row[] =>
  Object.entries(lists)
    .filter(([channel]) => !SITE_CHANNELS.includes(channel))
    .flatMap(([channel, entries]) => entries.map((e) => ({ channel, ...e })));

/** The site lists of `lists`, to send back with edited account rows. */
export const siteLists = <T>(lists: Record<string, T[]>): Record<string, T[]> =>
  Object.fromEntries(Object.entries(lists).filter(([c]) => SITE_CHANNELS.includes(c)));

/** Rows as the API takes them: trimmed, blanks left out, a value listed twice kept once. */
export const toLists = (rows: Row[]): Record<string, Entry[]> => {
  const out: Record<string, Entry[]> = {};
  for (const r of rows) {
    const channel = r.channel.trim().toLowerCase();
    const value = r.value.trim();
    if (!channel || !value) continue;
    const list = out[channel] ?? [];
    if (!list.some((e) => e.value === value)) out[channel] = [...list, { value, env: r.env }];
  }
  return out;
};

export const flipEnv = (env: Env): Env => (env === "live" ? "staging" : "live");

/**
 * The class fields of a project save. An unset class stays unset until the owner picks one;
 * the spend switch only exists on experimental projects, so leaving that class switches it off.
 */
export function classPayload(
  cls: ProjectClass | null,
  spend: boolean,
  hadSpend: boolean,
): { class?: ProjectClass; spend_without_asking?: boolean } {
  if (!cls) return {};
  if (cls === "experimental") return { class: cls, spend_without_asking: spend };
  return { class: cls, ...(hadSpend ? { spend_without_asking: false } : {}) };
}
