// Skills (ADR-0049): Markdown how-tos in $ACHORDS_HOME/skills/<workspace>/<name>.md, frontmatter
// (name, description, enabled, source, updated) + body. Only the index reaches every prompt.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const SHARED_SKILLS = "shared";
// Slugs only: a name or workspace can never climb out of the skills folder.
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WORKSPACE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export const isSkillName = (name: string) => NAME.test(name);
export const isSkillWorkspace = (ws: string) => WORKSPACE.test(ws);

export interface Skill {
  workspace: string;
  name: string;
  /** One line: what it is for and when to use it. */
  description: string;
  enabled: boolean;
  source?: string;
  updated?: string;
  body: string;
}

export function skillPath(dir: string, workspace: string, name: string): string {
  if (!WORKSPACE.test(workspace)) throw new Error(`invalid workspace ${workspace}`);
  if (!NAME.test(name)) {
    throw new Error(`invalid skill name ${name} (lowercase letters, digits and dashes)`);
  }
  return join(dir, workspace, `${name}.md`);
}

/** Frontmatter and body of a skill file (also SKILL.md files from elsewhere). */
export function parseSkillText(text: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = parseYaml(m[1] as string) as unknown;
  return {
    meta:
      meta && typeof meta === "object" && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)
        : {},
    body: text.slice(m[0].length).trim(),
  };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function formatSkill(s: Omit<Skill, "workspace">): string {
  const meta = {
    name: s.name,
    description: oneLine(s.description),
    enabled: s.enabled,
    ...(s.source ? { source: s.source } : {}),
    ...(s.updated ? { updated: s.updated } : {}),
  };
  return `---\n${stringifyYaml(meta)}---\n\n${s.body.trim()}\n`;
}

export function readSkill(dir: string, workspace: string, name: string): Skill | undefined {
  const path = skillPath(dir, workspace, name);
  if (!existsSync(path)) return undefined;
  const { meta, body } = parseSkillText(readFileSync(path, "utf8"));
  return {
    workspace,
    // The file name is the name: the frontmatter cannot point somewhere else.
    name,
    description: typeof meta.description === "string" ? oneLine(meta.description) : "",
    enabled: meta.enabled !== false,
    ...(typeof meta.source === "string" ? { source: meta.source } : {}),
    ...(meta.updated !== undefined ? { updated: String(meta.updated) } : {}),
    body,
  };
}

/** Every skill on disk, all workspaces; files that do not parse are left out. */
export function listSkills(dir: string): Skill[] {
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const ws of readdirSync(dir, { withFileTypes: true })) {
    if (!ws.isDirectory() || !WORKSPACE.test(ws.name)) continue;
    for (const file of readdirSync(join(dir, ws.name)).sort()) {
      const name = file.replace(/\.md$/, "");
      if (name === file || !NAME.test(name)) continue;
      try {
        const s = readSkill(dir, ws.name, name);
        if (s) out.push(s);
      } catch {}
    }
  }
  return out.sort((a, b) => a.workspace.localeCompare(b.workspace) || a.name.localeCompare(b.name));
}

/** Enabled skills an agent of `workspace` sees: its own plus shared; its own wins on a name. */
export function visibleSkills(dir: string, workspace: string): Skill[] {
  const byName = new Map<string, Skill>();
  for (const s of listSkills(dir)) {
    if (!s.enabled || (s.workspace !== workspace && s.workspace !== SHARED_SKILLS)) continue;
    const seen = byName.get(s.name);
    if (!seen || s.workspace === workspace) byName.set(s.name, s);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A skill by name as `workspace` sees it (own first, then shared), enabled or not. */
export function findSkill(dir: string, workspace: string, name: string): Skill | undefined {
  if (!NAME.test(name)) return undefined;
  return (
    (WORKSPACE.test(workspace) ? readSkill(dir, workspace, name) : undefined) ??
    readSkill(dir, SHARED_SKILLS, name)
  );
}

/** Hash of the file as it is now (a proposal applies only to the file it was made against). */
export function skillHash(dir: string, workspace: string, name: string): string | undefined {
  const path = skillPath(dir, workspace, name);
  return existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex")
    : undefined;
}

/** Writes atomically; `updated` is set to today. */
export function writeSkill(dir: string, s: Skill, now = new Date()): Skill {
  const path = skillPath(dir, s.workspace, s.name);
  mkdirSync(join(dir, s.workspace), { recursive: true, mode: 0o700 });
  const saved = { ...s, updated: now.toISOString().slice(0, 10) };
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, formatSkill(saved), { mode: 0o600 });
  renameSync(tmp, path);
  return saved;
}

export function deleteSkill(dir: string, workspace: string, name: string): boolean {
  const path = skillPath(dir, workspace, name);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

const words = (s: string) =>
  new Set(s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? ([] as string[]));

/** Up to `n` skills whose name and description share the most words with `text`. */
export function closestSkills(skills: Skill[], text: string, n = 3): Skill[] {
  const query = words(text);
  return skills
    .map((s) => ({
      s,
      score: [...words(`${s.name.replaceAll("-", " ")} ${s.description}`)].filter((w) =>
        query.has(w),
      ).length,
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
    .slice(0, n)
    .map((x) => x.s);
}
