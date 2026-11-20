import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThread, getTask, openCoreDatabase, type Task } from "@achords/core";
import { createProject, loadCatalog } from "@achords/policy";
import type { ModelProvider, RunRequest, RunResult } from "@achords/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpTickets, createRunTokens, type McpTickets } from "../mcp/tokens.ts";
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

  const agent = (id: string, extra: string) => {
    mkdirSync(join(home, "agents", id), { recursive: true });
    writeFileSync(
      join(home, "agents", id, "agent.yaml"),
      `id: ${id}\nname: ${id}\nrole: ${id}\nworkspace: web-clients\nmodels:\n  default: cli-claude/sonnet\ntools: [Read]\n${extra}\n`,
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
      `id: blender\nname: Blender\ncommand: uvx\nargs: ["blender-mcp==1.0.0"]\ntools:\n  read: [get_scene_info]\n`,
    );
    agent("boss", "");
    agent("marketer", "mcp: [wp]");
    agent("shelly", 'mcp: [wp]\nshell:\n  allow: ["ls"]');
    agent("artist", 'mcp: [blender]\nshell:\n  allow: ["ls"]');
    agent("ghost", "mcp: [ga4]");
    createProject(join(home, "projects"), { slug: "acme", name: "Acme", workspace: "web-clients" });
    db = openCoreDatabase(join(home, "core.db"));
    seen = [];
    resolved = [];
    tickets = createMcpTickets();
    const p: ModelProvider = {
      id: "cli-claude",
      async run(req) {
        const row = db.prepare("SELECT id FROM tasks WHERE status = 'claimed'").get();
        const config = req.mcpConfigPath ? readFileSync(req.mcpConfigPath, "utf8") : undefined;
        seen.push({ req, config, task: getTask(db, String(row?.id)) as Task });
        return result();
      },
    };
    orch = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": p },
      hub: { url: "http://127.0.0.1:7420", tokens: createRunTokens(), serverEntry: "/x/server.ts" },
      integrations: {
        catalog: () => loadCatalog(join(home, "no-seed"), catalogDir),
        tickets,
        launcherEntry: "/x/launch.ts",
        builtins: { wordpress: "/x/wordpress.ts" },
        resolveSecret: (ref, actor) => {
          resolved.push([ref, actor]);
          return SECRET;
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
    // Read tools only; write tools wait for publishing review.
    expect(run.req.allowedTools).toContain("mcp__wp__list_posts");
    expect(run.req.allowedTools).not.toContain("mcp__wp__create_post");
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

  it("refuses secrets next to a shell, unknown integrations and a missing project", async () => {
    const shelly = await give("shelly", "acme");
    expect(shelly.status).toBe("failed");
    expect(shelly.error).toMatch(/uses credentials and agent shelly has a shell/);
    const ghost = await give("ghost");
    expect(ghost.error).toMatch(/integration ga4 is not in the catalog/);
    const noProject = await give("marketer");
    expect(noProject.error).toMatch(/integration wp needs a project/);
    expect(seen).toEqual([]);
    expect(resolved).toEqual([]);
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
    });
    expect(resolved.map(([ref]) => ref).sort()).toEqual(["vault:google", "vault:wp-acme"]);
  });

  it("allows integrations without secrets next to a shell", async () => {
    const task = await give("artist");
    expect(task.status).toBe("done");
    expect(JSON.parse(seen[0]?.config ?? "{}").mcpServers.blender).toBeDefined();
    expect(seen[0]?.req.allowedTools).toContain("mcp__blender__get_scene_info");
  });
});
