// Skills (ADR-0049, ADR-0053): Markdown how-tos under $ACHORDS_HOME/skills/<scope>/, where a
// scope is `shared`, a workspace or `agents/<agent-id>`. A skill is either a folder with a
// SKILL.md (scripts and references beside it belong to it) or a single `.md` file with
// frontmatter (name, description, enabled, source, updated) + body. Only the index reaches
// every prompt.
import { createHash } from "node:crypto";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const SHARED_SKILLS = "shared";
/** `skills/agents/<agent-id>/`: skills only that agent sees. */
export const AGENT_SKILLS = "agents";
// Slugs only: a name or workspace can never climb out of the skills folder.
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WORKSPACE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const AGENT_SCOPE = /^agents\/[a-z0-9][a-z0-9-]{0,63}$/;
// Names found on disk (third-party packs): no slashes or spaces, so they work as tool arguments.
const FOUND_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;
// Discovery limits per scope, so a huge or looping folder cannot stall every run.
export const SKILL_MAX_DEPTH = 8;
export const SKILL_MAX_ENTRIES = 2000;

export const isSkillName = (name: string) => NAME.test(name);
/** "agents" is reserved for agent scopes. */
export const isSkillWorkspace = (ws: string) =>
  WORKSPACE.test(ws) && ws.toLowerCase() !== AGENT_SKILLS;
/** `shared`, a workspace or `agents/<agent-id>`. */
export const isSkillScope = (scope: string) => isSkillWorkspace(scope) || AGENT_SCOPE.test(scope);
export const agentSkillScope = (agentId: string) => `${AGENT_SKILLS}/${agentId}`;

/** What an owner add/edit or an approved proposal writes (always a single file). */
export interface SkillInput {
  /** The scope: `shared`, a workspace or `agents/<agent-id>`. */
  workspace: string;
  name: string;
  /** One line: what it is for and when to use it. */
  description: string;
  enabled: boolean;
  source?: string;
  updated?: string;
  body: string;
}

export interface Skill extends SkillInput {
  /** Absolute path of the SKILL.md or the single file. */
  path: string;
  /** A folder skill (SKILL.md): edited in its folder, never written here except `enabled`. */
  folder: boolean;
}

export type SkillWarn = (message: string) => void;

export function skillPath(dir: string, workspace: string, name: string): string {
  if (!isSkillScope(workspace)) throw new Error(`invalid workspace ${workspace}`);
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

export function formatSkill(s: Omit<SkillInput, "workspace">): string {
  const meta = {
    name: s.name,
    description: oneLine(s.description),
    enabled: s.enabled,
    ...(s.source ? { source: s.source } : {}),
    ...(s.updated ? { updated: s.updated } : {}),
  };
  return `---\n${stringifyYaml(meta)}---\n\n${s.body.trim()}\n`;
}

const SKIP_DIR = (name: string) => name.startsWith(".") || name === "node_modules";

/**
 * Every skill in one scope, shallowest first. A SKILL.md at any depth is a folder skill (name
 * from its frontmatter, else the folder); a `.md` elsewhere is a skill when its frontmatter has
 * name and description, and a `<slug>.md` at the scope's top is one regardless (the file name is
 * its name, as written by the owner and by proposals). Markdown inside a skill folder belongs to
 * that skill. Hidden folders and node_modules are skipped; on a duplicate name the first wins.
 */
export function scopeSkills(dir: string, scope: string, warn: SkillWarn = () => {}): Skill[] {
  if (!isSkillScope(scope)) return [];
  const root = join(dir, scope);
  if (!existsSync(root)) return [];
  const out = new Map<string, Skill>();
  const add = (path: string, folder: boolean, top: boolean) => {
    let parsed: ReturnType<typeof parseSkillText>;
    try {
      parsed = parseSkillText(readFileSync(path, "utf8"));
    } catch {
      warn(`skills: ${path} does not parse, left out`);
      return;
    }
    const { meta, body } = parsed;
    const metaName = typeof meta.name === "string" ? meta.name.trim() : undefined;
    const description = typeof meta.description === "string" ? oneLine(meta.description) : "";
    const file = basename(path, ".md");
    const name = folder
      ? (metaName ?? basename(dirname(path)))
      : top && NAME.test(file)
        ? file
        : metaName && description
          ? metaName
          : undefined;
    if (name === undefined) return; // plain Markdown, not a skill
    if (!FOUND_NAME.test(name)) {
      warn(`skills: ${path} has an unusable name "${name}", left out`);
      return;
    }
    const seen = out.get(name);
    if (seen) {
      warn(`skills: two skills named ${name} in ${scope}; kept ${seen.path}, ignored ${path}`);
      return;
    }
    out.set(name, {
      workspace: scope,
      name,
      description,
      enabled: meta.enabled !== false,
      ...(typeof meta.source === "string" ? { source: meta.source } : {}),
      ...(meta.updated !== undefined ? { updated: String(meta.updated) } : {}),
      body,
      path,
      folder,
    });
  };
  // Breadth first, so the shallowest of two same-named skills is the one kept.
  const queue = [{ path: root, depth: 0, inSkill: false }];
  let entries = 0;
  for (let next = queue.shift(); next; next = queue.shift()) {
    let list: Dirent[];
    try {
      list = readdirSync(next.path, { withFileTypes: true });
    } catch {
      continue;
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    entries += list.length;
    if (entries > SKILL_MAX_ENTRIES) {
      warn(`skills: ${scope} has more than ${SKILL_MAX_ENTRIES} files; the rest is left out`);
      break;
    }
    const isSkill = list.some((e) => e.isFile() && e.name === "SKILL.md");
    if (isSkill) add(join(next.path, "SKILL.md"), true, false);
    const inSkill = next.inSkill || isSkill;
    for (const e of list) {
      if (SKIP_DIR(e.name)) continue;
      const path = join(next.path, e.name);
      if (e.isDirectory()) {
        if (next.depth < SKILL_MAX_DEPTH) queue.push({ path, depth: next.depth + 1, inSkill });
        else warn(`skills: ${path} is deeper than ${SKILL_MAX_DEPTH} folders, left out`);
      } else if (e.isFile() && !inSkill && e.name.endsWith(".md")) {
        add(path, false, next.depth === 0);
      }
    }
  }
  return [...out.values()];
}

/** One skill of a scope by name, enabled or not. */
export function readSkill(dir: string, workspace: string, name: string): Skill | undefined {
  return scopeSkills(dir, workspace).find((s) => s.name === name);
}

/** The scopes on disk: shared, each workspace folder, each `agents/<id>` folder. */
function scopesOnDisk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name === AGENT_SKILLS) {
      for (const a of readdirSync(join(dir, e.name), { withFileTypes: true })) {
        const scope = agentSkillScope(a.name);
        if ((a.isDirectory() || a.isSymbolicLink()) && isSkillScope(scope)) out.push(scope);
      }
    } else if (isSkillWorkspace(e.name)) out.push(e.name);
  }
  return out;
}

/** Every skill on disk, all scopes; files that do not parse are left out. */
export function listSkills(dir: string, warn?: SkillWarn): Skill[] {
  return scopesOnDisk(dir)
    .flatMap((scope) => scopeSkills(dir, scope, warn))
    .sort((a, b) => a.workspace.localeCompare(b.workspace) || a.name.localeCompare(b.name));
}

/** The scopes a run sees, strongest first: its agent's own, its workspace, shared. */
export function skillScopes(workspace: string, agentId?: string): string[] {
  return [
    ...new Set([...(agentId ? [agentSkillScope(agentId)] : []), workspace, SHARED_SKILLS]),
  ].filter(isSkillScope);
}

/** Enabled skills a run sees (agent scope, then workspace, then shared win on a name). */
export function visibleSkills(
  dir: string,
  workspace: string,
  agentId?: string,
  warn?: SkillWarn,
): Skill[] {
  const byName = new Map<string, Skill>();
  for (const scope of skillScopes(workspace, agentId)) {
    for (const s of scopeSkills(dir, scope, warn)) {
      // A switched-off skill does not hide a weaker one of the same name.
      if (s.enabled && !byName.has(s.name)) byName.set(s.name, s);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A skill by name as a run sees it (agent scope, workspace, shared), enabled or not. */
export function findSkill(
  dir: string,
  workspace: string,
  name: string,
  agentId?: string,
): Skill | undefined {
  if (!FOUND_NAME.test(name)) return undefined;
  for (const scope of skillScopes(workspace, agentId)) {
    const s = readSkill(dir, scope, name);
    if (s) return s;
  }
  return undefined;
}

/** Hash of the file as it is now (a proposal applies only to the file it was made against). */
export function skillHash(dir: string, workspace: string, name: string): string | undefined {
  const s = readSkill(dir, workspace, name);
  return s ? createHash("sha256").update(readFileSync(s.path)).digest("hex") : undefined;
}

const writeAtomic = (path: string, text: string) => {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
};

/** Writes a single-file skill atomically (where it already is, else `<scope>/<name>.md`). */
export function writeSkill(dir: string, s: SkillInput, now = new Date()): Skill {
  const old = readSkill(dir, s.workspace, s.name);
  if (old?.folder) throw new Error(`${s.name} is a skill folder; edit it in ${dirname(old.path)}`);
  const path = old?.path ?? skillPath(dir, s.workspace, s.name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const saved = { ...s, updated: now.toISOString().slice(0, 10) };
  writeAtomic(path, formatSkill(saved));
  return { ...saved, path, folder: false };
}

/**
 * Switches a skill on or off by setting `enabled` in its frontmatter, leaving the rest of the
 * file as it is (for SKILL.md files the owner installed from elsewhere).
 */
export function setSkillEnabled(path: string, enabled: boolean): void {
  const text = readFileSync(path, "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const line = `enabled: ${enabled}`;
  let next: string;
  if (!m) next = `---\n${line}\n---\n\n${text}`;
  else {
    const yaml = m[1] as string;
    const updated = /^enabled:.*$/m.test(yaml)
      ? yaml.replace(/^enabled:.*$/m, line)
      : `${yaml}\n${line}`;
    const start = m[0].indexOf(yaml);
    next = text.slice(0, start) + updated + text.slice(start + yaml.length);
  }
  writeAtomic(path, next);
}

export function deleteSkill(dir: string, workspace: string, name: string): boolean {
  const s = readSkill(dir, workspace, name);
  if (!s) return false;
  if (s.folder) throw new Error(`${name} is a skill folder; remove it in ${dirname(s.path)}`);
  rmSync(s.path);
  return true;
}

/** Files of a folder skill relative to its folder (hidden folders skipped), at most `max`. */
export function skillFiles(s: Skill, max = 50): { files: string[]; more: number } {
  if (!s.folder) return { files: [], more: 0 };
  const root = dirname(s.path);
  const files: string[] = [];
  let more = 0;
  const walk = (path: string, depth: number) => {
    let list: Dirent[];
    try {
      list = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of list) {
      if (SKIP_DIR(e.name)) continue;
      const p = join(path, e.name);
      if (e.isDirectory()) {
        if (depth < SKILL_MAX_DEPTH) walk(p, depth + 1);
      } else if (e.isFile() && p !== s.path) {
        if (files.length < max) files.push(relative(root, p));
        else more++;
      }
      if (files.length + more > SKILL_MAX_ENTRIES) return;
    }
  };
  walk(root, 0);
  return { files, more };
}

const words = (s: string) =>
  new Set(s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? ([] as string[]));

/** Up to `n` skills whose name and description share the most words with `text`. */
export function closestSkills<T extends Pick<Skill, "name" | "description">>(
  skills: T[],
  text: string,
  n = 3,
): T[] {
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
