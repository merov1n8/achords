import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  legacyRights,
  levelRights,
  loadCatalog,
  parseManifest,
  withinRights,
} from "@achords/policy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateLevels } from "./levels.ts";

const CLI = new URL("./index.ts", import.meta.url).pathname;
const catalog = loadCatalog(
  new URL("../../../seed/catalog/", import.meta.url).pathname,
  "/nonexistent",
);
const UNITY = "/Applications/Unity/Hub/Editor/6000.0.23f1/Unity.app/Contents/MacOS/Unity";

const head = (id: string, extra = "") => `id: ${id}
name: ${id}
role: ${id}
workspace: studio
models:
  default: cli-claude/sonnet
${extra}`;

// Agent shapes as installed before ADR-0067.
const AGENTS: Record<string, string> = {
  "code-reviewer": head(
    "code-reviewer",
    `tools: [Read, Glob, Grep]
fs:
  read: [/srv/code]
`,
  ),
  marketing: head(
    "marketing",
    `tools: [Read, Edit, Write, Glob, Grep, WebFetch, WebSearch, Bash]
mcp: [meta]
fs:
  write: [/srv/marketing]
shell:
  allow: [wc, jq]
network:
  allow: ["*"]
container: true
`,
  ),
  seo: head(
    "seo",
    `tools: [Read, Edit, Write, Glob, Grep, WebFetch, WebSearch]
mcp: [search-console]
fs:
  write: [/srv/seo]
network:
  allow: ["*"]
`,
  ),
  "web-dev": `# Web developer: client sites.
${head(
  "web-dev",
  `tools: [Read, Edit, Write, Glob, Grep, Bash, WebFetch]
fs:
  # the client repositories
  write: [/srv/web]
shell:
  allow:
    - git status
    - git diff
    - git commit
    - unzip -o /Users/owner/Downloads/theme-v2.zip
    - unzip -o plugin-pack.zip
network:
  allow: [developer.wordpress.org]
budget:
  per_run_usd: 2
`,
)}`,
  "wp-maintainer": head(
    "wp-maintainer",
    `tools: [Read, Edit, Write, Glob, Grep, Bash]
mcp: [wordpress]
fs:
  write: [/srv/wp]
shell:
  allow: [wp, git status]
container: true
`,
  ),
  "game-dev": head(
    "game-dev",
    `tools: [Read, Edit, Write, Glob, Grep, Bash]
mcp: [unity]
fs:
  write: [/srv/game]
shell:
  allow:
    - git status
    - swift build
    - ${UNITY} -batchmode -quit -projectPath /srv/game
    - open -a /Applications/Unity/Hub/Editor/6000.0.23f1/Unity.app
`,
  ),
  "3d-designer": head(
    "3d-designer",
    `tools: [Read, Edit, Write, Glob, Grep]
mcp: [blender, meshy, fal]
fs:
  write: [/srv/3d]
`,
  ),
  "video-producer": head(
    "video-producer",
    `tools: [Read, Edit, Write, Glob, Grep, Bash]
mcp: [elevenlabs]
fs:
  write: [/srv/video]
shell:
  allow: [ffmpeg, ffprobe]
container: true
`,
  ),
  // Not in the starting assignment.
  helper: head(
    "helper",
    `tools: [Read, Glob, Grep, Edit, Write, WebFetch]
fs:
  write: [/srv/helper]
network:
  allow: [docs.example.com]
`,
  ),
  boss: head("boss", "tools: []\n"),
};

describe("achords levels migrate (ADR-0067 step 5)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-levels-"));
    for (const [id, text] of Object.entries(AGENTS)) {
      mkdirSync(join(home, "agents", id), { recursive: true });
      writeFileSync(join(home, "agents", id, "agent.yaml"), text);
    }
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const files = () =>
    Object.fromEntries(
      Object.keys(AGENTS).map((id) => [
        id,
        readFileSync(join(home, "agents", id, "agent.yaml"), "utf8"),
      ]),
    );
  const migrate = (write: boolean) =>
    migrateLevels({
      home,
      catalog,
      write,
      containerAvailable: true,
      now: new Date("2026-11-24T10:15:00Z"),
    });
  const plan = (r: ReturnType<typeof migrate>, id: string) => r.plans.find((p) => p.id === id);

  it("maps every agent to its starting level; the boss keeps none", () => {
    const r = migrate(false);
    const levels = Object.fromEntries(r.plans.map((p) => [p.id, p.level]));
    expect(levels).toEqual({
      "3d-designer": 4,
      boss: undefined,
      "code-reviewer": 1,
      "game-dev": 4,
      helper: 1,
      marketing: 2,
      seo: 3,
      "video-producer": 4,
      "web-dev": 4,
      "wp-maintainer": 4,
    });
    expect(plan(r, "boss")?.status).toBe("no-level");
    expect(r.report).toMatch(/boss: no level/);
  });

  it("never widens an agent outside the table", () => {
    const r = migrate(false);
    const helper = plan(r, "helper");
    expect(helper).toMatchObject({ status: "migrate", source: "subset", level: 1 });
    const before = legacyRights(parseManifest(AGENTS.helper as string, "before"), catalog);
    const after = parseManifest(helper?.text as string, "after");
    expect(withinRights(levelRights(after, catalog, true).rights, before)).toBe(true);
    expect(helper?.gained).toEqual([]);
    expect(helper?.lost).toEqual(
      expect.arrayContaining(["tool Edit", "tool Write", "host docs.example.com"]),
    );
  });

  it("leaves an agent outside the table unchanged when no level fits", () => {
    writeFileSync(join(home, "agents", "boss", "agent.yaml"), AGENTS.boss as string);
    mkdirSync(join(home, "agents", "idle"));
    writeFileSync(join(home, "agents", "idle", "agent.yaml"), head("idle", "tools: []\n"));
    const r = migrate(true);
    expect(plan(r, "idle")).toMatchObject({ status: "unfit" });
    expect(readFileSync(join(home, "agents", "idle", "agent.yaml"), "utf8")).toBe(
      head("idle", "tools: []\n"),
    );
    expect(r.report).toMatch(/idle: not migrated/);
  });

  it("drops and lists one-off literal commands", () => {
    const r = migrate(false);
    expect(plan(r, "web-dev")?.dropped).toEqual([
      "unzip -o /Users/owner/Downloads/theme-v2.zip",
      "unzip -o plugin-pack.zip",
    ]);
    expect(r.report).toContain("one-off commands dropped:");
    expect(r.report).toContain("    - unzip -o plugin-pack.zip");
    expect(plan(r, "web-dev")?.gained).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^free shell, in Claude's sandbox on this Mac/),
      ]),
    );
    expect(plan(r, "web-dev")?.lost).toContain(
      "shell: 5 listed command prefixes, on this Mac, no sandbox",
    );
  });

  it("sets game-dev's Unity binary as unsandboxed and the 3d-designer's host-shell flag", () => {
    const r = migrate(false);
    const game = parseManifest(plan(r, "game-dev")?.text as string, "game-dev");
    expect(game.unsandboxed).toEqual([UNITY]);
    expect(plan(r, "game-dev")?.warnings.join("\n")).toMatch(/Swift and Xcode/);
    expect(plan(r, "game-dev")?.dropped).toHaveLength(2);
    const designer = parseManifest(plan(r, "3d-designer")?.text as string, "3d-designer");
    expect(designer.keys_beside_host_shell).toBe(true);
    expect(plan(r, "3d-designer")?.exceptions).toEqual([
      "keys_beside_host_shell: true (owner-approved exception)",
    ]);
  });

  it("reports a missing Unity binary instead of guessing", () => {
    const text = (AGENTS["game-dev"] as string).replace(/ {4}- \/Applications.*-batchmode.*\n/, "");
    writeFileSync(join(home, "agents", "game-dev", "agent.yaml"), text);
    const p = plan(migrate(false), "game-dev");
    expect(parseManifest(p?.text as string, "game-dev").unsandboxed).toBeUndefined();
    expect(p?.warnings.join("\n")).toMatch(/no Unity editor binary/);
  });

  it("warns where keys meet a shell and local apps leave the run", () => {
    const r = migrate(false);
    expect(plan(r, "wp-maintainer")?.warnings.join("\n")).toMatch(/Apple container/);
    expect(plan(r, "marketing")?.lost).toEqual(
      expect.arrayContaining([
        "tool Bash",
        "shell: 2 listed command prefixes, in the Apple container",
      ]),
    );
    // The keyed meta account is gone at level 2.
    expect(plan(r, "marketing")?.lost).toEqual(
      expect.arrayContaining([expect.stringMatching(/^meta, after your review: meta_create_post/)]),
    );
    expect(plan(r, "seo")?.gained).toEqual([]);
    expect(plan(r, "seo")?.warnings.join("\n")).toMatch(/search-console \(account tools are not/);
    expect(plan(r, "3d-designer")?.warnings.join("\n")).toMatch(/Blender/);
  });

  it("a dry run writes nothing", () => {
    const before = files();
    const r = migrate(false);
    expect(files()).toEqual(before);
    expect(readdirSync(home).sort()).toEqual(["agents"]);
    expect(r.report).toMatch(/dry run, nothing written/);
    expect(r.report).toMatch(/levels migrate --write/);
    expect(r.report).toMatch(/no restart is needed/);
  });

  it("--write backs up, keeps comments, removes the lists and is idempotent", () => {
    const r = migrate(true);
    const backup = join(home, "backup-web-dev-agent-20261124-101500.yaml");
    expect(r.backups).toContain(backup);
    expect(r.backups).toHaveLength(9);
    expect(readFileSync(backup, "utf8")).toBe(AGENTS["web-dev"]);
    expect(r.reportFile).toBe(join(home, "levels-migration-20261124-101500.txt"));
    expect(readFileSync(r.reportFile as string, "utf8")).toBe(r.report);

    const web = readFileSync(join(home, "agents", "web-dev", "agent.yaml"), "utf8");
    expect(web).toContain("# Web developer: client sites.");
    expect(web).toContain("# the client repositories");
    expect(web).toMatch(/models:\n {2}default: cli-claude\/sonnet\nlevel: 4\n/);
    expect(web).not.toMatch(/^(tools|shell|container):/m);
    const m = parseManifest(web, "web-dev");
    expect(m).toMatchObject({
      level: 4,
      tools: [],
      network: { allow: ["developer.wordpress.org"] },
    });
    expect(m.shell).toBeUndefined();
    expect(m.budget.per_run_usd).toBe(2);
    const marketing = parseManifest(files().marketing as string, "marketing");
    expect(marketing).toMatchObject({ level: 2, mcp: ["meta"], network: { allow: [] } });
    expect(files().boss).toBe(AGENTS.boss);

    const after = files();
    const again = migrateLevels({
      home,
      catalog,
      write: true,
      containerAvailable: true,
      now: new Date("2026-11-24T11:00:00Z"),
    });
    expect(files()).toEqual(after);
    expect(again.backups).toEqual([]);
    expect(again.plans.filter((p) => p.status === "leveled")).toHaveLength(9);
    expect(again.report).toMatch(/web-dev: already has level 4, skipped/);
  });

  it("is wired as `achords levels migrate` (dry run by default)", () => {
    const run = (args: string[]) =>
      spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], {
        env: { ...process.env, ACHORDS_HOME: home, ACHORDS_KEYSTORE: "file" },
        encoding: "utf8",
      });
    const before = files();
    const dry = run(["levels", "migrate"]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/web-dev: level 4/);
    expect(files()).toEqual(before);
    expect(run(["levels", "migrate", "--dry-run", "--write"]).status).toBe(2);
    const write = run(["levels", "migrate", "--write"]);
    expect(write.status).toBe(0);
    expect(parseManifest(files()["web-dev"] as string, "w").level).toBe(4);
  });
});
