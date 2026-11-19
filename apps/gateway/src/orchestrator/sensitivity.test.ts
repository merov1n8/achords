import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThread, enqueue, getTask, listMessages, openCoreDatabase } from "@achords/core";
import { openMemory } from "@achords/memory";
import type { ModelProvider, RunRequest, RunResult } from "@achords/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOrchestrator } from "./orchestrator.ts";
import { seedAgents } from "./seed.ts";

const SEED_DIR = new URL("../../../../seed/agents/", import.meta.url).pathname;

const result = (over: Partial<RunResult> = {}): RunResult => ({
  ok: true,
  stopReason: "completed",
  text: "",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  windows: [],
  durationMs: 1,
  ...over,
});

function provider(id: string, reply: (req: RunRequest) => RunResult) {
  const calls: RunRequest[] = [];
  const p: ModelProvider = {
    id,
    async run(req) {
      calls.push(req);
      return reply(req);
    },
  };
  return { p, calls };
}

describe("sensitivity routing (local-only, fail-closed)", () => {
  let home: string;
  let db: ReturnType<typeof openCoreDatabase>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-sens-"));
    seedAgents(SEED_DIR, join(home, "agents"), home);
    // A tool-less writer agent that may run locally.
    mkdirSync(join(home, "agents", "writer"));
    writeFileSync(
      join(home, "agents", "writer", "agent.yaml"),
      "id: writer\nname: Writer\nrole: writer\nworkspace: shared\nmodels:\n  default: cli-claude/sonnet\n  allowed: [cli-claude/sonnet, local/qwen3:8b]\n",
    );
    db = openCoreDatabase(join(home, "core.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const decision = (structured: unknown) => () => result({ structured });

  it("a local-only thread runs the boss on a local model; the frontier model is never called", async () => {
    const cloud = provider("cli-claude", decision({ action: "answer", message: "cloud" }));
    const local = provider("local", decision({ action: "answer", message: "helyi válasz" }));
    const orch = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": cloud.p, local: local.p },
    });
    orch.syncAgents();
    const t = createThread(db, { sensitivity: "local-only" });
    await orch.handleMessage(t.id, "bizalmas kérdés", "telegram");
    expect(cloud.calls).toEqual([]);
    expect(local.calls[0]?.model).toBe("qwen3:8b");
    expect(listMessages(db, t.id).at(-1)?.content).toBe("helyi válasz");
  });

  it("refuses (no fallback) when the boss has no local model allowed", async () => {
    const yaml = join(home, "agents", "boss", "agent.yaml");
    writeFileSync(yaml, readFileSync(yaml, "utf8").replace(/\n {2}allowed: .*\n/, "\n"));
    const cloud = provider("cli-claude", decision({ action: "answer", message: "cloud" }));
    const local = provider("local", decision({ action: "answer", message: "x" }));
    const orch = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": cloud.p, local: local.p },
    });
    orch.syncAgents();
    const t = createThread(db, { sensitivity: "local-only" });
    expect(await orch.handleMessage(t.id, "titok", "web")).toBe("error");
    expect(cloud.calls).toEqual([]);
    expect(listMessages(db, t.id).at(-1)?.content).toMatch(/local-only.*local model/i);
  });

  it("tasks delegated from a local-only thread are local-only", async () => {
    const local = provider(
      "local",
      decision({
        action: "delegate",
        message: "ok",
        task: {
          title: "Draft",
          description: "Write it",
          assignee: "writer",
          language: "Hungarian",
        },
      }),
    );
    const orch = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": provider("cli-claude", () => result()).p, local: local.p },
    });
    orch.syncAgents();
    const t = createThread(db, { sensitivity: "local-only" });
    await orch.handleMessage(t.id, "írd meg", "web");
    expect(db.prepare("SELECT sensitivity FROM tasks").get()?.sensitivity).toBe("local-only");
  });

  it("a local-only task runs on the agent's local model; if the server is down it waits, never falls back", async () => {
    const cloud = provider("cli-claude", () => result({ text: "cloud" }));
    let up = false;
    const local = provider("local", () =>
      up
        ? result({ text: "kész" })
        : result({ ok: false, stopReason: "unavailable", error: "down" }),
    );
    const orch = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": cloud.p, local: local.p },
    });
    orch.syncAgents();
    const task = enqueue(db, {
      title: "Draft",
      assigneeAgentId: "writer",
      sensitivity: "local-only",
      maxAttempts: 1,
    });

    await orch.workOnce();
    expect(getTask(db, task.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(getTask(db, task.id)?.error).toMatch(/local model/);
    expect(cloud.calls).toEqual([]);

    db.prepare("UPDATE tasks SET not_before = 0").run();
    up = true;
    await orch.workOnce();
    expect(getTask(db, task.id)?.status).toBe("done");
    expect(local.calls.at(-1)?.model).toBe("qwen3:8b");
    expect(cloud.calls).toEqual([]);
  });

  it("fails clearly (no retry) when the agent has no local model at all", async () => {
    const cloud = provider("cli-claude", () => result({ text: "cloud" }));
    const orch = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": cloud.p, local: provider("local", () => result()).p },
    });
    orch.syncAgents();
    const task = enqueue(db, {
      title: "Site",
      assigneeAgentId: "web-dev",
      sensitivity: "local-only",
    });
    await orch.workOnce();
    expect(getTask(db, task.id)).toMatchObject({ status: "failed" });
    expect(getTask(db, task.id)?.error).toMatch(/local/);
    expect(cloud.calls).toEqual([]);
  });

  it("local-only memories never reach a frontier prompt, but local runs see them", async () => {
    const memory = openMemory(":memory:", { dims: 16 });
    await memory.add({
      workspace: "shared",
      kind: "fact",
      content: "Acme salary is 900k",
      localOnly: true,
    });
    await memory.add({ workspace: "shared", kind: "fact", content: "Acme likes plain HTML" });
    const cloud = provider("cli-claude", decision({ action: "answer", message: "x" }));
    const local = provider("local", decision({ action: "answer", message: "y" }));
    const orch = createOrchestrator({
      db,
      home,
      memory,
      providers: { "cli-claude": cloud.p, local: local.p },
    });
    orch.syncAgents();

    await orch.handleMessage(createThread(db, {}).id, "Acme salary HTML", "web");
    expect(cloud.calls[0]?.prompt).toContain("plain HTML");
    expect(cloud.calls[0]?.prompt).not.toContain("900k");

    await orch.handleMessage(
      createThread(db, { sensitivity: "local-only" }).id,
      "Acme salary HTML",
      "web",
    );
    expect(local.calls[0]?.prompt).toContain("900k");
    memory.close();
  });

  it("summaries of local-only tasks are stored as local-only memories", async () => {
    const memory = openMemory(":memory:", { dims: 16 });
    const local = provider("local", () => result({ text: "Draft with secret numbers" }));
    const orch = createOrchestrator({
      db,
      home,
      memory,
      providers: { "cli-claude": provider("cli-claude", () => result()).p, local: local.p },
    });
    orch.syncAgents();
    enqueue(db, { title: "Secret draft", assigneeAgentId: "writer", sensitivity: "local-only" });
    await orch.workOnce();
    expect(await memory.search("Secret draft numbers", { workspaces: ["shared"] })).toEqual([]);
    const local2 = await memory.search("Secret draft numbers", {
      workspaces: ["shared"],
      includeLocalOnly: true,
    });
    expect(local2[0]?.localOnly).toBe(true);
    memory.close();
  });
});
