import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThread, getTask, openCoreDatabase } from "@achords/core";
import { runContainerPrefix } from "@achords/platform";
import type { ModelProvider, RunRequest, RunResult } from "@achords/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prepared } from "../container.ts";
import { createRunTokens } from "../mcp/tokens.ts";
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

  const start = (over: Partial<OrchestratorDeps> = {}) => {
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
      { agent: "web", title: "research", instructions: "go" },
    );
    if (!r.ok) throw new Error(r.reason);
    return { orch, taskId: r.taskId };
  };

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
    expect(call?.req.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value" });
    expect(call?.req.appendSystemPrompt).toMatch(/isolated Linux container/);
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
    expect(calls[0]?.req.env).toEqual({ ANTHROPIC_API_KEY: "sk-ant" });
    expect(calls[0]?.req.container).toBeDefined();
  });

  it("refuses OpenAI (and Gemini) models in a container with a plain reason", async () => {
    agent('network: {allow: ["*"]}', "cli-codex/gpt-6");
    const { orch, taskId } = start();
    await orch.workOnce();
    expect(calls).toEqual([]);
    expect(getTask(db, taskId)?.error).toMatch(
      /Claude models only for now.*switch its container off/,
    );
  });
});
