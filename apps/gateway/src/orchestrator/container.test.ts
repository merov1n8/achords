import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createThread,
  getCardSession,
  getTask,
  listMessages,
  openCoreDatabase,
  sessionDir,
} from "@achords/core";
import { runContainerPrefix } from "@achords/platform";
import { loadCatalog } from "@achords/policy";
import type { ModelProvider, RunRequest, RunResult } from "@achords/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prepared } from "../container.ts";
import { createMcpTickets, createRunTokens, type McpLaunch } from "../mcp/tokens.ts";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.ts";

const result = (): RunResult => ({
  ok: true,
  stopReason: "completed",
  text: "done",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  windows: [],
  durationMs: 1,
});

describe("agent runs in an Apple container (ADR-0051)", () => {
  let home: string;
  let db: ReturnType<typeof openCoreDatabase>;
  let calls: {
    req: RunRequest;
    mcp?: Record<string, { command: string; env: Record<string, string> }>;
    sharedExists?: boolean;
  }[];
  let prepared: Prepared;
  let prepares: number;
  let token: string | undefined;
  let docs: string;
  let code: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-box-"));
    db = openCoreDatabase(join(home, "core.db"));
    calls = [];
    prepares = 0;
    prepared = {
      ready: true,
      bin: "/opt/homebrew/bin/container",
      image: "achords-agent:abc",
      hubUrl: "http://192.168.64.1:7420",
    };
    token = "oauth-token-value";
    docs = join(home, "docs");
    code = join(home, "code");
    mkdirSync(docs);
    mkdirSync(code);
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const agent = (extra: string, model = "cli-claude/sonnet") => {
    mkdirSync(join(home, "agents", "boss"), { recursive: true });
    writeFileSync(
      join(home, "agents", "boss", "agent.yaml"),
      "id: boss\nname: Boss\nrole: boss\nworkspace: shared\nmodels: {default: cli-claude/sonnet}\n",
    );
    mkdirSync(join(home, "agents", "web"), { recursive: true });
    writeFileSync(
      join(home, "agents", "web", "agent.yaml"),
      [
        "id: web",
        "name: Web",
        "role: research",
        "workspace: shared",
        `models: {default: ${model}}`,
        "tools: [Read, WebFetch]",
        `fs: {write: [${join(home, "work")}], read: [${docs}]}`,
        extra,
      ].join("\n"),
    );
  };

  const startFor = (target: string, over: Partial<OrchestratorDeps> = {}) => {
    const run = async (req: RunRequest) => {
      const cfg = req.mcpConfigPath
        ? JSON.parse(readFileSync(req.mcpConfigPath, "utf8")).mcpServers
        : undefined;
      calls.push({
        req,
        mcp: cfg,
        ...(req.mcpConfigPath ? { sharedExists: existsSync(req.mcpConfigPath) } : {}),
      });
      return result();
    };
    const orch = createOrchestrator({
      db,
      home,
      providers: {
        "cli-claude": { id: "cli-claude", run },
        "cli-codex": { id: "cli-codex", run } as ModelProvider,
      },
      hub: {
        url: "http://127.0.0.1:7420",
        tokens: createRunTokens(),
        serverEntry: "/repo/server.ts",
      },
      container: {
        prepare: async () => {
          prepares++;
          return prepared;
        },
        codeDirs: [code],
        claudeLogin: () => {
          if (!token) throw new Error("add a token for container runs in Settings → Model access");
          return { CLAUDE_CODE_OAUTH_TOKEN: token };
        },
      },
      ...over,
    });
    orch.syncAgents();
    const thread = createThread(db, {});
    const r = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: target, title: "research", instructions: "go" },
    );
    if (!r.ok) throw new Error(r.reason);
    return { orch, taskId: r.taskId, threadId: thread.id };
  };
  const start = (over: Partial<OrchestratorDeps> = {}) => startFor("web", over);

  it('runs a "*" agent in a container: own folders only, hub on the container network, token by env', async () => {
    agent('network: {allow: ["*"]}');
    const { orch, taskId } = start();
    await orch.workOnce();
    expect(getTask(db, taskId)?.status).toBe("done");
    const [call] = calls;
    const box = call?.req.container;
    expect(box).toMatchObject({ bin: "/opt/homebrew/bin/container", image: "achords-agent:abc" });
    expect(box?.name).toMatch(new RegExp(`^${runContainerPrefix(home)}[0-9a-f-]{36}$`));
    const shared = join(call?.req.mcpConfigPath as string, "..");
    expect(call?.req.cwd).toBe(join(home, "work"));
    expect(box?.mounts).toEqual(
      expect.arrayContaining([
        { path: join(home, "work"), readonly: false },
        { path: docs, readonly: true },
        { path: shared, readonly: true },
        { path: code, readonly: true },
      ]),
    );
    // Nothing else of the home folder: not the data root, not the vault.
    expect(box?.mounts.map((m) => m.path)).not.toContain(home);
    expect(call?.mcp?.achords).toMatchObject({
      command: "node",
      env: { ACHORDS_HUB_URL: "http://192.168.64.1:7420" },
    });
    expect(call?.sharedExists).toBe(true);
    expect(existsSync(shared)).toBe(false); // removed after the run
    expect(call?.req.env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value",
      CLAUDE_CONFIG_DIR: sessionDir(home, taskId, "web"),
    });
    expect(call?.req.appendSystemPrompt).toMatch(/isolated Linux container/);
  });

  it("a shell with keyed integrations runs in a container; the server stays on the host (ADR-0055)", async () => {
    agent('mcp: [gen]\nshell: {allow: ["ffmpeg"]}\ncontainer: true');
    const catalogDir = join(home, "catalog");
    mkdirSync(catalogDir);
    writeFileSync(
      join(catalogDir, "gen.yaml"),
      `id: gen\nname: Gen\nbuiltin: wordpress\nenv:\n  KEY: "vault:gen-key"\ntools:\n  read: [run]\n`,
    );
    const hosted: { id: string; launch: McpLaunch }[] = [];
    const { orch, taskId } = start({
      integrations: {
        catalog: () => loadCatalog(join(home, "no-seed"), catalogDir),
        tickets: createMcpTickets(),
        launcherEntry: "/repo/launch.ts",
        relayEntry: "/repo/relay.ts",
        builtins: { wordpress: "/repo/wp.ts" },
        resolveSecret: () => "sk-secret",
        host: {
          register: (id, launch) => {
            hosted.push({ id, launch });
            return { token: "relay-token", revoke: () => {} };
          },
        },
      },
    });
    await orch.workOnce();
    expect(getTask(db, taskId)?.error ?? "").toBe("");
    const call = calls[0];
    expect(call?.req.container).toBeDefined();
    // In the VM: only the relay, on the image's Node, talking to the hub on the container network.
    expect(call?.mcp?.gen).toEqual({
      command: "node",
      args: ["--disable-warning=ExperimentalWarning", "/repo/relay.ts"],
      env: {
        ACHORDS_HUB_URL: "http://192.168.64.1:7420",
        ACHORDS_MCP_ID: "gen",
        ACHORDS_MCP_TOKEN: "relay-token",
      },
    });
    // On the host: the gateway's own Node runs the builtin server with the key.
    expect(hosted[0]?.launch).toMatchObject({
      command: process.execPath,
      env: { KEY: "sk-secret" },
    });
    expect(JSON.stringify(call?.mcp)).not.toContain("sk-secret");
  });

  it("mounts the card's session folder as the CLI config and resumes the session (ADR-0066)", async () => {
    agent('network: {allow: ["*"]}');
    const { orch, taskId, threadId } = start({
      providers: {
        "cli-claude": {
          id: "cli-claude",
          run: async (req) => {
            calls.push({ req });
            if (calls.length === 1) orch.askOwner({ from: "task", taskId }, "Which site?");
            return { ...result(), sessionId: req.session?.resume ?? "s-1" };
          },
        },
      },
    });
    await orch.workOnce();
    const dir = sessionDir(home, taskId, "web");
    expect(getCardSession(db, { card: taskId, agent: "web", project: "" })).toMatchObject({
      sessionId: "s-1",
      trust: "open-web",
    });
    await orch.handleMessage(threadId, "example.com", "web");
    await orch.workOnce();
    const second = calls[1]?.req;
    expect(second?.session).toEqual({ resume: "s-1" });
    expect(second?.env?.CLAUDE_CONFIG_DIR).toBe(dir);
    expect(second?.container?.mounts).toContainEqual({ path: dir, readonly: false });
    // Nothing else of the host's config: only this card's folder for this agent.
    expect(second?.container?.mounts.map((m) => m.path)).not.toContain(join(home, "sessions"));
  });

  it("shares the run's skill folders read-only (ADR-0053), never another agent's", async () => {
    agent('network: {allow: ["*"]}');
    for (const scope of ["shared", "agents/web", "agents/other"]) {
      mkdirSync(join(home, "skills", scope, "pack"), { recursive: true });
    }
    const { orch } = start();
    await orch.workOnce();
    const mounts = calls[0]?.req.container?.mounts ?? [];
    expect(mounts).toEqual(
      expect.arrayContaining([
        { path: join(home, "skills", "shared"), readonly: true },
        { path: join(home, "skills", "agents", "web"), readonly: true },
      ]),
    );
    expect(mounts.some((m) => m.path.includes("other"))).toBe(false);
    expect(mounts.filter((m) => m.path.includes("skills")).every((m) => m.readonly)).toBe(true);
  });

  it('runs on the host when the owner switched the container off, or without "*"', async () => {
    agent('network: {allow: ["*"]}\ncontainer: false');
    const { orch } = start();
    await orch.workOnce();
    expect(calls[0]?.req.container).toBeUndefined();
    expect(calls[0]?.mcp?.achords?.command).toBe(process.execPath);
    expect(calls[0]?.req.env).toBeUndefined();
    agent("network: {allow: [example.com]}");
    const second = start();
    await second.orch.workOnce();
    expect(calls[1]?.req.container).toBeUndefined();
    expect(prepares).toBe(0);
  });

  it("waits while the image is prepared, without using an attempt", async () => {
    agent('network: {allow: ["*"]}');
    prepared = { ready: false, reason: "preparing the container image" };
    const { orch, taskId } = start();
    await orch.workOnce();
    expect(calls).toEqual([]);
    expect(getTask(db, taskId)).toMatchObject({
      status: "queued",
      error: "preparing the container image",
    });
  });

  it("API mode needs no token; subscription mode without one fails with where to add it", async () => {
    agent('network: {allow: ["*"]}');
    token = undefined;
    const { orch, taskId } = start();
    await orch.workOnce();
    expect(calls).toEqual([]);
    expect(getTask(db, taskId)?.error).toMatch(/Settings → Model access/);

    const api = start({
      billing: () => ({ mode: "api", env: { ANTHROPIC_API_KEY: "sk-ant" } }),
    });
    await api.orch.workOnce();
    expect(calls[0]?.req.env).toEqual({
      ANTHROPIC_API_KEY: "sk-ant",
      CLAUDE_CONFIG_DIR: sessionDir(home, api.taskId, "web"),
    });
    expect(calls[0]?.req.container).toBeDefined();
  });

  it("refuses OpenAI (and Gemini) models in a container with a plain reason", async () => {
    agent('network: {allow: ["*"]}', "cli-codex/gpt-6");
    const { orch, taskId } = start();
    await orch.workOnce();
    expect(calls).toEqual([]);
    expect(getTask(db, taskId)?.error).toMatch(
      /only Claude models work for now \(OpenAI cannot sign in there yet\).*switch its container off/,
    );
  });

  it("delegated work that cannot run tells the owner in the chat too, not only its caller", async () => {
    agent('network: {allow: ["*"]}\ndelegation: {accepts_from: [lead]}', "cli-codex/gpt-6");
    mkdirSync(join(home, "agents", "lead"), { recursive: true });
    writeFileSync(
      join(home, "agents", "lead", "agent.yaml"),
      "id: lead\nname: Lead\nrole: lead\nworkspace: shared\nmodels: {default: cli-claude/sonnet}\ndelegation: {can_delegate_to: [web]}\n",
    );
    const { orch, threadId, taskId } = startFor("lead");
    const child = orch.delegate(
      { from: "task", taskId },
      { agent: "web", title: "Research", instructions: "go" },
    );
    if (!child.ok) throw new Error(child.reason);
    await orch.workOnce();
    const posted = listMessages(db, threadId).map((m) => m.content);
    expect(
      posted.some((c) => /^web could not run "Research"[\s\S]*only Claude models/.test(c)),
    ).toBe(true);
  });
});
