import { describe, expect, it } from "vitest";
import {
  type EffectiveRow,
  LEVELS,
  levelLabel,
  overrideProblem,
  parseSkills,
  reasonText,
} from "./levels.ts";

const row = (patch: Partial<EffectiveRow>): EffectiveRow => ({
  project: "p",
  name: "P",
  class: null,
  level: 3,
  reason: "base",
  ...patch,
});

describe("levels in the agent form (ADR-0067)", () => {
  it("names every level with a one-line meaning", () => {
    expect(LEVELS).toHaveLength(6);
    for (const l of LEVELS) expect(l.meaning.length).toBeGreaterThan(10);
    expect(levelLabel(4)).toBe("4 · Builder");
  });

  it("says why a project gets its level", () => {
    expect(reasonText(row({ reason: "base" }))).toMatch(/own level/);
    expect(reasonText(row({ reason: "override" }))).toMatch(/override/i);
    expect(reasonText(row({ reason: "ceiling", class: null }))).toMatch(/4/);
    expect(reasonText(row({ reason: "ceiling", class: "experimental" }))).toMatch(/5/);
    expect(reasonText(row({ reason: "missing-skill", missingSkills: ["deploy", "seo"] }))).toMatch(
      /deploy, seo/,
    );
    expect(reasonText(row({ reason: "no-sandbox" }))).toMatch(/sandbox/);
    expect(reasonText(row({ reason: "local-model" }))).toMatch(/local/i);
  });

  it("reads skill lists typed with commas or spaces", () => {
    expect(parseSkills(" deploy, seo  seo,,")).toEqual(["deploy", "seo"]);
    expect(parseSkills("")).toEqual([]);
  });

  it("checks an override before saving: project, duplicates, skill names, raising", () => {
    const projects = [
      { project: "client", class: null },
      { project: "lab", class: "experimental" as const },
    ];
    const ok = { project: "lab", level: 5, requires_skills: [] };
    expect(overrideProblem(ok, [], 3, projects)).toBeUndefined();
    expect(overrideProblem({ ...ok, project: "" }, [], 3, projects)).toBeDefined();
    expect(overrideProblem(ok, [ok], 3, projects)).toMatch(/already/);
    expect(overrideProblem({ ...ok, requires_skills: ["bad skill!"] }, [], 3, projects)).toMatch(
      /bad skill!/,
    );
    // Raising on a secured or unset project is refused; lowering is allowed anywhere.
    expect(overrideProblem({ ...ok, project: "client", level: 4 }, [], 3, projects)).toMatch(
      /experimental/,
    );
    expect(
      overrideProblem({ ...ok, project: "client", level: 1 }, [], 3, projects),
    ).toBeUndefined();
  });
});
