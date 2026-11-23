// The Achords guide: rules for every agent and the boss, appended to each run's system prompt.
// The owner's copy lives in the achords home; without one the shipped default applies.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT = new URL("../../../seed/GUIDE.md", import.meta.url).pathname;
export const GUIDE_LIMIT = 20_000;

export const guidePath = (home: string) => join(home, "GUIDE.md");

export function readGuide(home: string): { text: string; custom: boolean } {
  const own = guidePath(home);
  if (existsSync(own)) return { text: readFileSync(own, "utf8"), custom: true };
  return { text: existsSync(DEFAULT) ? readFileSync(DEFAULT, "utf8") : "", custom: false };
}

/** Saves the owner's guide; an empty text goes back to the default. */
export function writeGuide(home: string, text: string): void {
  if (!text.trim()) {
    rmSync(guidePath(home), { force: true });
    return;
  }
  writeFileSync(guidePath(home), text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
}
