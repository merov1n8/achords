// ADR-0069: notes to running work. The gateway puts each note in its own file in the running
// task's inbox folder; the CLI's PostToolUse and Stop hook (inbox-hook.ts) claims the files with
// an atomic rename and hands their text to the model; the gateway then marks them delivered.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One note's text is cut to this; a hook delivers at most HOOK_CHARS at once (CLI cap 10,000). */
export const NOTE_CHARS = 4000;
export const HOOK_CHARS = 9000;

const NOTE = /^note-(\d+)\.txt$/;
const TAKEN = /^taken-(\d+)\.txt$/;

export const inboxDir = (home: string, taskId: string) => join(home, "run", "inbox", taskId);

export const HOOK_SCRIPT = new URL("./inbox-hook.ts", import.meta.url).pathname;

/** The hook command; the CLI appends nothing, so `post` or `stop` is part of it. */
export function hookCommand(node: string, dir: string, mode: "post" | "stop"): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `${q(node)} --disable-warning=ExperimentalWarning ${q(HOOK_SCRIPT)} ${q(dir)} ${mode}`;
}

/** Written whole and renamed in, so a hook never reads half a note. */
export function putNote(dir: string, id: number, text: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.tmp-${id}`);
  writeFileSync(tmp, text.length > NOTE_CHARS ? `${text.slice(0, NOTE_CHARS)}…` : text, {
    mode: 0o600,
  });
  renameSync(tmp, join(dir, `note-${id}.txt`));
}

const ids = (dir: string, re: RegExp): number[] => {
  try {
    return readdirSync(dir)
      .map((n) => re.exec(n)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
};

/** The hook's side: claims waiting notes in order, up to HOOK_CHARS, and returns their text. */
export function takeNotes(dir: string): string[] {
  const out: string[] = [];
  let size = 0;
  for (const id of ids(dir, NOTE)) {
    const from = join(dir, `note-${id}.txt`);
    const to = join(dir, `taken-${id}.txt`);
    try {
      renameSync(from, to); // a hook running at the same time may have taken it
    } catch {
      continue;
    }
    const text = readFileSync(to, "utf8");
    if (out.length && size + text.length > HOOK_CHARS) {
      renameSync(to, from); // the next hook takes it
      break;
    }
    out.push(text);
    size += text.length;
  }
  return out;
}

/** The gateway's side: ids of notes a hook handed over since the last call. */
export function takenNotes(dir: string): number[] {
  const done = ids(dir, TAKEN);
  for (const id of done) rmSync(join(dir, `taken-${id}.txt`), { force: true });
  return done;
}

export function dropInbox(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** What the hook prints for the CLI: context after a tool call, or keep going at the stop. */
export function hookOutput(mode: "post" | "stop", texts: string[]): string {
  if (!texts.length) return "";
  const body = texts.join("\n\n");
  return JSON.stringify(
    mode === "stop"
      ? { decision: "block", reason: body }
      : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: body } },
  );
}
