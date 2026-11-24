import { describe, expect, it } from "vitest";
import { type Catalog, type CatalogEntry, catalogEntrySchema } from "./catalog.ts";
import { patchManifestText } from "./edit.ts";
import { legacyBesideLevel, parseManifest } from "./manifest.ts";
import {
  isLiteralCommand,
  legacyRights,
  levelRights,
  planAgentMigration,
  unityBinaries,
  withinRights,
} from "./migrate.ts";

const entry = (raw: Record<string, unknown>): CatalogEntry => catalogEntrySchema.parse(raw);
const catalog: Catalog = new Map([
  [
    "meta",
    entry({
      id: "meta",
      name: "Meta",
      command: "npx",
      env: { TOKEN: "vault:meta-token" },
      tools: {
        read: ["list_posts"],
        write: ["save_draft", "publish_post"],
        class: { save_draft: "draft", publish_post: "live" },
      },
    }),
  ],
  ["notes", entry({ id: "notes", name: "Notes", command: "npx", tools: { read: ["search"] } })],
]);

const agent = (id: string, extra: string) => `# ${id}: hand-written notes stay.
id: ${id}
name: ${id}
role: ${id}
workspace: studio
models:
  default: cli-claude/sonnet
fs:
  write: [/srv/${id}] # its folder
${extra}`;
const plan = (id: string, extra: string) =>
  planAgentMigration(id, agent(id, extra), catalog, { containerAvailable: true });

describe("one-off literals and the Unity binary", () => {
  it("treats absolute paths and archive names as literals, prefixes not", () => {
    expect(isLiteralCommand("unzip -o /Users/me/Downloads/a.zip")).toBe(true);
    expect(isLiteralCommand("unzip -o theme.tar.gz")).toBe(true);
    expect(isLiteralCommand("~/bin/tool --x")).toBe(true);
    expect(isLiteralCommand("git status")).toBe(false);
    expect(isLiteralCommand("pnpm test")).toBe(false);
  });

  it("finds the editor binary, quoted or not, and nothing else", () => {
    const bin = "/Applications/Unity/Hub/Editor/6000.0.23f1/Unity.app/Contents/MacOS/Unity";
    expect(unityBinaries([`${bin} -batchmode -quit`, `${bin} -batchmode -runTests`])).toEqual([
      bin,
    ]);
    expect(
      unityBinaries([`"/Applications/My Unity/Unity.app/Contents/MacOS/Unity" -batchmode`]),
    ).toEqual(["/Applications/My Unity/Unity.app/Contents/MacOS/Unity"]);
    expect(
      unityBinaries([
        "open -a /Applications/Unity/Hub/Editor/6000.0.23f1/Unity.app",
        "/Applications/Unity Hub.app/Contents/MacOS/Unity Hub",
        "git status",
      ]),
    ).toEqual([]);
  });
});

describe("planAgentMigration (ADR-0067)", () => {
  it("never widens an agent outside the table: a listed shell stays at level 3 at most", () => {
    const extra = `tools: [Read, Glob, Grep, Edit, Write, WebFetch, WebSearch, Bash]
mcp: [notes]
shell:
  allow: [git status]
network:
  allow: ["*"]
`;
    const p = plan("helper", extra);
    expect(p).toMatchObject({ status: "migrate", source: "subset", gained: [] });
    expect(p.level).toBeLessThanOrEqual(3);
    const before = legacyRights(parseManifest(agent("helper", extra), "b"), catalog);
    const after = levelRights(parseManifest(p.text as string, "a"), catalog, true).rights;
    expect(withinRights(after, before)).toBe(true);
  });

  it("does not give an unknown agent draft tools it had only after review", () => {
    const extra = `tools: [Read, Glob, Grep, Edit, Write, WebFetch, WebSearch]
mcp: [meta]
network:
  allow: ["*"]
`;
    // Level 3 would make save_draft direct; level 2 drops meta instead.
    expect(plan("poster", extra)).toMatchObject({ level: 2, source: "subset" });
    const auto = `${extra}publish_mode:\n  default: auto\n`;
    expect(plan("poster", auto)).toMatchObject({ level: 3 });
  });

  it("leaves agents with a level, the boss and broken manifests alone", () => {
    expect(plan("x", "level: 2\n")).toMatchObject({ status: "leveled", level: 2 });
    expect(plan("boss", "tools: []\n")).toMatchObject({ status: "no-level" });
    expect(plan("x", "bogus: 1\n")).toMatchObject({ status: "invalid" });
    expect(plan("x", "tools: []\n")).toMatchObject({ status: "unfit" });
  });

  it("writes the level after models, keeps comments and remit, removes the lists", () => {
    const p = plan(
      "web-dev",
      `tools: [Read, Edit, Bash]
# shell grown by approvals
shell:
  allow: [git status, unzip -o site.zip]
network:
  allow: ["*", developer.wordpress.org]
container: false
`,
    );
    expect(p.dropped).toEqual(["unzip -o site.zip"]);
    expect(p.text).toContain("# web-dev: hand-written notes stay.");
    expect(p.text).toContain("write: [/srv/web-dev] # its folder");
    expect(p.text).toMatch(/default: cli-claude\/sonnet\nlevel: 4\nfs:/);
    expect(p.text).toMatch(/network:\n {2}allow: \[developer.wordpress.org\]/);
    expect(p.text).not.toMatch(/^(tools|shell|container):/m);
  });

  it("game-dev: one Unity binary becomes unsandboxed, several are reported", () => {
    const bin = "/Applications/Unity/Hub/Editor/6000.0.23f1/Unity.app/Contents/MacOS/Unity";
    const one = plan("game-dev", `tools: [Bash]\nshell:\n  allow: ["${bin} -batchmode"]\n`);
    expect(one.text).toContain(`unsandboxed: [${bin}]`);
    const two = plan(
      "game-dev",
      `tools: [Bash]\nshell:\n  allow: ["${bin} -batchmode", "${bin.replace("6000.0.23f1", "2022.3.1f1")} -batchmode"]\n`,
    );
    expect(two.text).not.toContain("unsandboxed");
    expect(two.warnings.join("\n")).toMatch(/several Unity editor binaries/);
  });
});

describe("patchManifestText level fields", () => {
  it("adds level and remit exceptions next to models", () => {
    const text = patchManifestText(agent("d", "tools: [Read]\n"), {
      level: 4,
      keys_beside_host_shell: true,
      drop: ["tools"],
    });
    expect(text).toMatch(/default: cli-claude\/sonnet\nlevel: 4\nkeys_beside_host_shell: true\n/);
  });
});

describe("legacyBesideLevel", () => {
  it("names the replaced fields next to a level only", () => {
    const m = (extra: string) => parseManifest(agent("x", extra), "x");
    expect(legacyBesideLevel(m("tools: [Read]\n"))).toEqual([]);
    expect(legacyBesideLevel(m("level: 2\nnetwork:\n  allow: [docs.example.com]\n"))).toEqual([]);
    expect(
      legacyBesideLevel(
        m('level: 2\ntools: [Read]\nshell:\n  allow: [ls]\nnetwork:\n  allow: ["*"]\n'),
      ),
    ).toEqual(["tools", "shell", 'network "*"', "container"]);
  });
});
