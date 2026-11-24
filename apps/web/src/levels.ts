// Permission levels in the agent form (ADR-0067): names, meanings, why a project gets the level
// it gets, and checks on an override before it is sent.
import { t } from "./i18n.ts";

/** Name and one-line meaning of each level, 0–5. */
export const LEVELS: { name: string; meaning: string }[] = [
  { name: t("level.0"), meaning: t("level.0.meaning") },
  { name: t("level.1"), meaning: t("level.1.meaning") },
  { name: t("level.2"), meaning: t("level.2.meaning") },
  { name: t("level.3"), meaning: t("level.3.meaning") },
  { name: t("level.4"), meaning: t("level.4.meaning") },
  { name: t("level.5"), meaning: t("level.5.meaning") },
];

export const levelLabel = (n: number) => `${n} · ${LEVELS[n]?.name ?? ""}`;

/** One row of GET /api/agents/:id `effectiveLevels`. */
export interface EffectiveRow {
  project: string;
  name: string;
  /** null = not chosen yet (counts as secured). */
  class: "secured" | "experimental" | null;
  level: number;
  reason: "base" | "override" | "ceiling" | "missing-skill" | "no-sandbox" | "local-model";
  missingSkills?: string[];
}

export interface Override {
  project: string;
  level: number;
  requires_skills: string[];
}

export const ceilingOf = (cls: EffectiveRow["class"]) => (cls === "experimental" ? 5 : 4);

/** Why a project gets its level, in plain words. */
export function reasonText(row: EffectiveRow): string {
  switch (row.reason) {
    case "base":
      return t("level.reason.base");
    case "override":
      return t("level.reason.override");
    case "ceiling":
      return t("level.reason.ceiling", { ceiling: ceilingOf(row.class) });
    case "missing-skill":
      return t("level.reason.missingSkill", { skills: (row.missingSkills ?? []).join(", ") });
    case "no-sandbox":
      return t("level.reason.noSandbox");
    case "local-model":
      return t("level.reason.localModel");
  }
}

/** Skill names typed with commas or spaces between them. */
export const parseSkills = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];

const SKILL = /^[A-Za-z0-9][\w.-]{0,63}$/;

/**
 * Why an override cannot be added, or undefined. The server checks again (`overrideRefusal`);
 * this answers before the round trip: raising needs an experimental project.
 */
export function overrideProblem(
  draft: Override,
  existing: Override[],
  base: number,
  projects: Pick<EffectiveRow, "project" | "class">[],
): string | undefined {
  if (!draft.project) return t("overrides.pickProject");
  if (existing.some((o) => o.project === draft.project)) return t("overrides.duplicate");
  const bad = draft.requires_skills.find((s) => !SKILL.test(s));
  if (bad) return t("overrides.badSkill", { skill: bad });
  const cls = projects.find((p) => p.project === draft.project)?.class ?? null;
  if (draft.level > base && cls !== "experimental") return t("overrides.raiseSecured");
  return undefined;
}
