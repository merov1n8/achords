import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerOwnerQuestion,
  cardKey,
  createThread,
  getSetting,
  getTask,
  handoffHops,
  listMessages,
  openCoreDatabase,
  setSetting,
  type Task,
  threadCard,
} from "@achords/core";
import {
  createProject,
  type LiveGuard,
  liveRefusal,
  loadCatalog,
  updateProject,
} from "@achords/policy";
import type { ModelProvider, RunRequest, RunResult } from "@achords/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpTickets, createRunTokens, type McpLaunch } from "../mcp/tokens.ts";
import { createOrchestrator, type Orchestrator } from "./orchestrator.ts";

const result = (): RunResult => ({
  ok: true,
  stopReason: "completed",
  text: "done",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  windows: [],
  durationMs: 1,
});

// ADR-0067 step 2: agents with a `level` run with what it compiles to; agents without one keep
// their lists (every other orchestrator test).
describe("permission levels in runs (ADR-0067)", () => {
  let home: string;
  let db: ReturnType<typeof openCoreDatabase>;
  let orch: Orchestrator;
  let seen: { req: RunRequest; config: string | undefined; task: Task }[];
  let launches: McpLaunch[];
  let onRun: ((task: Task) => void) | undefined;
  // Vault reads (ref, actor) and the ids that are set, for the push token.
  let reads: { ref: string; actor: string }[];
  let gitTokens: Set<string>;
  // What the gateway was asked to push (the real plumbing is tested in git-push.test.ts).
  let pushes: { folder: string; branch: string; url: string; token: string }[];

  const agent = (id: string, extra: string, model = "cli-claude/sonnet") => {
    mkdirSync(join(home, "agents", id), { recursive: true });
    writeFileSync(
      join(home, "agents", id, "agent.yaml"),
      `id: ${id}\nname: ${id}\nrole: ${id}\nworkspace: web-clients\nmodels:\n  default: ${model}\n${extra}\n`,
    );
  };

  const build = (container: boolean, hosted = true) => {
    const tickets = createMcpTickets();
    const issue = tickets.issue.bind(tickets);
    tickets.issue = (launch) => {
      launches.push(launch);
      return issue(launch);
    };
    const p: ModelProvider = {
      id: "cli-claude",
      async run(req) {
        const row = db.prepare("SELECT id FROM tasks WHERE status = 'claimed'").get();
        const config = req.mcpConfigPath ? readFileSync(req.mcpConfigPath, "utf8") : undefined;
        const task = getTask(db, String(row?.id)) as Task;
        seen.push({ req, config, task });
        onRun?.(task);
        return result();
      },
    };
    orch = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": p },
      hub: { url: "http://127.0.0.1:7420", tokens: createRunTokens(), serverEntry: "/x/server.ts" },
      ...(container
        ? {
            container: {
              prepare: async () => ({
                ready: true as const,
                bin: "container",
                image: "img",
                hubUrl: "http://192.168.64.1:7420",
              }),
              claudeLogin: () => ({ CLAUDE_CODE_OAUTH_TOKEN: "t" }),
              codeDirs: [],
            },
          }
        : {}),
      integrations: {
        catalog: () => loadCatalog(join(home, "no-seed"), join(home, "catalog")),
        tickets,
        launcherEntry: "/x/launch.ts",
        // ADR-0055: keyed servers on the gateway's side, reached through a relay.
        ...(hosted
          ? {
              relayEntry: "/x/relay.ts",
              host: {
                register: (_id: string, launch: McpLaunch) => {
                  launches.push(launch);
                  return { token: "relay", revoke: () => {} };
                },
              },
            }
          : {}),
        builtins: {},
        resolveSecret: (ref: string, actor: string) => {
          reads.push({ ref, actor });
          const id = ref.slice("vault:".length);
          if (id.startsWith("git-token-") && !gitTokens.has(id)) {
            throw new Error(`secret ${id} is not set`);
          }
          return id.startsWith("git-token-") ? "ghp_push-token-value" : "secret-value";
        },
        call: async () => ({ ok: true, text: "ok" }),
      },
      gitIdentity: () => ({
        GIT_AUTHOR_NAME: "Owner",
        GIT_COMMITTER_NAME: "Owner",
        GIT_AUTHOR_EMAIL: "owner@example.com",
        GIT_COMMITTER_EMAIL: "owner@example.com",
      }),
      gitPush: async (input) => {
        pushes.push(input);
        return { ok: true, text: `pushed ${input.branch}` };
      },
    });
    orch.syncAgents();
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-levels-"));
    const catalogDir = join(home, "catalog");
    mkdirSync(catalogDir);
    // Keyed: one tool per class.
    writeFileSync(
      join(catalogDir, "social.yaml"),
      `id: social\nname: Social\ncommand: npx\nargs: ["social@1.0.0"]\nenv:\n  KEY: "vault:social-key"\ntools:\n  read: [list_posts]\n  write: [save_draft, publish_post, boost_post]\n  class:\n    save_draft: draft\n    boost_post: spend\n`,
    );
    // Keyless local app (ADR-0054) with a reversible write tool.
    writeFileSync(
      join(catalogDir, "blender.yaml"),
      `id: blender\nname: Blender\ncommand: uvx\nargs: ["blender-mcp==1.0.0"]\napp: { name: Blender, open: ["-g", "-a", "Blender"] }\ntools:\n  read: [get_scene_info]\n  write: [import_asset]\n  class:\n    import_asset: reversible\n`,
    );
    agent("boss", "tools: []");
    agent("reader", "level: 1\nmcp: [social]");
    agent("author", "level: 2");
    agent("operator", "level: 3\nmcp: [social]\npublish_mode:\n  default: auto");
    agent("full", "level: 5\nmcp: [social]\npublish_mode:\n  default: auto");
    agent(
      "builder",
      "level: 4\nmcp: [blender]\nunsandboxed: [/opt/unity/Unity]\nfs:\n  write: [/tmp/achords-levels-cache]",
    );
    agent("keyed-builder", "level: 4\nmcp: [social, blender]");
    agent("designer", "level: 4\nmcp: [social, blender]\nkeys_beside_host_shell: true");
    agent("off", "level: 0");
    // Like web-dev: a shell, no accounts, a documentation host in its remit.
    agent("webdev", 'level: 4\nnetwork:\n  allow: ["*", "docs.example.com"]');
    createProject(join(home, "projects"), { slug: "acme", name: "Acme", workspace: "web-clients" });
    createProject(join(home, "projects"), {
      slug: "lab",
      name: "Lab",
      workspace: "web-clients",
      class: "experimental",
    });
    db = openCoreDatabase(join(home, "core.db"));
    seen = [];
    launches = [];
    reads = [];
    gitTokens = new Set();
    pushes = [];
    onRun = undefined;
    build(true);
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const give = async (agentId: string, project?: string) => {
    const thread = createThread(db, project ? { project } : {});
    const r = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: agentId, title: "Work", instructions: "go" },
    );
    if (!r.ok) throw new Error(r.reason);
    for (let i = 0; i < 5 && (await orch.workOnce()); i++);
    return { task: getTask(db, r.taskId) as Task, thread };
  };
  const hubTools = (config: string | undefined) =>
    String(JSON.parse(config ?? "{}").mcpServers?.achords?.env.ACHORDS_TOOLS ?? "").split(",");

  it("level 1 reads, level 2 also writes and has the open web", async () => {
    await give("reader", "acme");
    expect(seen[0]?.req.tools).toEqual(["Read", "Glob", "Grep", "TodoWrite"]);
    // No integrations below level 3.
    expect(launches).toEqual([]);
    await give("author", "acme");
    const req = seen[1]?.req;
    expect(req?.tools).toEqual(expect.arrayContaining(["Edit", "Write", "WebFetch", "WebSearch"]));
    expect(req?.allowedTools).toContain("WebFetch");
    expect(req?.tools).not.toContain("Bash");
    // Unchanged: no split at level 2, and the open web runs in a container (ADR-0051).
    expect(req?.container).toBeDefined();
    expect(hubTools(seen[1]?.config)).not.toContain("handoff");
  });

  it("level 0 gets no work: delegation and card assignment are refused", () => {
    const thread = createThread(db, {});
    expect(
      orch.delegate(
        { from: "boss", threadId: thread.id },
        { agent: "off", title: "x", instructions: "x" },
      ),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/level 0/) });
    expect(orch.createCard({ title: "x", agent: "off" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/level 0/),
    });
  });

  it("level 3 splits: work mode without web, live and spend always ask; self-handoff switches to web", async () => {
    let first: Task | undefined;
    onRun = (t) => {
      if (first) return;
      first = t;
      // A non-split agent may not hand off to itself; this one may, once.
      expect(
        orch.handoff(
          { from: "task", taskId: t.id },
          { agent: "operator", title: "Research", instructions: "look up" },
        ),
      ).toEqual({ ok: true });
    };
    const { task } = await give("operator", "acme");
    const acc = seen[0];
    expect(acc?.req.tools).not.toContain("WebFetch");
    expect(acc?.req.tools).not.toContain("WebSearch");
    expect(acc?.req.prompt).toMatch(/work mode/);
    expect(hubTools(acc?.config)).toContain("handoff");
    expect(acc?.req.allowedTools).toEqual(
      expect.arrayContaining(["mcp__social__list_posts", "mcp__social__save_draft"]),
    );
    // publish_mode auto, but live and spend below level 5 go to review.
    expect(launches[0]?.publish).toMatchObject({
      mode: "auto",
      tools: ["publish_post", "boost_post"],
      review: ["publish_post", "boost_post"],
    });
    expect(task.status).toBe("done");
    // The successor is the same agent in web mode, and the switch counts as a hop.
    const web = seen[1];
    expect(web?.task.assigneeAgentId).toBe("operator");
    expect(web?.task.runMode).toBe("web");
    expect(handoffHops(db, web?.task as Task)).toBe(1);
    expect(web?.req.tools).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
    expect(web?.req.allowedTools.some((t) => t.startsWith("mcp__social__"))).toBe(false);
    expect(web?.req.prompt).toMatch(/web mode/);
    expect(launches).toHaveLength(1);
  });

  it("an agent without a split cannot hand off to itself", async () => {
    let out: unknown;
    onRun = (t) => {
      out = orch.handoff(
        { from: "task", taskId: t.id },
        { agent: "author", title: "x", instructions: "x" },
      );
    };
    await give("author", "acme");
    expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/cycle/) });
  });

  it("level 5 is capped at 4 on a secured project; on an experimental one live follows publish_mode", async () => {
    await give("full", "acme");
    expect(launches[0]?.publish?.review).toEqual(["publish_post", "boost_post"]);
    // Capped at 4: a builder's shell (in the container, next to keys), no live without asking.
    expect(seen[0]?.req.tools).toContain("Bash");
    await give("full", "lab");
    // Spend still asks unless the project switches it off.
    expect(launches[1]?.publish).toMatchObject({ mode: "auto", review: ["boost_post"] });
    updateProject(join(home, "projects"), "lab", { spend_without_asking: true });
    await give("full", "lab");
    expect(launches[2]?.publish?.review).toEqual([]);
  });

  it("level 4 without accounts: work mode on the host sandbox without the open web; self-handoff to web mode in the container without a shell", async () => {
    let first = true;
    onRun = (t) => {
      if (!first) return;
      first = false;
      expect(
        orch.handoff(
          { from: "task", taskId: t.id },
          { agent: "webdev", title: "Research", instructions: "look up" },
        ),
      ).toEqual({ ok: true });
    };
    await give("webdev", "acme");
    const work = seen[0];
    expect(work?.req.tools).toContain("Bash");
    expect(work?.req.tools).not.toContain("WebSearch");
    expect(work?.req.allowedTools).not.toContain("WebFetch");
    expect(work?.req.allowedTools).toContain("WebFetch(domain:docs.example.com)");
    expect(work?.req.container).toBeUndefined();
    expect(work?.req.prompt).toMatch(/work mode/);
    expect(hubTools(work?.config)).toContain("handoff");
    const box = JSON.parse(work?.req.settings ?? "{}").sandbox;
    expect(box.enabled).toBe(true);
    expect(box.network.allowedDomains).toEqual(
      expect.arrayContaining(["registry.npmjs.org", "pypi.org", "docs.example.com"]),
    );
    expect(box.network.allowedDomains).not.toContain("*");
    // The switch: the same agent in web mode, counted as a hop, in the container (ADR-0051, as
    // every open-web run) without a shell.
    const web = seen[1];
    expect(web?.task.assigneeAgentId).toBe("webdev");
    expect(web?.task.runMode).toBe("web");
    expect(handoffHops(db, web?.task as Task)).toBe(1);
    expect(web?.req.tools).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
    expect(web?.req.tools).not.toContain("Bash");
    expect(web?.req.container).toBeDefined();
    expect(JSON.parse(web?.req.settings ?? "{}").sandbox).toBeUndefined();
    expect(web?.req.prompt).toMatch(/web mode/);
  });

  it("web mode without a container install fails as any open-web run does (ADR-0051)", async () => {
    build(false);
    const thread = createThread(db, { project: "acme" });
    const r = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: "webdev", title: "Work", instructions: "go" },
    );
    if (!r.ok) throw new Error(r.reason);
    db.prepare("UPDATE tasks SET run_mode = 'web' WHERE id = ?").run(r.taskId);
    for (let i = 0; i < 5 && (await orch.workOnce()); i++);
    expect(seen).toEqual([]);
    expect(getTask(db, r.taskId)?.error).toMatch(/cannot run agents in a container/);
  });

  it("a chain's full access (ADR-0035) does not reach a leveled agent: the scopes replace it", async () => {
    const thread = createThread(db, { project: "acme" });
    const r = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: "designer", title: "Work", instructions: "go" },
    );
    if (!r.ok) throw new Error(r.reason);
    const task = getTask(db, r.taskId) as Task;
    setSetting(db, `elevation:${task.rootId ?? task.id}`, String(Date.now() + 60_000));
    for (let i = 0; i < 5 && (await orch.workOnce()); i++);
    const req = seen[0]?.req;
    // Work mode as without it: the shell and the accounts, no open web.
    expect(req?.tools).toContain("Bash");
    expect(req?.tools).not.toContain("WebSearch");
    expect(req?.allowedTools).toContain("mcp__social__save_draft");
    expect(req?.prompt).not.toMatch(/full access/);
  });

  it("level 4 in work mode without keys: a free shell in the CLI's host sandbox", async () => {
    await give("builder");
    const req = seen[0]?.req;
    expect(req?.tools).toContain("Bash");
    // No command list but a bare Bash rule: the env scrub turns the CLI's sandbox auto-allow
    // off, and the sandbox itself (failIfUnavailable, no unsandboxed fallback) still applies.
    expect(req?.allowedTools).toContain("Bash");
    expect(req?.allowedTools?.some((r) => r.startsWith("Bash(") && !r.startsWith("Bash(/"))).toBe(
      false,
    );
    expect(JSON.parse(req?.settings ?? "{}").sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
    });
    expect(req?.container).toBeUndefined();
    // The local app stays reachable from the host.
    expect(req?.allowedTools).toContain("mcp__blender__import_asset");
    const settings = JSON.parse(req?.settings ?? "{}");
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: ["/opt/unity/Unity"],
    });
    expect(settings.sandbox.filesystem.allowWrite).toEqual(
      expect.arrayContaining([expect.stringMatching(/\/tmp\/achords-levels-cache$/)]),
    );
    // Nothing of the user's home or achords' home but the run's folders (and toolchains).
    expect(settings.sandbox.filesystem.denyRead.slice(0, 2)).toEqual([
      homedir(),
      expect.stringMatching(/achords-levels-/),
    ]);
    expect(settings.sandbox.filesystem.denyRead).toContain(join(homedir(), ".npmrc"));
    expect(settings.permissions.deny).toContain("Bash(git push:*)");
    // Package caches in a folder of this run, writable, removed afterwards.
    const cache = settings.sandbox.filesystem.allowWrite.find((p: string) =>
      /\/run\/cache-[\w-]+$/.test(p),
    );
    expect(cache).toBeDefined();
    expect(settings.sandbox.filesystem.allowRead).toContain(cache);
    expect(req?.env).toMatchObject({
      npm_config_cache: join(cache, "npm"),
      PIP_CACHE_DIR: join(cache, "pip"),
      GIT_AUTHOR_NAME: "Owner",
      GIT_COMMITTER_EMAIL: "owner@example.com",
    });
    expect(existsSync(cache)).toBe(false);
    // No request_command: there is no list to ask for.
    expect(hubTools(seen[0]?.config)).not.toContain("request_command");
  });

  it("level 4 next to keyed integrations runs in a container, without its local app", async () => {
    const { thread } = await give("keyed-builder", "acme");
    const req = seen[0]?.req;
    expect(req?.tools).toContain("Bash");
    expect(req?.container).toBeDefined();
    expect(req?.allowedTools).toContain("Bash");
    expect(req?.allowedTools.some((t) => t.startsWith("mcp__blender__"))).toBe(false);
    expect(req?.allowedTools).toContain("mcp__social__save_draft");
    expect(JSON.parse(req?.settings ?? "{}").permissions.deny).toContain("Bash(git push:*)");
    // The container keeps the work mode's network: no open web beside the shell.
    expect(req?.tools).not.toContain("WebSearch");
    expect(req?.tools).not.toContain("WebFetch");
    // The conflict is said in the chat.
    expect(
      listMessages(db, thread.id)
        .map((m) => m.content)
        .join("\n"),
    ).toMatch(/without blender in this task/);
  });

  it("without a container install, level 4 next to keys runs at 3 and says why", async () => {
    build(false);
    const { thread } = await give("keyed-builder", "acme");
    expect(seen[0]?.req.tools).not.toContain("Bash");
    expect(
      listMessages(db, thread.id)
        .map((m) => m.content)
        .join("\n"),
    ).toMatch(/runs at level 3 instead of 4 .*Apple container/);
    // Without a shell nothing needs the container: the local app and the keys both stay.
    expect(seen[0]?.req.allowedTools).toEqual(
      expect.arrayContaining(["mcp__blender__import_asset", "mcp__social__save_draft"]),
    );
  });

  it("keys_beside_host_shell (owner-approved): keys and local app beside a host-sandboxed shell", async () => {
    const { thread } = await give("designer", "acme");
    const req = seen[0]?.req;
    expect(req?.tools).toContain("Bash");
    expect(req?.container).toBeUndefined();
    expect(req?.allowedTools).toContain("Bash");
    expect(req?.allowedTools).toEqual(
      expect.arrayContaining(["mcp__blender__import_asset", "mcp__social__save_draft"]),
    );
    const settings = JSON.parse(req?.settings ?? "{}");
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.filesystem.denyRead[1]).toMatch(/achords-levels-/);
    // Still never next to the open web.
    expect(req?.tools).not.toContain("WebFetch");
    expect(
      listMessages(db, thread.id)
        .map((m) => m.content)
        .join("\n"),
    ).not.toMatch(/without/);
    // Never when the keys would be started inside the run.
    build(true, false);
    const { task } = await give("designer", "acme");
    expect(task.error).toMatch(/served by the gateway/);
  });

  it("request_command: a leveled shell has no list; force push is refused for everyone", async () => {
    agent("legacy", 'tools: [Read, Bash]\nshell:\n  allow: ["git status"]');
    orch.syncAgents();
    let leveled: unknown;
    let legacy: unknown;
    onRun = (t) => {
      const from = { from: "task" as const, taskId: t.id };
      if (t.assigneeAgentId === "builder") {
        leveled = orch.requestCommand(from, { command: "make", reason: "x" });
      } else {
        legacy = orch.requestCommand(from, {
          command: "git push --force origin main",
          reason: "x",
        });
      }
    };
    await give("builder");
    await give("legacy");
    expect(leveled).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/request_permission/),
    });
    expect(legacy).toMatchObject({ ok: false, reason: expect.stringMatching(/force push/) });
  });
  describe("push_branch at level 5: the gateway pushes, the shell has no credential", () => {
    const repos = () =>
      updateProject(join(home, "projects"), "lab", {
        integrations: {
          repository: ["https://github.com/acme/site", "https://github.com/acme/other"],
        },
      });
    const site = "https://github.com/acme/site";
    // A plain repository in the run's work folder (the real git plumbing: git-push.test.ts).
    const repoIn = (dir: string) => {
      mkdirSync(join(dir, "app", ".git", "objects"), { recursive: true });
      return join(dir, "app");
    };
    const expectHardened = (req: RunRequest | undefined) =>
      expect(req?.env).toMatchObject({
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/usr/bin/false",
        SSH_ASKPASS: "/usr/bin/false",
        GCM_INTERACTIVE: "never",
      });

    it("a level 5 work-mode run gets the tool; the gateway pushes with the vault's token, audited", async () => {
      agent("pusher", "level: 5");
      orch.syncAgents();
      repos();
      gitTokens.add("git-token-lab");
      const answers: Promise<unknown>[] = [];
      onRun = (t) => {
        const from = { from: "task" as const, taskId: t.id };
        const cwd = seen.at(-1)?.req.cwd as string;
        const repo = repoIn(cwd);
        mkdirSync(join(cwd, "plain"), { recursive: true });
        const push = (folder: string, branch: string, remoteUrl?: string) =>
          orch.pushBranch(from, { folder, branch, ...(remoteUrl ? { remoteUrl } : {}) });
        answers.push(
          push(repo, "fix/login", site),
          // Several repositories: one must be named.
          push(repo, "fix/login"),
          push(repo, "+main", site),
          push(repo, "main:main", site),
          push(repo, "-f", site),
          push(repo, "main", "https://github.com/someone/else"),
          push(join(cwd, "plain"), "main", site),
          push("/tmp", "main", site),
          push(join(cwd, "..", "..", "pusher"), "main", site),
        );
      };
      const { task } = await give("pusher", "lab");
      const out = await Promise.all(answers);
      expect(out[0]).toEqual({ ok: true, text: "pushed fix/login" });
      expect(pushes).toEqual([
        {
          folder: expect.stringMatching(/\/app$/),
          branch: "fix/login",
          url: site,
          token: "ghp_push-token-value",
        },
      ]);
      expect(out[1]).toMatchObject({ ok: false, reason: expect.stringMatching(/remote_url/) });
      for (const r of out.slice(2, 5)) {
        expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/branch name/) });
      }
      expect(out[5]).toMatchObject({ ok: false, reason: expect.stringMatching(/not an https/) });
      expect(out[6]).toMatchObject({ ok: false, reason: expect.stringMatching(/plain git/) });
      expect(out[7]).toMatchObject({ ok: false, reason: expect.stringMatching(/work folders/) });
      expect(out[8]).toMatchObject({ ok: false, reason: expect.stringMatching(/work folders/) });
      // One audited vault read, for the one push that went out.
      expect(reads.filter((r) => r.ref.startsWith("vault:git-token"))).toEqual([
        {
          ref: "vault:git-token-lab",
          actor: "agent:pusher/git-push:lab:github.com/acme/site:fix/login",
        },
      ]);
      const req = seen[0]?.req;
      expect(hubTools(seen[0]?.config)).toContain("push_branch");
      expect(req?.prompt).toMatch(/call push_branch/);
      // The run itself never holds the token or a way to ask for it.
      const run = JSON.stringify({ req, config: seen[0]?.config });
      expect(run).not.toContain("ghp_");
      expect(run).not.toMatch(/ACHORDS_GIT_TOKEN|api\/agent\/git-credential|git_credential/);
      expect(JSON.stringify(out)).not.toContain("ghp_");
      expectHardened(req);
      const settings = JSON.parse(req?.settings ?? "{}");
      expect(settings.permissions.deny).toContain("Bash(git push:*)");
      expect(settings.permissions.allow).not.toContain("Bash(git push:*)");
      // Only the co-author hook every claude run has.
      expect(settings.hooks.PreToolUse.map((h: { matcher: string }) => h.matcher)).toEqual([
        "Bash",
      ]);
      // After the run, no more pushes.
      expect(
        await orch.pushBranch({ from: "task", taskId: task.id }, { folder: "/x", branch: "main" }),
      ).toMatchObject({ ok: false, reason: expect.stringMatching(/cannot push/) });
    });

    it("no token for the project: refused, nothing pushed", async () => {
      agent("pusher", "level: 5");
      orch.syncAgents();
      updateProject(join(home, "projects"), "lab", { integrations: { repository: [site] } });
      let answer: Promise<unknown> | undefined;
      onRun = (t) => {
        const repo = repoIn(seen.at(-1)?.req.cwd as string);
        answer = orch.pushBranch({ from: "task", taskId: t.id }, { folder: repo, branch: "main" });
      };
      await give("pusher", "lab");
      expect(await answer).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/git-token-lab/),
      });
      expect(pushes).toEqual([]);
    });

    it("level 4, a secured project and web mode: no tool, every shell hardened", async () => {
      agent("pusher", "level: 5");
      agent("builder4", "level: 4");
      agent("legacy", 'tools: [Read, Bash]\nshell:\n  allow: ["git status"]');
      orch.syncAgents();
      repos();
      updateProject(join(home, "projects"), "acme", { integrations: { repository: [site] } });
      gitTokens.add("git-token-lab").add("git-token-acme");
      const answers: Promise<unknown>[] = [];
      onRun = (t) => {
        const repo = repoIn(seen.at(-1)?.req.cwd as string);
        answers.push(
          orch.pushBranch(
            { from: "task", taskId: t.id },
            { folder: repo, branch: "main", remoteUrl: site },
          ),
        );
      };
      await give("builder4", "lab");
      // Capped at 4 on the secured project.
      await give("pusher", "acme");
      await give("legacy");
      const thread = createThread(db, { project: "lab" });
      const r = orch.delegate(
        { from: "boss", threadId: thread.id },
        { agent: "pusher", title: "Research", instructions: "go" },
      );
      if (!r.ok) throw new Error(r.reason);
      db.prepare("UPDATE tasks SET run_mode = 'web' WHERE id = ?").run(r.taskId);
      for (let i = 0; i < 5 && (await orch.workOnce()); i++);
      expect(seen).toHaveLength(4);
      for (const [i, s] of seen.entries()) {
        expect(hubTools(s.config), `run ${i}`).not.toContain("push_branch");
        expect(s.req.prompt).not.toMatch(/push_branch/);
        expectHardened(s.req);
        expect(await answers[i]).toMatchObject({ ok: false });
      }
      // Web mode: no shell at all.
      expect(seen[3]?.req.tools).not.toContain("Bash");
      expect(pushes).toEqual([]);
      expect(reads.filter((x) => x.ref.startsWith("vault:git-token"))).toEqual([]);
    });

    it("in the container: the tool too, the git hardening passed into the VM", async () => {
      repos();
      await give("full", "lab");
      const req = seen[0]?.req;
      expect(req?.container).toBeDefined();
      expect(hubTools(seen[0]?.config)).toContain("push_branch");
      expect(JSON.parse(req?.settings ?? "{}").permissions).toEqual({
        deny: ["Bash(git push:*)", "Bash(git filter-branch:*)", "Bash(git filter-repo:*)"],
      });
      expectHardened(req);
    });

    it("a shell push or a remote deletion cannot be requested; force push stays refused", async () => {
      agent("pusher", "level: 5");
      orch.syncAgents();
      repos();
      const outs: unknown[] = [];
      onRun = (t) => {
        const ask = (target: string) =>
          orch.requestPermission(
            { from: "task", taskId: t.id },
            { kind: "command", target, reason: "x" },
          );
        outs.push(
          ask("git push --force origin main"),
          ask("git push origin main"),
          ask("git push origin --delete old"),
          ask("sh -c 'git push origin :old'"),
        );
      };
      await give("pusher", "lab");
      expect(outs[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/force push/) });
      for (const o of outs.slice(1)) {
        expect(o).toMatchObject({ ok: false, reason: expect.stringMatching(/push_branch/) });
      }
    });
  });

  describe("approvals: once, for this card, always (ADR-0067 step 4)", () => {
    const drain = async () => {
      for (let i = 0; i < 12 && (await orch.workOnce()); i++);
    };
    const ask = (taskId: string, kind: string, target: string) =>
      orch.requestPermission({ from: "task", taskId }, { kind, target, reason: "needed" });
    const last = (threadId: string) => listMessages(db, threadId).at(-1);
    const buttons = (threadId: string) =>
      last(threadId)?.actions?.map((a) => a.data.split(":").slice(0, 2).join(":"));
    const idOf = (threadId: string) => last(threadId)?.actions?.[0]?.data.split(":")[2] as string;
    const yaml = (id: string) => readFileSync(join(home, "agents", id, "agent.yaml"), "utf8");
    /** Starts a card; its first run asks, later runs do `then`. */
    const askFirst = async (
      agentId: string,
      project: string,
      kind: string,
      target: string,
      then?: (t: Task, run: number) => void,
    ) => {
      let run = 0;
      let out: unknown;
      onRun = (t) => {
        if (t.assigneeAgentId !== agentId) return;
        run++;
        if (run === 1) out = ask(t.id, kind, target);
        else then?.(t, run);
      };
      const r = await give(agentId, project);
      return { ...r, out: () => out };
    };

    it("a leveled agent asks with request_permission; request_access and request_command are not its tools", async () => {
      agent("legacy", 'tools: [Read, Bash]\nshell:\n  allow: ["git status"]');
      orch.syncAgents();
      await give("reader", "lab");
      await give("legacy");
      expect(hubTools(seen[0]?.config)).toContain("request_permission");
      expect(hubTools(seen[0]?.config)).not.toContain("request_access");
      expect(hubTools(seen[1]?.config)).toEqual(
        expect.arrayContaining(["request_access", "request_command"]),
      );
      expect(hubTools(seen[1]?.config)).not.toContain("request_permission");
      expect(
        orch.requestAccess({ from: "task", taskId: seen[0]?.task.id as string }, "x"),
      ).toMatchObject({ ok: false, reason: expect.stringMatching(/request_permission/) });
      expect(ask(seen[1]?.task.id as string, "web", "web")).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/request_access or request_command/),
      });
    });

    it("once covers exactly the next run", async () => {
      const { thread, task } = await askFirst("reader", "lab", "web", "web", (t, run) => {
        if (run === 2) orch.askOwner({ from: "task", taskId: t.id }, "which source?");
      });
      expect(buttons(thread.id)).toEqual(["perm:once", "perm:card", "perm:always", "perm:reject"]);
      expect(last(thread.id)?.content).toMatch(/reader asks for level 2 \(the open web/);
      expect(seen[0]?.req.tools).not.toContain("WebSearch");
      expect(orch.runAction(`perm:once:${idOf(thread.id)}`).message).toMatch(/Allowed once/);
      expect(orch.runAction(`perm:once:${idOf(thread.id)}`).ok).toBe(false);
      await drain();
      expect(seen[1]?.req.tools).toEqual(expect.arrayContaining(["WebSearch", "Edit"]));
      expect(seen[1]?.req.prompt).toMatch(/approved for this run, beyond your settings: level 2/);
      answerOwnerQuestion(db, thread.id, "any");
      await drain();
      expect(seen[2]?.task.id).toBe(task.id);
      expect(seen[2]?.req.tools).not.toContain("WebSearch");
      expect(getSetting(db, `approval:${cardKey(task)}`) ?? "").toBe("");
    });

    it("for this card covers the card's later tasks, a review rework included, and ends when it is done", async () => {
      agent("dev1", "level: 1\nroles: [dev]");
      agent("qa", "level: 1\nroles: [qa]");
      orch.syncAgents();
      let reviews = 0;
      const threadOf: { id?: string } = {};
      const prev = { onRun: undefined as ((t: Task) => void) | undefined };
      const { thread, task } = await askFirst("dev1", "lab", "folder", "/srv/shared-assets");
      prev.onRun = onRun;
      threadOf.id = thread.id;
      onRun = (t) => {
        if (t.assigneeAgentId === "qa") {
          reviews++;
          orch.moveTask(
            { from: "task", taskId: t.id },
            {
              taskId: String(threadCard(db, thread.id)),
              to: reviews === 1 ? "in_progress" : "done",
            },
          );
          return;
        }
        prev.onRun?.(t);
      };
      expect(orch.runAction(`perm:card:${idOf(thread.id)}`).message).toMatch(/this card/);
      expect(JSON.parse(getSetting(db, `approval:${cardKey(task)}`) ?? "[]")).toEqual([
        { kind: "folder", folders: ["/srv/shared-assets"] },
      ]);
      await drain();
      const dev = seen.filter((r) => r.task.assigneeAgentId === "dev1");
      // The resumed run, and the successor the review sent back: both have the folder.
      expect(dev).toHaveLength(3);
      expect(dev[2]?.task.id).not.toBe(task.id);
      expect(dev[0]?.req.allowedTools.some((r) => r.includes("/srv/shared-assets"))).toBe(false);
      for (const run of dev.slice(1)) {
        expect(run.req.allowedTools.some((r) => r.includes("/srv/shared-assets"))).toBe(true);
      }
      // Reviewed into done: the approval is gone.
      const held = getTask(db, String(threadCard(db, thread.id))) as Task;
      expect(held.column).toBe("done");
      expect(getSetting(db, `approval:${cardKey(held)}`) ?? "").toBe("");
      expect(yaml("dev1")).not.toMatch(/shared-assets/);
    });

    it("always extends the remit, keeping the file's layout, and the question is not asked again", async () => {
      writeFileSync(
        join(home, "agents", "reader", "agent.yaml"),
        `# Reads the client's files.\n${yaml("reader")}`,
      );
      const { thread, task } = await askFirst("reader", "acme", "folder", "/srv/briefs");
      expect(buttons(thread.id)).toContain("perm:always");
      expect(orch.runAction(`perm:always:${idOf(thread.id)}`).message).toMatch(/from now on/);
      expect(yaml("reader")).toMatch(/^# Reads the client's files\./);
      expect(yaml("reader")).toMatch(/\/srv\/briefs/);
      expect(ask(task.id, "folder", "/srv/briefs/2026")).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/already in your folders/),
      });
      await drain();
      expect(seen.at(-1)?.req.allowedTools.some((r) => r.includes("/srv/briefs"))).toBe(true);
    });

    it("always on an experimental project sets an override; asked again, it is refused", async () => {
      const { thread, task } = await askFirst("reader", "lab", "level", "3");
      expect(orch.runAction(`perm:always:${idOf(thread.id)}`).ok).toBe(true);
      expect(readFileSync(join(home, "overrides.yaml"), "utf8")).toMatch(
        /agent: reader\n {2}project: lab\n {2}level: 3/,
      );
      expect(ask(task.id, "level", "3")).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/level 3 already/),
      });
      expect(ask(task.id, "web", "web")).toMatchObject({ ok: false });
      // An integration joins the mcp remit the same way.
      const op = await askFirst("operator", "lab", "integration", "blender");
      expect(buttons(op.thread.id)).toContain("perm:always");
      expect(orch.runAction(`perm:always:${idOf(op.thread.id)}`).ok).toBe(true);
      expect(yaml("operator")).toMatch(/mcp: \[social, blender\]|- blender/);
      expect(ask(op.task.id, "integration", "blender")).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/already in your integrations/),
      });
    });

    it("no approval lifts the secured-live rule", async () => {
      // Above the secured ceiling: refused with the live rule, no buttons.
      agent("op2", "level: 3");
      orch.syncAgents();
      const high = await askFirst("full", "acme", "level", "5");
      expect(high.out()).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/ceiling \(4\).*read-only.*staging/),
      });
      expect(buttons(high.thread.id) ?? []).not.toContain("perm:once");
      // An integration granted for the card (here a client site with per-project credentials)
      // still carries the live guard into the run: its writes are refused there.
      writeFileSync(
        join(home, "catalog", "site.yaml"),
        `id: site\nname: Site\ncommand: npx\nargs: ["site@1.0.0"]\nenv:\n  KEY: "vault:{project}-site"\ntools:\n  read: [get_page]\n  write: [save_page]\n  class:\n    save_page: draft\n`,
      );
      const { thread } = await askFirst("op2", "acme", "integration", "site");
      expect(orch.runAction(`perm:card:${idOf(thread.id)}`).ok).toBe(true);
      await drain();
      expect(seen.at(-1)?.req.allowedTools).toContain("mcp__site__save_page");
      const live = launches.at(-1)?.live;
      expect(live).toBeDefined();
      expect(liveRefusal(live as LiveGuard, "save_page", { title: "x" })).toMatch(
        /treated as live.*staging/,
      );
    });

    it("always is not offered for force push, always-ask items or a secured level raise", async () => {
      // Force push and push: refused outright, nothing posted.
      const push = await askFirst("reader", "lab", "command", "git push --force origin main");
      expect(push.out()).toMatchObject({ ok: false, reason: expect.stringMatching(/force push/) });
      expect(ask(push.task.id, "command", "git push origin main")).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/push_branch/),
      });
      expect(buttons(push.thread.id) ?? []).not.toContain("perm:once");
      // Reading keys.
      const keys = await askFirst("reader", "lab", "folder", "~/.ssh");
      expect(buttons(keys.thread.id)).toEqual(["perm:once", "perm:card", "perm:reject"]);
      expect(last(keys.thread.id)?.content).toMatch(/reading keys is asked every time/);
      expect(orch.runAction(`perm:always:${idOf(keys.thread.id)}`)).toMatchObject({ ok: false });
      expect(yaml("reader")).not.toMatch(/\.ssh/);
      // A new paid service (an integration with a spend tool).
      agent("op3", "level: 3");
      orch.syncAgents();
      const paid = await askFirst("op3", "lab", "integration", "social");
      expect(buttons(paid.thread.id)).toEqual(["perm:once", "perm:card", "perm:reject"]);
      expect(last(paid.thread.id)?.content).toMatch(/a new paid service is asked every time/);
      // Deleting outside its folders, from a level 4 shell.
      const del = await askFirst("builder", "lab", "command", "rm -rf /srv/old-builds");
      expect(buttons(del.thread.id)).toEqual(["perm:once", "perm:card", "perm:reject"]);
      expect(last(del.thread.id)?.content).toMatch(/deleting outside its folders/);
      expect(ask(del.task.id, "command", "make test")).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/run the command directly/),
      });
      // A level raise on a secured project: once or for this card only.
      const sec = await askFirst("reader", "acme", "level", "2");
      expect(buttons(sec.thread.id)).toEqual(["perm:once", "perm:card", "perm:reject"]);
      expect(orch.runAction(`perm:always:${idOf(sec.thread.id)}`)).toMatchObject({ ok: false });
      expect(existsSync(join(home, "overrides.yaml"))).toBe(false);
    });

    it("web: a split agent switches by handoff; a level 1 agent asks for level 2", async () => {
      const split = await askFirst("operator", "lab", "web", "web");
      expect(split.out()).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/hand off to yourself/),
      });
      const l1 = await askFirst("reader", "acme", "web", "any");
      expect(l1.out()).toEqual({ ok: true });
      expect(last(l1.thread.id)?.content).toMatch(/level 2/);
    });
  });
});
