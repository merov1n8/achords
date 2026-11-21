import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closestSkills,
  deleteSkill,
  findSkill,
  listSkills,
  parseSkillText,
  readSkill,
  type Skill,
  skillHash,
  skillPath,
  visibleSkills,
  writeSkill,
} from "./skills.ts";

const skill = (over: Partial<Skill> = {}): Skill => ({
  workspace: "web-clients",
  name: "owner-report",
  description: "How to write the final report for the owner",
  enabled: true,
  body: "Write plain sentences.",
  ...over,
});

describe("skills (ADR-0049)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "achords-skills-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes frontmatter + body and reads it back, file name wins over frontmatter", () => {
    writeSkill(
      dir,
      skill({ source: "https://example.com/s.md" }),
      new Date("2026-11-21T10:00:00Z"),
    );
    const text = readFileSync(join(dir, "web-clients", "owner-report.md"), "utf8");
    expect(text).toMatch(/^---\nname: owner-report\n/);
    expect(text).toContain("updated: 2026-11-21");
    expect(readSkill(dir, "web-clients", "owner-report")).toEqual({
      ...skill({ source: "https://example.com/s.md" }),
      updated: "2026-11-21",
    });
    writeFileSync(
      join(dir, "web-clients", "owner-report.md"),
      text.replace("name: owner-report", "name: other"),
    );
    expect(readSkill(dir, "web-clients", "owner-report")?.name).toBe("owner-report");
  });

  it("refuses names and workspaces that are not slugs (no path escape)", () => {
    for (const name of ["../x", "a/b", "", "UPPER", "-x", "a.md"]) {
      expect(() => skillPath(dir, "shared", name)).toThrow(/invalid skill name/);
    }
    expect(() => skillPath(dir, "..", "x")).toThrow(/invalid workspace/);
    expect(findSkill(dir, "shared", "../../etc/passwd")).toBeUndefined();
  });

  it("parses SKILL.md frontmatter from elsewhere, and text without any", () => {
    expect(parseSkillText('---\nname: pdf\ndescription: "Read PDFs"\n---\n\n# Body\n')).toEqual({
      meta: { name: "pdf", description: "Read PDFs" },
      body: "# Body",
    });
    expect(parseSkillText("just text\n")).toEqual({ meta: {}, body: "just text" });
  });

  it("an agent sees its own workspace plus shared, enabled only; its own wins on a name", () => {
    writeSkill(dir, skill({ workspace: "shared", description: "shared version" }));
    writeSkill(dir, skill({ description: "own version" }));
    writeSkill(dir, skill({ workspace: "shared", name: "seo-check", description: "SEO" }));
    writeSkill(dir, skill({ workspace: "shared", name: "off", enabled: false }));
    writeSkill(dir, skill({ workspace: "games", name: "unity-build" }));
    expect(visibleSkills(dir, "web-clients").map((s) => [s.name, s.description])).toEqual([
      ["owner-report", "own version"],
      ["seo-check", "SEO"],
    ]);
    expect(visibleSkills(dir, "games").map((s) => s.name)).toEqual([
      "owner-report",
      "seo-check",
      "unity-build",
    ]);
    expect(findSkill(dir, "games", "owner-report")?.description).toBe("shared version");
    expect(listSkills(dir)).toHaveLength(5);
  });

  it("skips files that are not skills", () => {
    mkdirSync(join(dir, "shared"), { recursive: true });
    writeFileSync(join(dir, "shared", "notes.txt"), "x");
    writeFileSync(join(dir, "shared", "Bad Name.md"), "x");
    writeFileSync(join(dir, "shared", "broken.md"), "---\n: : :\n---\nx");
    expect(listSkills(dir).map((s) => s.name)).toEqual([]);
  });

  it("hashes the current file and deletes", () => {
    expect(skillHash(dir, "shared", "x")).toBeUndefined();
    writeSkill(dir, skill({ workspace: "shared", name: "x" }));
    const h = skillHash(dir, "shared", "x");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    writeSkill(dir, skill({ workspace: "shared", name: "x", body: "changed" }));
    expect(skillHash(dir, "shared", "x")).not.toBe(h);
    expect(deleteSkill(dir, "shared", "x")).toBe(true);
    expect(deleteSkill(dir, "shared", "x")).toBe(false);
  });

  it("finds the closest skills by shared words", () => {
    const all = [
      skill({ name: "owner-report", description: "Write the final report for the owner" }),
      skill({ name: "seo-audit", description: "Audit a website for search engines" }),
      skill({ name: "unity-build", description: "Build a Unity game" }),
    ];
    expect(
      closestSkills(all, "A skill for writing a clear final report to a client").map((s) => s.name),
    ).toEqual(["owner-report"]);
    expect(closestSkills(all, "nothing in common here")).toEqual([]);
  });
});
