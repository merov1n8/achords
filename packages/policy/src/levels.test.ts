import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ceilingOf,
  effectiveLevel,
  loadOverrides,
  overrideRefusal,
  saveOverrides,
} from "./levels.ts";

const skills: string[] = [];

describe("effective level (ADR-0067)", () => {
  it("caps at the class ceiling; an unset class counts as secured", () => {
    expect(ceilingOf(undefined)).toBe(4);
    expect(ceilingOf("secured")).toBe(4);
    expect(ceilingOf("experimental")).toBe(5);
    expect(effectiveLevel({ base: 5, projectClass: "secured", enabledSkills: skills })).toEqual({
      level: 4,
      reason: "ceiling",
    });
    expect(effectiveLevel({ base: 5, enabledSkills: skills })).toEqual({
      level: 4,
      reason: "ceiling",
    });
    expect(
      effectiveLevel({ base: 5, projectClass: "experimental", enabledSkills: skills }),
    ).toEqual({ level: 5, reason: "base" });
    expect(effectiveLevel({ base: 2, enabledSkills: skills })).toEqual({
      level: 2,
      reason: "base",
    });
  });

  it("an override raises only on experimental and lowers anywhere", () => {
    const up = { level: 5, requires_skills: [] };
    const down = { level: 1, requires_skills: [] };
    expect(
      effectiveLevel({
        base: 3,
        override: up,
        projectClass: "experimental",
        enabledSkills: skills,
      }),
    ).toEqual({ level: 5, reason: "override" });
    // A raise written by hand on a secured project is ignored.
    expect(
      effectiveLevel({
        base: 2,
        override: { level: 4, requires_skills: [] },
        enabledSkills: skills,
      }),
    ).toEqual({ level: 2, reason: "base" });
    for (const projectClass of [undefined, "secured", "experimental"] as const) {
      expect(
        effectiveLevel({ base: 4, override: down, projectClass, enabledSkills: skills }),
      ).toEqual({ level: 1, reason: "override" });
    }
    // Lowering a level 5 agent on secured still lands under the ceiling.
    expect(
      effectiveLevel({
        base: 5,
        override: { level: 3, requires_skills: [] },
        enabledSkills: skills,
      }),
    ).toEqual({ level: 3, reason: "override" });
  });

  it("falls back to the base level while a required skill is not enabled", () => {
    const override = { level: 5, requires_skills: ["deploy-checklist", "wp-safety"] };
    expect(
      effectiveLevel({
        base: 3,
        override,
        projectClass: "experimental",
        enabledSkills: ["wp-safety"],
      }),
    ).toEqual({ level: 3, reason: "missing-skill", missingSkills: ["deploy-checklist"] });
    expect(
      effectiveLevel({
        base: 3,
        override,
        projectClass: "experimental",
        enabledSkills: new Set(["wp-safety", "deploy-checklist"]),
      }),
    ).toEqual({ level: 5, reason: "override" });
  });
});

describe("overrides.yaml", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-levels-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const ctx = {
    base: (agent: string) => ({ "web-dev": 3, seo: 3 })[agent],
    projectClass: (project: string) =>
      project === "lab" || project === "own" ? ("experimental" as const) : undefined,
  };

  it("loads nothing without a file and validates entries", () => {
    expect(loadOverrides(home)).toEqual([]);
    writeFileSync(join(home, "overrides.yaml"), "- { agent: web-dev, project: acme, level: 7 }\n");
    expect(() => loadOverrides(home)).toThrow(/overrides.*level/s);
    writeFileSync(
      join(home, "overrides.yaml"),
      "- { agent: web-dev, project: acme, level: 2 }\n- { agent: web-dev, project: acme, level: 1 }\n",
    );
    expect(() => loadOverrides(home)).toThrow(/web-dev\/acme is listed twice/);
    writeFileSync(join(home, "overrides.yaml"), "- { agent: web-dev, project: acme, levl: 2 }\n");
    expect(() => loadOverrides(home)).toThrow();
  });

  it("refuses to save a raise on a project that is not experimental", () => {
    expect(() =>
      saveOverrides(home, [{ agent: "web-dev", project: "acme", level: 4 }], ctx),
    ).toThrow(
      /web-dev on acme: an override may only raise the level \(3 to 4\) on an experimental/,
    );
    expect(existsSync(join(home, "overrides.yaml"))).toBe(false);
    // Unknown base (agent without a level yet) on a secured project cannot be checked.
    expect(
      overrideRefusal({ agent: "x", project: "acme", level: 1 }, undefined, "secured"),
    ).toMatch(/no level yet/);
    const saved = saveOverrides(
      home,
      [
        { agent: "web-dev", project: "acme", level: 1 },
        { agent: "web-dev", project: "lab", level: 5, requires_skills: ["deploy-checklist"] },
        { agent: "seo", project: "own", level: 4 },
      ],
      ctx,
    );
    expect(saved).toHaveLength(3);
    expect(loadOverrides(home)).toEqual([
      { agent: "web-dev", project: "acme", level: 1, requires_skills: [] },
      { agent: "web-dev", project: "lab", level: 5, requires_skills: ["deploy-checklist"] },
      { agent: "seo", project: "own", level: 4, requires_skills: [] },
    ]);
    expect(readFileSync(join(home, "overrides.yaml"), "utf8")).toMatch(/^# Permission level/);
    saveOverrides(home, [], ctx);
    expect(loadOverrides(home)).toEqual([]);
  });
});
