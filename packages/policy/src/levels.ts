// Permission levels (ADR-0067): one number per agent, an optional override per agent and
// project, capped by the project's class. This module only computes the level; compiling it
// into tools, shell and network is a separate step.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { ProjectClass } from "./projects.ts";

export const MAX_LEVEL = 5;

/** The highest level a project's class allows; an unset class counts as secured. */
export const ceilingOf = (cls: ProjectClass | undefined): number =>
  cls === "experimental" ? 5 : 4;

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Skill names as found on disk (ADR-0049), third-party packs included.
const SKILL = /^[A-Za-z0-9][\w.-]{0,63}$/;

export const levelSchema = z.number().int().min(0).max(MAX_LEVEL);

const overrideSchema = z
  .object({
    agent: z.string().regex(ID),
    project: z.string().regex(ID),
    level: levelSchema,
    requires_skills: z.array(z.string().regex(SKILL)).default([]),
  })
  .strict();

const overridesSchema = z.array(overrideSchema).superRefine((list, ctx) => {
  const seen = new Set<string>();
  list.forEach((o, i) => {
    const key = `${o.agent}/${o.project}`;
    if (seen.has(key)) {
      ctx.addIssue({ code: "custom", path: [i], message: `${key} is listed twice` });
    }
    seen.add(key);
  });
});

export type LevelOverride = z.output<typeof overrideSchema>;
export type LevelReason = "base" | "override" | "ceiling" | "missing-skill";

export interface EffectiveLevel {
  level: number;
  /** What decided the level, for the agent form. */
  reason: LevelReason;
  /** Required skills of the override that are not enabled (the override was ignored). */
  missingSkills?: string[];
}

/**
 * `min(override ?? base, ceiling)`. An override is ignored while a required skill is not
 * enabled, and a raising one is ignored unless the project is experimental (saving refuses it;
 * this covers a hand-edited file).
 */
export function effectiveLevel(input: {
  base: number;
  override?: Pick<LevelOverride, "level" | "requires_skills"> | undefined;
  projectClass?: ProjectClass | undefined;
  enabledSkills: Iterable<string>;
}): EffectiveLevel {
  const { base, override, projectClass } = input;
  let out: EffectiveLevel = { level: base, reason: "base" };
  if (override) {
    const enabled = new Set(input.enabledSkills);
    const missing = override.requires_skills.filter((s) => !enabled.has(s));
    if (missing.length) out = { level: base, reason: "missing-skill", missingSkills: missing };
    else if (override.level <= base || projectClass === "experimental") {
      out = { level: override.level, reason: "override" };
    }
  }
  const ceiling = ceilingOf(projectClass);
  return out.level > ceiling ? { ...out, level: ceiling, reason: "ceiling" } : out;
}

const overridesPath = (home: string) => join(home, "overrides.yaml");

function parseOverrides(raw: unknown, source: string): LevelOverride[] {
  const parsed = overridesSchema.safeParse(raw ?? []);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`${source}: invalid overrides\n  ${issues.join("\n  ")}`);
  }
  return parsed.data;
}

/** `~/.achords/overrides.yaml`: a list of `{agent, project, level, requires_skills?}`. */
export function loadOverrides(home: string): LevelOverride[] {
  const path = overridesPath(home);
  if (!existsSync(path)) return [];
  return parseOverrides(parseYaml(readFileSync(path, "utf8")), path);
}

/**
 * Why an override may not be saved, or undefined. Raising above the agent's base level needs an
 * experimental project; an agent without a level yet can only be lowered there too, so nothing
 * on a secured project is allowed until it has one.
 */
export function overrideRefusal(
  o: Pick<LevelOverride, "agent" | "project" | "level">,
  base: number | undefined,
  projectClass: ProjectClass | undefined,
): string | undefined {
  if (projectClass === "experimental") return undefined;
  if (base === undefined) {
    return `${o.agent} has no level yet, so an override on ${o.project} (not experimental) cannot be checked against it`;
  }
  return o.level > base
    ? `${o.agent} on ${o.project}: an override may only raise the level (${base} to ${o.level}) on an experimental project`
    : undefined;
}

/** Replaces the whole list after checking every entry against its agent and project. */
export function saveOverrides(
  home: string,
  list: unknown,
  ctx: {
    base: (agent: string) => number | undefined;
    projectClass: (project: string) => ProjectClass | undefined;
  },
): LevelOverride[] {
  const overrides = parseOverrides(list, "overrides");
  for (const o of overrides) {
    const reason = overrideRefusal(o, ctx.base(o.agent), ctx.projectClass(o.project));
    if (reason) throw new Error(reason);
  }
  writeFileSync(
    overridesPath(home),
    `# Permission level per agent and project (ADR-0067).\n${overrides.length ? stringifyYaml(overrides) : "[]\n"}`,
    { mode: 0o600 },
  );
  return overrides;
}
