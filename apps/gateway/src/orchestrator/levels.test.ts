import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createThread,
  getTask,
  handoffHops,
  listMessages,
  openCoreDatabase,
  setSetting,
  type Task,
} from "@achords/core";
import { createProject, loadCatalog, updateProject } from "@achords/policy";
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
        resolveSecret: () => "secret-value",
        call: async () => ({ ok: true, text: "ok" }),
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

  it("level 4 without accounts: work mode on the host sandbox without the open web; self-handoff to web mode without a shell", async () => {
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
    // The switch: the same agent in web mode, counted as a hop, on the host without a shell.
    const web = seen[1];
    expect(web?.task.assigneeAgentId).toBe("webdev");
    expect(web?.task.runMode).toBe("web");
    expect(handoffHops(db, web?.task as Task)).toBe(1);
    expect(web?.req.tools).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
    expect(web?.req.tools).not.toContain("Bash");
    expect(web?.req.container).toBeUndefined();
    expect(JSON.parse(web?.req.settings ?? "{}").sandbox).toBeUndefined();
    expect(web?.req.prompt).toMatch(/web mode/);
  });

  it("full access gives a split agent web mode: no shell, no account tools that write", async () => {
    const thread = createThread(db, { project: "acme" });
    const r = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: "designer", title: "Work", instructions: "go" },
    );
    if (!r.ok) throw new Error(r.reason);
    const task = getTask(db, r.taskId) as Task;
    setSetting(db, `elevation:${task.rootId ?? task.id}`, String(Date.now() + 60_000));
    let switched: unknown;
    onRun = (t) => {
      switched = orch.handoff(
        { from: "task", taskId: t.id },
        { agent: "designer", title: "x", instructions: "x" },
      );
    };
    for (let i = 0; i < 5 && (await orch.workOnce()); i++);
    const req = seen[0]?.req;
    expect(req?.tools).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
    expect(req?.tools).not.toContain("Bash");
    expect(req?.container).toBeUndefined();
    // Keyed integrations leave; the local app keeps only its read tools.
    expect(req?.allowedTools.some((t) => t.startsWith("mcp__social__"))).toBe(false);
    expect(req?.allowedTools).toContain("mcp__blender__get_scene_info");
    expect(req?.allowedTools).not.toContain("mcp__blender__import_asset");
    expect(req?.prompt).toMatch(/web mode until/);
    // Switching back is pointless while full access lasts.
    expect(switched).toMatchObject({ ok: false, reason: expect.stringMatching(/web mode until/) });
  });

  it("level 4 in work mode without keys: a free shell in the CLI's host sandbox", async () => {
    await give("builder");
    const req = seen[0]?.req;
    expect(req?.tools).toContain("Bash");
    // No command list, and no bare Bash rule: only the sandbox auto-allows commands.
    expect(req?.allowedTools).not.toContain("Bash");
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
    expect(settings.sandbox.filesystem.denyRead[0]).toMatch(/achords-levels-/);
    expect(settings.permissions.deny).toContain("Bash(git push:*)");
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
    expect(req?.allowedTools).not.toContain("Bash");
    expect(req?.allowedTools).toEqual(
      expect.arrayContaining(["mcp__blender__import_asset", "mcp__social__save_draft"]),
    );
    const settings = JSON.parse(req?.settings ?? "{}");
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.filesystem.denyRead[0]).toMatch(/achords-levels-/);
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
    expect(leveled).toMatchObject({ ok: false, reason: expect.stringMatching(/no command list/) });
    expect(legacy).toMatchObject({ ok: false, reason: expect.stringMatching(/force push/) });
  });
});
