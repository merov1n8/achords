import { describe, expect, it } from "vitest";
import { type Catalog, type CatalogEntry, catalogEntrySchema } from "./catalog.ts";
import { historyRewrite } from "./check.ts";
import {
  type CompileInput,
  compileLevel,
  hostSandboxSettings,
  levelConflicts,
  REGISTRY_HOSTS,
} from "./compile.ts";
import { parseManifest } from "./manifest.ts";
import { allowRules, openWeb } from "./permissions.ts";

const entry = (raw: Record<string, unknown>): CatalogEntry => catalogEntrySchema.parse(raw);

// Keyed, with one tool of every class.
const META = entry({
  id: "meta",
  name: "Meta",
  command: "npx",
  env: { TOKEN: "vault:meta-token" },
  tools: {
    read: ["list_posts"],
    write: ["save_draft", "hide_comment", "publish_post", "boost_post"],
    class: {
      save_draft: "draft",
      hide_comment: "reversible",
      publish_post: "live",
      boost_post: "spend",
    },
  },
});
// Keyless local app (ADR-0054).
const BLENDER = entry({
  id: "blender",
  name: "Blender",
  command: "uvx",
  tools: {
    read: ["get_scene_info"],
    write: ["import_asset"],
    class: { import_asset: "reversible" },
  },
  app: { name: "Blender", open: ["-g", "-a", "Blender"] },
});
// Keyed, read tools only.
const GA4 = entry({
  id: "ga4",
  name: "GA4",
  command: "uvx",
  env: { TOKEN: "vault:ga4-token" },
  tools: { read: ["run_report"] },
});
const catalog: Catalog = new Map([
  ["meta", META],
  ["blender", BLENDER],
  ["ga4", GA4],
]);

const agent = (extra: string) =>
  parseManifest(
    `
id: maker
name: Maker
role: maker
workspace: studio
models:
  default: cli-claude/sonnet
  allowed: [cli-claude/sonnet, cli-codex/gpt-5, cli-gemini/gemini-3, local/qwen3]
fs:
  read: [/srv/ref]
  write: [/srv/work]
${extra}
`,
    "agent.yaml",
  );

const compile = (
  m: ReturnType<typeof agent>,
  level: number,
  over: { project?: CompileInput["project"]; run?: Partial<CompileInput["run"]> } = {},
) =>
  compileLevel(m, {
    level,
    project: over.project ?? { class: "secured" },
    catalog,
    run: { model: "cli-claude/sonnet", containerAvailable: true, ...over.run },
  });

describe("compileLevel (ADR-0067)", () => {
  it("level 0 is refused", () => {
    const c = compile(agent("level: 0"), 0);
    expect(c.refusal).toMatch(/switched off/);
  });

  it("level 1 reads its folders, nothing else", () => {
    const c = compile(agent("level: 1\nmcp: [meta]"), 1);
    expect(c.manifest.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(c.manifest.network.allow).toEqual([]);
    expect(c.manifest.shell).toBeUndefined();
    expect(c.manifest.mcp).toEqual([]);
    expect(c.manifest.container).toBe(false);
    // fs.write counts as read: the read rules cover both, no write rule.
    expect(
      allowRules({
        tools: c.manifest.tools,
        read: ["/srv/ref"],
        write: ["/srv/work"],
        network: [],
        shell: [],
      }),
    ).toEqual(["Read(//srv/work/**)", "Read(//srv/ref/**)"]);
  });

  it("level 2 writes its folders and reads the open web", () => {
    const c = compile(agent("level: 2\nmcp: [meta]"), 2);
    expect(c.manifest.tools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "WebFetch",
      "WebSearch",
    ]);
    expect(c.manifest.network.allow).toEqual(["*"]);
    expect(c.manifest.mcp).toEqual([]);
    expect(c.split).toBe(false);
    expect(openWeb(c.manifest, false)).toBe(true);
    // ADR-0051 kept: open web on a Claude model runs in a container.
    expect(c.manifest.container).toBe(true);
  });

  it("level 3 gets read, draft and reversible tools; live and spend always ask", () => {
    const c = compile(agent("level: 3\nmcp: [meta]"), 3);
    expect(c.integrations.meta).toEqual({
      tools: ["list_posts", "save_draft", "hide_comment"],
      publish: {
        mode: "review",
        tools: ["publish_post", "boost_post"],
        review: ["publish_post", "boost_post"],
      },
    });
    // Even with publish_mode auto, below level 5 they still ask.
    const auto = compile(agent("level: 4\nmcp: [meta]\npublish_mode: {default: auto}"), 4);
    expect(auto.integrations.meta?.publish?.review).toEqual(["publish_post", "boost_post"]);
  });

  it("level 5 follows publish_mode for live; spend asks on secured and on experimental unless switched off", () => {
    const m = agent("level: 5\nmcp: [meta]\npublish_mode: {default: auto}");
    const exp = compile(m, 5, { project: { class: "experimental" } });
    expect(exp.integrations.meta?.publish).toEqual({
      mode: "auto",
      tools: ["boost_post", "publish_post"],
      review: ["boost_post"],
    });
    const free = compile(m, 5, { project: { class: "experimental", spend_without_asking: true } });
    expect(free.integrations.meta?.publish?.review).toEqual([]);
    // A secured project never reaches 5 (ceiling), but the spend rule holds there regardless.
    const sec = compile(m, 5, { project: { class: "secured", spend_without_asking: true } });
    expect(sec.integrations.meta?.publish?.review).toEqual(["boost_post"]);
    // The project can forbid publishing: only read tools are left.
    const off = compile(m, 5, { project: { class: "experimental", publish: "off" } });
    expect(off.integrations.meta).toEqual({ tools: ["list_posts"] });
  });

  it("splits open web and draft+ account tools: work mode by default, web mode without them", () => {
    const m = agent("level: 3\nmcp: [meta, blender, ga4]");
    const acc = compile(m, 3);
    expect(acc.split).toBe(true);
    expect(acc.mode).toBe("accounts");
    expect(acc.manifest.tools).not.toContain("WebFetch");
    expect(acc.manifest.tools).not.toContain("WebSearch");
    expect(acc.manifest.network.allow).toEqual([]);
    expect(acc.manifest.mcp).toEqual(["meta", "blender", "ga4"]);

    const web = compile(m, 3, { run: { mode: "web" } });
    expect(web.mode).toBe("web");
    expect(openWeb(web.manifest, false)).toBe(true);
    // Keyed integrations leave; like every open-web Claude run, web mode runs in the container
    // (ADR-0051), where the local app is not reachable either.
    expect(web.manifest.container).toBe(true);
    expect(web.manifest.mcp).toEqual([]);
    expect(web.integrations).toEqual({});
    expect(web.unavailable.join(" ")).toMatch(/meta/);
    expect(web.unavailable.join(" ")).toMatch(/Blender on this Mac .*the open web/);
    // Outside a container (codex), a keyless integration keeps only its read tools.
    const codexWeb = compile(m, 3, { run: { mode: "web", model: "cli-codex/gpt-5" } });
    expect(codexWeb.integrations).toEqual({ blender: { tools: ["get_scene_info"] } });
  });

  it("no split for read-only accounts: the run has the web and its read tools", () => {
    const c = compile(agent("level: 3\nmcp: [ga4]"), 3);
    expect(c.split).toBe(false);
    expect(c.manifest.network.allow).toEqual(["*"]);
    expect(c.integrations.ga4).toEqual({ tools: ["run_report"] });
  });

  it("level 4 without keys or web gets a free shell in the CLI's host sandbox", () => {
    const c = compile(agent("level: 4\nmcp: [blender]"), 4);
    expect(c.sandbox).toBe("host");
    expect(c.manifest.tools).toContain("Bash");
    expect(c.manifest.shell).toBeUndefined();
    expect(c.manifest.container).toBe(false);
    // Blender (a local app, ADR-0054) stays reachable from the host.
    expect(c.manifest.mcp).toEqual(["blender"]);
  });

  it("level 4 without accounts is split too: work mode on the host without the open web, web mode without a shell", () => {
    // Like web-dev: a shell, no integrations, a documentation host in its remit.
    const m = agent('level: 4\nnetwork:\n  allow: ["*", "docs.example.com"]');
    const work = compile(m, 4);
    expect(work.split).toBe(true);
    expect(work.mode).toBe("accounts");
    expect(work.sandbox).toBe("host");
    expect(work.manifest.container).toBe(false);
    expect(work.manifest.tools).toContain("Bash");
    expect(work.manifest.tools).not.toContain("WebSearch");
    // Documentation hosts of the remit stay, never "*".
    expect(work.manifest.network.allow).toEqual(["docs.example.com"]);
    expect(openWeb(work.manifest, false)).toBe(false);
    const rules = allowRules({
      tools: work.manifest.tools,
      read: [],
      write: [],
      network: work.manifest.network.allow,
      shell: [],
    });
    expect(rules).toContain("WebFetch(domain:docs.example.com)");
    expect(rules).not.toContain("WebFetch");
    // The shell's sandbox reaches the registries and the remit hosts only.
    const box = hostSandboxSettings({
      write: [],
      own: [],
      network: work.manifest.network.allow,
      unsandboxed: [],
      achordsHome: "/h",
    }) as { sandbox: { network: { allowedDomains: string[] } } };
    expect(box.sandbox.network.allowedDomains).toEqual([...REGISTRY_HOSTS, "docs.example.com"]);

    const web = compile(m, 4, { run: { mode: "web" } });
    expect(web.mode).toBe("web");
    expect(web.sandbox).toBeUndefined();
    expect(web.manifest.tools).not.toContain("Bash");
    expect(web.manifest.tools).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
    expect(web.manifest.network.allow).toEqual(["*"]);
    // The open web runs in the container, as for every Claude run with it (ADR-0051).
    expect(web.manifest.container).toBe(true);
    expect(levelConflicts(m, catalog)).toEqual([]);
  });

  it("level 4 with keyed integrations runs in a container, without local apps (conflict)", () => {
    const m = agent("level: 4\nmcp: [meta, blender]");
    const c = compile(m, 4);
    expect(c.sandbox).toBe("container");
    expect(c.manifest.container).toBe(true);
    // The container keeps the work mode's network: no open web beside the shell.
    expect(c.mode).toBe("accounts");
    expect(c.manifest.network.allow).toEqual([]);
    expect(c.manifest.tools).not.toContain("WebSearch");
    expect(c.manifest.mcp).toEqual(["meta"]);
    expect(c.notes.join(" ")).toMatch(/without blender/);
    expect(levelConflicts(m, catalog)).toHaveLength(1);
    expect(levelConflicts(agent("level: 3\nmcp: [meta, blender]"), catalog)).toEqual([]);
    expect(levelConflicts(agent("level: 4\nmcp: [blender]"), catalog)).toEqual([]);
  });

  it("keys_beside_host_shell keeps keys and local apps beside a host-sandboxed shell", () => {
    const m = agent("level: 4\nmcp: [meta, blender]\nkeys_beside_host_shell: true");
    const c = compile(m, 4);
    expect(c.sandbox).toBe("host");
    expect(c.manifest.container).toBe(false);
    expect(c.manifest.mcp).toEqual(["meta", "blender"]);
    expect(c.notes).toEqual([]);
    expect(levelConflicts(m, catalog)).toEqual([]);
    // Never beside the open web: web mode has neither the shell nor the keys.
    const web = compile(m, 4, { run: { mode: "web" } });
    expect(web.sandbox).toBeUndefined();
    expect(web.manifest.tools).not.toContain("Bash");
    expect(web.manifest.container).toBe(true);
    expect(web.manifest.mcp).toEqual([]);
    // Ignored below level 4: no shell to keep beside the keys.
    expect(
      compile(agent("level: 3\nmcp: [meta]\nkeys_beside_host_shell: true"), 3).sandbox,
    ).toBeUndefined();
  });

  it("level 4 without a usable sandbox compiles to 3 and says why", () => {
    const c = compile(agent("level: 4\nmcp: [meta]"), 4, { run: { containerAvailable: false } });
    expect(c.level).toBe(3);
    expect(c.sandbox).toBeUndefined();
    expect(c.manifest.tools).not.toContain("Bash");
    expect(c.notes).toEqual([
      expect.stringMatching(/runs at level 3 instead of 4 .*Apple container/),
    ]);
    // The keyed integration keeps working without the shell.
    expect(c.manifest.mcp).toEqual(["meta"]);
  });

  it("codex and gemini use their own sandboxes, with the same modes", () => {
    const m = agent("level: 4\nmcp: [meta]");
    const codex = compile(m, 4, { run: { model: "cli-codex/gpt-5" } });
    expect(codex.sandbox).toBe("codex");
    expect(compile(m, 4, { run: { model: "cli-gemini/gemini-3" } }).sandbox).toBe("gemini");
    expect(codex.manifest.container).toBe(false);
    // Codex turns its network on only for a bare WebFetch rule: in web mode, never in work mode.
    const rules = (c: typeof codex) =>
      allowRules({
        tools: c.manifest.tools,
        read: [],
        write: [],
        network: c.manifest.network.allow,
        shell: [],
      });
    expect(rules(codex)).not.toContain("WebFetch");
    const codexWeb = compile(m, 4, { run: { model: "cli-codex/gpt-5", mode: "web" } });
    expect(codexWeb.sandbox).toBeUndefined();
    expect(codexWeb.manifest.tools).not.toContain("Bash");
    expect(rules(codexWeb)).toContain("WebFetch");
  });

  it("local models are capped at level 3 and never get the open web", () => {
    const c = compile(agent("level: 5\nmcp: [meta]"), 5, { run: { model: "local/qwen3" } });
    expect(c.level).toBe(3);
    expect(c.manifest.tools).not.toContain("Bash");
    expect(c.manifest.tools).not.toContain("WebFetch");
    expect(c.manifest.network.allow).toEqual([]);
    expect(c.split).toBe(false);
    expect(compile(agent("level: 2"), 2, { run: { model: "local/qwen3" } }).manifest.tools).toEqual(
      ["Read", "Glob", "Grep", "Edit", "Write"],
    );
  });

  it("push only at level 5 in work mode with a Claude shell", () => {
    const m = agent("level: 5\nmcp: [meta]");
    const exp = { project: { class: "experimental" as const } };
    expect(compile(m, 5, exp).push).toBe(true);
    expect(compile(m, 5, { ...exp, run: { mode: "web" } }).push).toBeUndefined();
    expect(compile(m, 4, exp).push).toBeUndefined();
    expect(compile(agent("level: 5"), 5, exp).push).toBe(true);
    expect(compile(m, 5, { ...exp, run: { model: "cli-codex/gpt-5" } }).push).toBeUndefined();
    // No container for keys beside a shell: level 3, no push.
    expect(compile(m, 5, { ...exp, run: { containerAvailable: false } }).push).toBeUndefined();
  });

  it("refuses an integration that is not in the catalog", () => {
    expect(compile(agent("level: 3\nmcp: [nope]"), 3).refusal).toMatch(/not in the catalog/);
  });
});

describe("host sandbox settings (ADR-0067 level 4)", () => {
  const settings = hostSandboxSettings({
    write: ["/home/u/.achords/agents/maker/work", "/home/u/.cache/tool"],
    own: ["/home/u/.achords/agents/maker/work", "/home/u/.achords/skills/shared", "/srv/ref"],
    network: ["*", "example.com", "www.beds24.com/api/"],
    unsandboxed: ["/Applications/Unity/Unity.app/Contents/MacOS/Unity"],
    achordsHome: "/home/u/.achords",
    userHome: "/home/u",
  }) as {
    sandbox: {
      enabled: boolean;
      failIfUnavailable: boolean;
      autoAllowBashIfSandboxed: boolean;
      allowUnsandboxedCommands: boolean;
      excludedCommands: string[];
      network: { allowedDomains: string[] };
      filesystem: { allowWrite: string[]; denyRead: string[]; allowRead: string[] };
    };
    permissions: { deny: string[]; allow: string[] };
  };

  it("sandboxes every command and never falls back to running unsandboxed", () => {
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
    });
  });

  it("writes only to the run's folders and reaches only registries and the run's hosts", () => {
    expect(settings.sandbox.filesystem.allowWrite).toEqual([
      "/home/u/.achords/agents/maker/work",
      "/home/u/.cache/tool",
    ]);
    expect(settings.sandbox.network.allowedDomains).toEqual([
      ...REGISTRY_HOSTS,
      "example.com",
      "www.beds24.com",
    ]);
    expect(settings.sandbox.network.allowedDomains).not.toContain("*");
  });

  it("denies reading achords' home (except the run's folders) and credential folders", () => {
    expect(settings.sandbox.filesystem.denyRead).toEqual([
      "/home/u/.achords",
      "/home/u/.ssh",
      "/home/u/.aws",
      "/home/u/.config/gh",
      "/home/u/.gnupg",
      "/home/u/Library/Keychains",
    ]);
    expect(settings.sandbox.filesystem.allowRead).toEqual([
      "/home/u/.achords/agents/maker/work",
      "/home/u/.achords/skills/shared",
    ]);
  });

  it("excludes only the remit's unsandboxed executables, and refuses push and history rewrite", () => {
    expect(settings.sandbox.excludedCommands).toEqual([
      "/Applications/Unity/Unity.app/Contents/MacOS/Unity",
    ]);
    expect(settings.permissions.allow).toEqual([
      "Bash(/Applications/Unity/Unity.app/Contents/MacOS/Unity:*)",
    ]);
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(["Bash(git push:*)", "Bash(git filter-branch:*)"]),
    );
    const none = hostSandboxSettings({
      write: [],
      own: [],
      network: [],
      unsandboxed: [],
      achordsHome: "/h",
    }) as { sandbox: { excludedCommands: string[] } };
    expect(none.sandbox.excludedCommands).toEqual([]);
  });

  it("a push run reaches the gateway and keeps every deny but push", () => {
    const base = { write: [], own: [], network: [], unsandboxed: [], achordsHome: "/h" };
    type S = {
      sandbox: { network: { allowedDomains: string[] } };
      permissions: { deny: string[]; allow: string[] };
    };
    const push = hostSandboxSettings({ ...base, push: { gatewayHost: "127.0.0.1" } }) as S;
    expect(push.sandbox.network.allowedDomains).toContain("127.0.0.1");
    expect(push.permissions.deny).toEqual(["Bash(git filter-branch:*)", "Bash(git filter-repo:*)"]);
    expect(push.permissions.allow).toEqual(["Bash(git push:*)"]);
    const level4 = hostSandboxSettings(base) as S;
    expect(level4.sandbox.network.allowedDomains).not.toContain("127.0.0.1");
    expect(level4.permissions.deny).toContain("Bash(git push:*)");
    expect(level4.permissions.allow).toEqual([]);
  });
});

describe("force push and history rewrite (ADR-0067)", () => {
  it("are refused, plain pushes are not", () => {
    for (const cmd of [
      "git push --force origin main",
      "git push -f",
      "git push origin main --force-with-lease",
      "git push --force-with-lease=main:abc",
      "git push --mirror backup",
      "git push -uf origin main",
      "git push origin +main",
      "git -C /srv/repo push --force",
      "cd /srv/repo && git push origin main -f",
      "git filter-branch --tree-filter x",
      "git filter-repo --path a",
    ]) {
      expect(historyRewrite(cmd), cmd).toBeDefined();
    }
    expect(historyRewrite("git push origin main")).toBeUndefined();
    expect(historyRewrite("git status")).toBeUndefined();
  });
});
