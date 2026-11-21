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
  SKILL_MAX_DEPTH,
  SKILL_MAX_ENTRIES,
  type SkillInput,
  scopeSkills,
  setSkillEnabled,
  skillFiles,
  skillHash,
  skillPath,
  visibleSkills,
  writeSkill,
} from "./skills.ts";

const skill = (over: Partial<SkillInput> = {}): SkillInput => ({
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
      path: join(dir, "web-clients", "owner-report.md"),
      folder: false,
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

describe("skill folders and agent scopes (ADR-0053)", () => {
  let dir: string;
  const put = (rel: string, text: string) => {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  const fm = (meta: string, body = "Body.") => `---\n${meta}\n---\n\n${body}\n`;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "achords-skillpacks-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds SKILL.md folders at any depth and leaves their references out", () => {
    const pack = "agents/advertiser/claude-ads/skills";
    const google = put(
      `${pack}/ads-google/SKILL.md`,
      fm("name: ads-google\ndescription: Google Ads audits"),
    );
    put(`${pack}/ads-google/references/bidding.md`, fm("name: bidding\ndescription: Not a skill"));
    put(`${pack}/ads-google/scripts/check.py`, "print(1)");
    // No frontmatter name: the folder is the name.
    put(`${pack}/ads-meta/SKILL.md`, fm("description: Meta Ads"));
    // A single-file skill nested in a category folder, and plain Markdown that is not a skill.
    put("agents/advertiser/notes/brief-writing.md", fm("name: brief\ndescription: Briefs"));
    put("agents/advertiser/README.md", "# Pack\n");
    put("agents/advertiser/claude-ads/docs.md", fm("title: no name"));
    const found = scopeSkills(dir, "agents/advertiser");
    expect(found.map((s) => [s.name, s.description, s.folder])).toEqual([
      ["brief", "Briefs", false],
      ["ads-google", "Google Ads audits", true],
      ["ads-meta", "Meta Ads", true],
    ]);
    const g = found.find((s) => s.name === "ads-google");
    expect(g?.path).toBe(google);
    expect(skillFiles(g as NonNullable<typeof g>)).toEqual({
      files: ["references/bidding.md", "scripts/check.py"],
      more: 0,
    });
    expect(listSkills(dir).map((s) => `${s.workspace}:${s.name}`)).toEqual([
      "agents/advertiser:ads-google",
      "agents/advertiser:ads-meta",
      "agents/advertiser:brief",
    ]);
  });

  it("keeps the shallowest of two same-named skills and warns", () => {
    const top = put("shared/report/SKILL.md", fm("name: report\ndescription: top"));
    const deep = put("shared/pack/x/report/SKILL.md", fm("name: report\ndescription: deep"));
    const warnings: string[] = [];
    const found = scopeSkills(dir, "shared", (w) => warnings.push(w));
    expect(found.map((s) => s.path)).toEqual([top]);
    expect(warnings).toEqual([
      `skills: two skills named report in shared; kept ${top}, ignored ${deep}`,
    ]);
  });

  it("skips hidden folders and node_modules, and stops at the depth and file caps", () => {
    put(".git/SKILL.md", fm("name: hidden\ndescription: x"));
    put("shared/.cache/SKILL.md", fm("name: cache\ndescription: x"));
    put("shared/node_modules/pkg/SKILL.md", fm("name: pkg\ndescription: x"));
    put(
      `shared/${Array.from({ length: SKILL_MAX_DEPTH }, (_, i) => `d${i}`).join("/")}/SKILL.md`,
      fm("name: deepest\ndescription: at the limit"),
    );
    put(
      `shared/${Array.from({ length: SKILL_MAX_DEPTH + 1 }, (_, i) => `d${i}`).join("/")}/SKILL.md`,
      fm("name: too-deep\ndescription: x"),
    );
    const warnings: string[] = [];
    expect(scopeSkills(dir, "shared", (w) => warnings.push(w)).map((s) => s.name)).toEqual([
      "deepest",
    ]);
    expect(warnings.join("\n")).toMatch(/deeper than 8 folders/);

    for (let i = 0; i < SKILL_MAX_ENTRIES; i++) put(`big/a/f${i}.txt`, "");
    put("big/z/SKILL.md", fm("name: late\ndescription: x"));
    put("big/first.md", fm("name: first\ndescription: x"));
    warnings.length = 0;
    expect(scopeSkills(dir, "big", (w) => warnings.push(w)).map((s) => s.name)).toEqual(["first"]);
    expect(warnings).toEqual([
      `skills: big has more than ${SKILL_MAX_ENTRIES} files; the rest is left out`,
    ]);
  });

  it("a run sees its agent scope, then its workspace, then shared", () => {
    put("shared/x/SKILL.md", fm("name: x\ndescription: shared x"));
    put("shared/y.md", fm("name: y\ndescription: shared y"));
    put("shared/z.md", fm("name: z\ndescription: shared z"));
    put("web/x.md", fm("name: x\ndescription: web x"));
    put("web/y.md", fm("name: y\ndescription: web y"));
    put("agents/dev/pack/x/SKILL.md", fm("name: x\ndescription: dev x"));
    put("agents/dev/z/SKILL.md", fm("name: z\ndescription: dev z\nenabled: false"));
    put("agents/other/only/SKILL.md", fm("name: only\ndescription: other's"));
    const seen = (agent?: string) =>
      visibleSkills(dir, "web", agent).map((s) => `${s.name}=${s.description}`);
    expect(seen("dev")).toEqual(["x=dev x", "y=web y", "z=shared z"]);
    expect(seen()).toEqual(["x=web x", "y=web y", "z=shared z"]);
    expect(findSkill(dir, "web", "z", "dev")?.enabled).toBe(false);
    expect(findSkill(dir, "web", "only", "dev")).toBeUndefined();
  });

  it("switching a folder skill off keeps the rest of its SKILL.md", () => {
    const text =
      '---\nname: ads-google\ndescription: "Google Ads"\nmetadata:\n  enabled: kept\nallowed-tools: Read\n---\n\n# Ads\n\nCost $& more\n';
    const path = put("shared/ads/SKILL.md", text);
    setSkillEnabled(path, false);
    expect(readFileSync(path, "utf8")).toBe(text.replace("Read\n---", "Read\nenabled: false\n---"));
    expect(readSkill(dir, "shared", "ads-google")?.enabled).toBe(false);
    setSkillEnabled(path, true);
    expect(readFileSync(path, "utf8")).toBe(text.replace("Read\n---", "Read\nenabled: true\n---"));
    const plain = put("shared/plain/SKILL.md", "# Plain\n");
    setSkillEnabled(plain, false);
    expect(readFileSync(plain, "utf8")).toBe("---\nenabled: false\n---\n\n# Plain\n");
    // Folder skills are never rewritten or deleted as single files.
    expect(() => writeSkill(dir, skill({ workspace: "shared", name: "plain" }))).toThrow(
      /skill folder/,
    );
    expect(() => deleteSkill(dir, "shared", "plain")).toThrow(/skill folder/);
  });

  it("the owner can write a single-file skill into an agent scope; agents is no workspace", () => {
    writeSkill(dir, skill({ workspace: "agents/dev" }));
    expect(readSkill(dir, "agents/dev", "owner-report")?.path).toBe(
      join(dir, "agents", "dev", "owner-report.md"),
    );
    expect(() => skillPath(dir, "agents", "x")).toThrow(/invalid workspace/);
    expect(() => skillPath(dir, "agents/../x", "x")).toThrow(/invalid workspace/);
    expect(listSkills(dir).map((s) => s.workspace)).toEqual(["agents/dev"]);
  });
});
