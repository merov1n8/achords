import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createThread,
  getTask,
  listMessages,
  openCoreDatabase,
  setSetting,
  type Task,
} from "@achords/core";
import { createProject, loadCatalog } from "@achords/policy";
import type { ModelProvider, RunRequest, RunResult } from "@achords/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMcpTickets,
  createRunTokens,
  type McpLaunch,
  type McpTickets,
} from "../mcp/tokens.ts";
import { createOrchestrator, type Orchestrator } from "./orchestrator.ts";

const result = (): RunResult => ({
  ok: true,
  stopReason: "completed",
  text: "done",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  windows: [],
  durationMs: 1,
});

const SECRET = "wp-app-password-0123456789";

describe("integrations in runs (ADR-0034)", () => {
  let home: string;
  let db: ReturnType<typeof openCoreDatabase>;
  let orch: Orchestrator;
  let tickets: McpTickets;
  let seen: { req: RunRequest; config: string | undefined; task: Task }[];
  let resolved: [string, string][];
  let onRun: ((task: Task) => void) | undefined;
  let called: { launch: McpLaunch; tool: string; args: unknown }[];
  let callText: string;
  let triage: { news: boolean; summary: string } | undefined;
  let runTokens: ReturnType<typeof createRunTokens>;

  const agent = (id: string, extra: string, tools = "[Read]") => {
    mkdirSync(join(home, "agents", id), { recursive: true });
    writeFileSync(
      join(home, "agents", id, "agent.yaml"),
      `id: ${id}\nname: ${id}\nrole: ${id}\nworkspace: web-clients\nmodels:\n  default: cli-claude/sonnet\ntools: ${tools}\n${extra}\n`,
    );
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-integrations-"));
    const catalogDir = join(home, "catalog");
    mkdirSync(catalogDir);
    writeFileSync(
      join(catalogDir, "wp.yaml"),
      `id: wp\nname: WordPress\ncommand: npx\nargs: ["-y", "wp-mcp@1.0.0"]\nenv:\n  WP_URL: https://example.com\n  WP_PASSWORD: "vault:wp-{project}"\ntools:\n  read: [list_posts]\n  write: [create_post]\n`,
    );
    writeFileSync(
      join(catalogDir, "blender.yaml"),
      `id: blender\nname: Blender\ncommand: uvx\nargs: ["blender-mcp==1.0.0"]\ntools:\n  read: [get_scene_info]\n  write: [execute_blender_code]\n`,
    );
    writeFileSync(
      join(catalogDir, "ga.yaml"),
      `id: ga\nname: GA4\ncommand: uvx\nargs: ["ga@1.0.0"]\nenv:\n  TOKEN: "vault:google-refresh-token"\ntools:\n  read: [run_report, get_account_summaries]\nscope:\n  args: [property_id]\ntest:\n  tool: run_report\n  args: { property_id: "{target}" }\n`,
    );
    writeFileSync(
      join(catalogDir, "site.yaml"),
      `id: site\nname: Site\ncommand: npx\nargs: ["site@1.0.0"]\nenv:\n  SITE_URL: "{account:wordpress}"\n  KEY: "vault:site-{project}"\ntools:\n  read: [ping]\n`,
    );
    agent("siter", "mcp: [site]");
    agent("analyst", "mcp: [ga]");
    agent("autopub", "mcp: [wp]\npublish_mode:\n  default: review\n  channels:\n    wp: auto");
    agent("boss", "");
    agent("marketer", "mcp: [wp]");
    agent("shelly", 'mcp: [wp]\nshell:\n  allow: ["ls"]');
    agent("artist", 'mcp: [blender]\nshell:\n  allow: ["ls"]');
    agent("ghost", "mcp: [ga4]");
    agent("maker", "mcp: [blender, wp]\nnetwork:\n  allow: [docs.blender.org]", "[Read, WebFetch]");
    createProject(join(home, "projects"), { slug: "acme", name: "Acme", workspace: "web-clients" });
    db = openCoreDatabase(join(home, "core.db"));
    seen = [];
    resolved = [];
    onRun = undefined;
    called = [];
    callText = "draft 42 created";
    triage = undefined;
    runTokens = createRunTokens();
    tickets = createMcpTickets();
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
      providers: {
        "cli-claude": p,
        "cli-codex": { ...p, id: "cli-codex" },
        local: {
          id: "local",
          async run(req) {
            seen.push({ req, config: undefined, task: {} as Task });
            return triage ? { ...result(), structured: triage } : { ...result(), ok: false };
          },
        },
      },
      hub: { url: "http://127.0.0.1:7420", tokens: runTokens, serverEntry: "/x/server.ts" },
      integrations: {
        catalog: () => loadCatalog(join(home, "no-seed"), catalogDir),
        tickets,
        launcherEntry: "/x/launch.ts",
        builtins: { wordpress: "/x/wordpress.ts" },
        resolveSecret: (ref, actor) => {
          resolved.push([ref, actor]);
          return SECRET;
        },
        call: async (launch, tool, args) => {
          called.push({ launch, tool, args });
          return { ok: true, text: callText };
        },
      },
    });
    orch.syncAgents();
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const give = async (agentId: string, project?: string) => {
    const thread = createThread(db, project ? { project } : {});
    const r = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: agentId, title: "Check the blog", instructions: "go" },
    );
    if (!r.ok) throw new Error(r.reason);
    for (let i = 0; i < 5 && (await orch.workOnce()); i++);
    return getTask(db, r.taskId) as Task;
  };

  it("starts the server through the launcher; the config holds a ticket, never the secret", async () => {
    const task = await give("marketer", "acme");
    expect(task.status).toBe("done");
    const run = seen[0];
    if (!run?.config) throw new Error("no MCP config");
    expect(run.config).not.toContain(SECRET);
    const wp = JSON.parse(run.config).mcpServers.wp;
    expect(wp.args).toContain("/x/launch.ts");
    expect(Object.keys(wp.env).sort()).toEqual(["ACHORDS_HUB_URL", "ACHORDS_MCP_TICKET"]);
    // Write tools are allowed only because the launcher routes them to the owner (ADR-0037).
    expect(run.req.allowedTools).toContain("mcp__wp__list_posts");
    expect(run.req.allowedTools).toContain("mcp__wp__create_post");
    // Per-client credentials, audited per agent and integration.
    expect(resolved).toEqual([["vault:wp-acme", "agent:marketer/mcp:wp"]]);
    // The run is over: ticket dead, file gone.
    expect(tickets.redeem(wp.env.ACHORDS_MCP_TICKET)).toBeUndefined();
    expect(existsSync(run.req.mcpConfigPath as string)).toBe(false);
  });

  it("hands the environment to the launcher exactly once while the run lives", async () => {
    let redeemed: unknown[] = [];
    const thread = createThread(db, { project: "acme" });
    orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: "marketer", title: "t", instructions: "go" },
    );
    const original = tickets.issue.bind(tickets);
    tickets.issue = (launch) => {
      const issued = original(launch);
      redeemed = [tickets.redeem(issued.ticket), tickets.redeem(issued.ticket)];
      return issued;
    };
    await orch.workOnce();
    expect(redeemed[0]).toMatchObject({
      command: "npx",
      args: ["-y", "wp-mcp@1.0.0"],
      env: { WP_URL: "https://example.com", WP_PASSWORD: SECRET },
      files: {},
    });
    expect(redeemed[1]).toBeUndefined();
  });

  it("refuses secrets next to a shell and unknown integrations", async () => {
    const shelly = await give("shelly", "acme");
    expect(shelly.status).toBe("failed");
    expect(shelly.error).toMatch(/uses credentials and agent shelly has a shell/);
    const ghost = await give("ghost");
    expect(ghost.error).toMatch(/integration ga4 is not in the catalog/);
    expect(seen).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it("work without a client project uses the owner's own accounts (ADR-0042)", async () => {
    const own = await give("marketer");
    expect(own.status).toBe("done");
    expect(resolved).toEqual([["vault:wp-own", "agent:marketer/mcp:wp"]]);
    // A scoped integration takes the own targets, never another client's.
    writeFileSync(join(home, "accounts.yaml"), 'integrations:\n  ga: ["999"]\n');
    const launches: McpLaunch[] = [];
    const original = tickets.issue.bind(tickets);
    tickets.issue = (launch) => {
      launches.push(launch);
      return original(launch);
    };
    await give("analyst");
    expect(launches[0]?.scope?.allowed).toEqual(["999"]);
    // A client project without targets does not fall back to the owner's accounts.
    await give("analyst", "acme");
    expect(launches).toHaveLength(1);
  });

  it("runs builtin servers on the gateway's Node and resolves credential files", async () => {
    writeFileSync(
      join(home, "catalog", "wp.yaml"),
      `id: wp\nname: WordPress\nbuiltin: wordpress\nenv:\n  WP_APP_PASSWORD: "vault:wp-{project}"\nfiles:\n  CREDS:\n    type: authorized_user\n    refresh_token: "vault:google"\ntools:\n  read: [list_posts]\n`,
    );
    let launch: unknown;
    const original = tickets.issue.bind(tickets);
    tickets.issue = (l) => {
      launch = l;
      return original(l);
    };
    expect((await give("marketer", "acme")).status).toBe("done");
    expect(launch).toEqual({
      command: process.execPath,
      args: ["--disable-warning=ExperimentalWarning", "/x/wordpress.ts"],
      env: { WP_APP_PASSWORD: SECRET },
      files: { CREDS: { type: "authorized_user", refresh_token: SECRET } },
      // ADR-0038: results of client accounts are marked as third-party data.
      untrusted: "WordPress",
    });
    expect(resolved.map(([ref]) => ref).sort()).toEqual(["vault:google", "vault:wp-acme"]);
  });

  it("allows integrations without secrets next to a shell", async () => {
    const task = await give("artist");
    expect(task.status).toBe("done");
    expect(JSON.parse(seen[0]?.config ?? "{}").mcpServers.blender).toBeDefined();
    expect(seen[0]?.req.allowedTools).toContain("mcp__blender__get_scene_info");
  });

  describe("owner-granted full access (ADR-0035)", () => {
    const start = (agentId: string) => {
      const thread = createThread(db, { project: "acme" });
      const r = orch.delegate(
        { from: "boss", threadId: thread.id },
        { agent: agentId, title: "Glass effect", instructions: "recreate it in Blender" },
      );
      if (!r.ok) throw new Error(r.reason);
      return { thread, taskId: r.taskId };
    };
    const drain = async () => {
      for (let i = 0; i < 10 && (await orch.workOnce()); i++);
    };

    it("asks with buttons, waits, and resumes with open web and local write tools", async () => {
      onRun = (task) => {
        if (!seen.some((r) => r.req.prompt.includes("full access granted"))) {
          if (seen.length === 1) orch.requestAccess({ from: "task", taskId: task.id }, "video");
        }
      };
      const { thread, taskId } = start("maker");
      await drain();
      // First run: allow-listed host only, read tools only, both integrations.
      const first = seen[0]?.req;
      expect(first?.allowedTools).toContain("WebFetch(domain:docs.blender.org)");
      expect(first?.allowedTools).not.toContain("WebFetch");
      expect(first?.allowedTools).not.toContain("mcp__blender__execute_blender_code");
      expect(first?.allowedTools).toContain("mcp__achords__request_access");
      const msg = listMessages(db, thread.id).at(-1);
      expect(msg?.content).toMatch(/maker asks for full access \(Glass effect\): video/);
      expect(msg?.actions?.map((a) => a.data)).toEqual([
        `access:approve:${taskId}`,
        `access:reject:${taskId}`,
      ]);
      expect(await orch.workOnce()).toBe(false); // waits for the owner

      expect(orch.runAction(`access:approve:${taskId}`).message).toMatch(/until \d\d:\d\d/);
      expect(orch.runAction(`access:approve:${taskId}`).ok).toBe(false); // once only
      await drain();
      const second = seen.at(-1);
      expect(second?.req.prompt).toMatch(/Owner's answer: Full access granted until/);
      expect(second?.req.prompt).toMatch(/Left out meanwhile \(they hold credentials\): wp/);
      expect(second?.req.allowedTools).toEqual(
        expect.arrayContaining(["WebFetch", "WebSearch", "mcp__blender__execute_blender_code"]),
      );
      // Client credentials never share a run with the open web.
      expect(second?.req.allowedTools?.some((t) => t.startsWith("mcp__wp__"))).toBe(false);
      expect(JSON.parse(second?.config ?? "{}").mcpServers.wp).toBeUndefined();
      expect(getTask(db, taskId)?.status).toBe("done");
    });

    it("a refusal resumes the task without access", async () => {
      onRun = (task) => {
        if (seen.length === 1) orch.requestAccess({ from: "task", taskId: task.id }, "video");
      };
      const { taskId } = start("maker");
      await drain();
      expect(orch.runAction(`access:reject:${taskId}`).message).toMatch(/refused/);
      await drain();
      const last = seen.at(-1)?.req;
      expect(last?.prompt).toMatch(/The owner refused full access/);
      expect(last?.allowedTools).not.toContain("WebFetch");
      expect(last?.allowedTools).toContain("mcp__wp__list_posts");
    });

    it("applies to the chain while valid and expires", async () => {
      const live = start("maker");
      setSetting(db, `elevation:${live.taskId}`, String(Date.now() + 60_000));
      await drain();
      expect(seen[0]?.req.allowedTools).toContain("WebFetch");
      const old = start("maker");
      setSetting(db, `elevation:${old.taskId}`, String(Date.now() - 1));
      await drain();
      expect(seen[1]?.req.allowedTools).not.toContain("WebFetch");
    });
  });

  describe("project scope of shared accounts (ADR-0036)", () => {
    it("hands the project's targets to the launcher and names them in the prompt", async () => {
      appendFileSync(
        join(home, "projects", "acme", "project.yaml"),
        'integrations:\n  ga: ["111"]\n',
      );
      let launched: McpLaunch | undefined;
      const original = tickets.issue.bind(tickets);
      tickets.issue = (launch) => {
        launched = launch;
        return original(launch);
      };
      await give("analyst", "acme");
      expect(launched?.scope).toEqual({ args: ["property_id"], free: [], allowed: ["111"] });
      expect(seen[0]?.req.prompt).toMatch(/own integration targets[^\n]*ga: 111/);
    });

    it("leaves a scoped integration out without targets or without a project", async () => {
      await give("analyst", "acme");
      await give("analyst");
      for (const run of seen) {
        expect(JSON.parse(run.config ?? "{}").mcpServers?.ga).toBeUndefined();
        expect(run.req.allowedTools).not.toContain("mcp__ga__run_report");
      }
      expect(seen[0]?.req.prompt).toMatch(/project.yaml of acme names no targets\): ga/);
      expect(seen[1]?.req.prompt).toMatch(
        /no client project, and your own accounts name none\): ga/,
      );
    });
  });

  describe("publishing (ADR-0037)", () => {
    const capture = () => {
      const launches: McpLaunch[] = [];
      const original = tickets.issue.bind(tickets);
      tickets.issue = (launch) => {
        launches.push(launch);
        return original(launch);
      };
      return launches;
    };

    it("review: write tools go through the launcher to the owner, who approves the exact call", async () => {
      const launches = capture();
      const task = await give("marketer", "acme");
      expect(seen[0]?.req.allowedTools).toContain("mcp__wp__create_post");
      const pub = launches[0]?.publish;
      expect(pub).toMatchObject({ integration: "wp", mode: "review", tools: ["create_post"] });
      expect(seen[0]?.req.prompt).toMatch(/Write tools of wp \(review\)/);
      // The token only granted publishing to wp, and died with the run.
      expect(runTokens.resolve(pub?.token ?? "")).toBeUndefined();

      const sent = orch.requestPublish(
        { from: "task", taskId: task.id },
        {
          integration: "wp",
          tool: "create_post",
          args: { title: "Spring sale", content: "<p>Hi</p>" },
        },
      );
      expect(sent).toMatchObject({ ok: true, text: expect.stringMatching(/Sent to the owner/) });
      const msg = listMessages(db, task.threadId as string).at(-1);
      expect(msg?.content).toMatch(
        /marketer asks to publish on wp[\s\S]*\*\*Spring sale\*\*\n\nHi/,
      );
      expect(msg?.content).not.toContain("{");
      const approve = msg?.actions?.[0]?.data ?? "";
      expect(approve).toMatch(/^publish:approve:/);
      expect(called).toEqual([]);

      expect(orch.runAction(approve).ok).toBe(true);
      expect(orch.runAction(approve).ok).toBe(false); // once only
      await new Promise((r) => setTimeout(r, 0));
      expect(called).toHaveLength(1);
      expect(called[0]).toMatchObject({
        tool: "create_post",
        args: { title: "Spring sale", content: "<p>Hi</p>" },
      });
      expect(called[0]?.launch.env.WP_PASSWORD).toBe(SECRET);
      expect(resolved.at(-1)).toEqual(["vault:wp-acme", "owner-approved:agent:marketer/mcp:wp"]);
      expect(listMessages(db, task.threadId as string).at(-1)?.content).toBe("draft 42 created");
    });

    it("refuses tools that are not write tools, and runs nothing on reject", async () => {
      const task = await give("marketer", "acme");
      const from = { from: "task" as const, taskId: task.id };
      expect(
        orch.requestPublish(from, { integration: "wp", tool: "list_posts", args: {} }).ok,
      ).toBe(false);
      orch.requestPublish(from, { integration: "wp", tool: "create_post", args: {} });
      const reject = listMessages(db, task.threadId as string).at(-1)?.actions?.[1]?.data ?? "";
      expect(orch.runAction(reject).message).toMatch(/Rejected/);
      expect(called).toEqual([]);
    });

    it("auto mode reports; a project with publish: off gets no write tools", async () => {
      const launches = capture();
      await give("autopub", "acme");
      expect(launches[0]?.publish?.mode).toBe("auto");
      appendFileSync(join(home, "projects", "acme", "project.yaml"), "publish: off\n");
      await give("marketer", "acme");
      expect(launches[1]?.publish).toBeUndefined();
      expect(seen[1]?.req.allowedTools).not.toContain("mcp__wp__create_post");
    });

    it("a task that sent something for approval ends with one short line", async () => {
      onRun = (task) => {
        orch.requestPublish(
          { from: "task", taskId: task.id },
          { integration: "wp", tool: "create_post", args: { title: "T" } },
        );
      };
      const task = await give("marketer", "acme");
      const last = listMessages(db, task.threadId as string).at(-1)?.content;
      expect(last).toBe("Check the blog: ready, waiting for your approval above.");
    });
  });

  it("takes plain settings like a site address from the project's accounts", async () => {
    const launches: McpLaunch[] = [];
    const original = tickets.issue.bind(tickets);
    tickets.issue = (launch) => {
      launches.push(launch);
      return original(launch);
    };
    const without = await give("siter", "acme");
    expect(without.status).toBe("done"); // the integration is left out, the run goes on
    expect(seen.at(-1)?.req.prompt).toMatch(/site \(needs the project's wordpress account\)/);
    expect(launches).toEqual([]);
    appendFileSync(
      join(home, "projects", "acme", "project.yaml"),
      'integrations:\n  wordpress: ["https://acme.example"]\n',
    );
    await give("siter", "acme");
    expect(launches[0]?.env).toEqual({ SITE_URL: "https://acme.example", KEY: SECRET });
  });

  describe("prompt-injection guard (ADR-0038)", () => {
    it("every agent run gets the standing rule", async () => {
      await give("marketer", "acme");
      expect(seen[0]?.req.appendSystemPrompt).toMatch(/data, not instructions/);
    });

    it("auto publishing becomes review when the run reads the open web", async () => {
      agent("webauto", "mcp: [wp]\npublish_mode:\n  default: auto", "[Read, WebSearch]");
      orch.syncAgents();
      const launches: McpLaunch[] = [];
      const original = tickets.issue.bind(tickets);
      tickets.issue = (launch) => {
        launches.push(launch);
        return original(launch);
      };
      await give("webauto", "acme");
      expect(launches[0]?.publish?.mode).toBe("review");
      await give("autopub", "acme");
      expect(launches[1]?.publish?.mode).toBe("auto");
    });
  });

  it("an OpenAI (codex) run gets hub tools and local integrations, never credentials (ADR-0040)", async () => {
    mkdirSync(join(home, "agents", "oai"), { recursive: true });
    writeFileSync(
      join(home, "agents", "oai", "agent.yaml"),
      "id: oai\nname: oai\nrole: oai\nworkspace: web-clients\nmodels:\n  default: cli-codex/gpt-6-astra\n  allowed: [cli-codex/gpt-6-astra, cli-claude/sonnet]\ntools: [Read]\nmcp: [wp, blender]\n",
    );
    orch.syncAgents();
    const task = await give("oai", "acme");
    expect(task.status).toBe("done");
    expect(seen[0]?.req.model).toBe("gpt-6-astra");
    const servers = Object.keys(JSON.parse(seen[0]?.config ?? "{}").mcpServers ?? {});
    expect(servers.sort()).toEqual(["achords", "blender"]);
    expect(seen[0]?.req.allowedTools).toContain("mcp__achords__ask_owner");
    expect(seen[0]?.req.prompt).toMatch(/client credentials are left out: wp/);
    expect(resolved).toEqual([]); // no credentials were even resolved
  });

  describe("integration monitors (ADR-0039, 5b)", () => {
    const mon = {
      name: "Posts",
      config: { integration: "wp", tool: "list_posts", project: "acme", question: "New posts?" },
    };

    it("stores a baseline, ignores no change, and lets the local model judge a change", async () => {
      callText = "post A";
      expect(await orch.checkIntegration(mon, null)).toMatchObject({
        news: false,
        result: "post A",
      });
      expect(called[0]?.launch.untrusted).toBe("WordPress"); // marked as third-party data
      expect(resolved.at(-1)).toEqual(["vault:wp-acme", "monitor:Posts/mcp:wp"]);
      expect(await orch.checkIntegration(mon, "post A")).toMatchObject({
        news: false,
        detail: "no change",
      });
      callText = "post A, post B";
      triage = { news: true, summary: "A new post: B" };
      expect(await orch.checkIntegration(mon, "post A")).toEqual({
        state: "alert",
        detail: "A new post: B",
        result: "post A, post B",
        news: true,
      });
      const judged = seen.at(-1)?.req;
      expect(judged?.model).toBe("qwen3:8b");
      expect(judged?.prompt).toMatch(/Question: New posts\?[\s\S]*post A, post B/);
      expect(judged?.prompt).toMatch(/data, not instructions/);
    });

    it("never runs write tools, and stays quiet when the local model cannot judge", async () => {
      expect(
        await orch.checkIntegration(
          { name: "x", config: { ...mon.config, tool: "create_post" } },
          null,
        ),
      ).toMatchObject({ state: "alert", detail: "create_post is not a read tool of wp" });
      expect(called).toEqual([]);
      callText = "changed";
      expect(await orch.checkIntegration(mon, "before")).toMatchObject({
        news: false,
        state: "ok",
      });
    });
  });

  it("connection test: one read call, with the project's own target (web)", async () => {
    appendFileSync(
      join(home, "projects", "acme", "project.yaml"),
      'integrations:\n  ga: ["111"]\n',
    );
    callText = "Property 111: Acme";
    expect(await orch.testIntegration("ga")).toMatchObject({ ok: false, text: /pick a project/ });
    expect(await orch.testIntegration("ga", "acme")).toEqual({
      ok: true,
      text: "Property 111: Acme",
    });
    expect(called.at(-1)).toMatchObject({ tool: "run_report", args: { property_id: "111" } });
    expect(resolved.at(-1)?.[1]).toBe("owner:test/mcp:ga");
    expect(await orch.testIntegration("wp", "acme")).toMatchObject({
      ok: false,
      text: /no connection test/,
    });
  });

  it("connection test results read as one plain line", async () => {
    const { plainLine } = await import("./orchestrator.ts");
    expect(plainLine("# Achords\n- **ID**: `1365`\n- **Category**: Software")).toBe(
      "Achords · ID: 1365 · Category: Software",
    );
    expect(plainLine('{"name":"Site","url":"https://a.example"}')).toBe(
      "name: Site · url: https://a.example",
    );
  });

  it("an integration that cannot be set up for this run is left out; the run goes on", async () => {
    // siter needs the project's wordpress account; own accounts name none.
    agent("both", "mcp: [site, blender]");
    orch.syncAgents();
    const task = await give("both");
    expect(task.status).toBe("done");
    expect(Object.keys(JSON.parse(seen[0]?.config ?? "{}").mcpServers ?? {})).toContain("blender");
    expect(seen[0]?.req.prompt).toMatch(
      /Not available in this run: site \(needs the project's wordpress account\)/,
    );
  });
});
