// A card goes to review only when its runs changed code: a Markdown summary needs no code review.
// Changes are found by modification time, so work outside git (a project's files/ folder) counts
// too. Deleting or moving files keeps no new time; such a run looks unchanged.
import { type Dirent, readdirSync, realpathSync, statSync } from "node:fs";
import { extname, join } from "node:path";

// Dependencies, tool caches and Unity's generated folders: never the agent's own writing.
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "Library",
  "Temp",
  "Logs",
  "obj",
  "UserSettings",
  "__pycache__",
  ".venv",
]);

// Documents and media. Everything else, files without an extension too, counts as code.
const NOT_CODE = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".rst",
  ".adoc",
  ".pdf",
  ".docx",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".heic",
  ".mp3",
  ".wav",
  ".mp4",
  ".mov",
]);

export const isCode = (path: string) =>
  !path.endsWith("/.DS_Store") && !NOT_CODE.has(extname(path).toLowerCase());

/**
 * Files under `folders` modified at or after `since` (ms). Undefined when a folder holds more
 * than `limit` files: too big to tell, so the caller treats the work as code.
 */
export function changedFiles(
  folders: string[],
  since: number,
  limit = 50_000,
): string[] | undefined {
  const changed: string[] = [];
  const seen = new Set<string>();
  let files = 0;
  const walk = (dir: string): boolean => {
    let real: string;
    let entries: Dirent[];
    try {
      real = realpathSync(dir);
      if (seen.has(real)) return true;
      seen.add(real);
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true; // a folder not created yet has nothing changed in it
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !walk(path)) return false;
      } else if (e.isFile()) {
        if (++files > limit) return false;
        try {
          if (statSync(path).mtimeMs >= since) changed.push(path);
        } catch {
          // removed while walking
        }
      }
    }
    return true;
  };
  for (const f of folders) if (!walk(f)) return undefined;
  return changed;
}
