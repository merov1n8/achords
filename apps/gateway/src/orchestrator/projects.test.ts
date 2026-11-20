import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThread, getTask, openCoreDatabase, type Task } from "@achords/core";
import type { Memory } from "@achords/memory";
import { createProject } from "@achords/policy";
import type { ModelProvider, RunRequest, RunResult } from "@achords/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOrchestrator, type Orchestrator } from "./orchestrator.ts";

const result = (over: Partial<RunResult> = {}): RunResult => ({
  ok: true,
  stopReason: "completed",
  text: "done",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  windows: [],
  durationMs: 1,
  ...over,
});

describe("projects in runs (ADR-0031)", () => {
  let home: string;
  let db: ReturnType<typeof openCoreDatabase>;
  let orch: Orchestrator;
  let calls: { task: Task | undefined; req: RunRequest }[];
  let behave: (req: RunRequest) => RunResult;
  const searched: string[][] = [];
  const stored: string[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-projects-"));
    const agents: [string, string][] = [
      ["boss", "shared", ""],
      ["web-dev", "web-clients", "tools: [Read, Edit]"],
      ["writer", "marketing", "tools: [Read]"],
    ].map(([id, ws, extra]) => [id as string, `workspace: ${ws}\n${extra}`]);
    for (const [id, rest] of agents) {
      mkdirSync(join(home, "agents", id), { recursive: true });
      writeFileSync(
        join(home, "agents", id, "agent.yaml"),
        `id: ${id}\nname: ${id}\nrole: ${id}\n${rest}\nmodels:\n  default: cli-claude/sonnet\n`,
      );
    }
    createProject(join(home, "projects"), {
      slug: "acme",
      name: "Acme shop",
      workspace: "web-clients",
    });
    writeFileSync(
      join(home, "projects", "acme", "PROJECT.md"),
      "# Acme shop\n\nWooCommerce. Never touch the live shop.\n",
    );
    db = openCoreDatabase(join(home, "core.db"));
    calls = [];
    searched.length = 0;
    stored.length = 0;
    behave = () => result();
    const p: ModelProvider = {
      id: "cli-claude",
      async run(req) {
        const row = db.prepare("SELECT id FROM tasks WHERE status = 'claimed'").get();
        calls.push({ task: row ? getTask(db, String(row.id)) : undefined, req });
        return behave(req);
      },
    };
    const memory = {
      search: async (_q: string, o: { workspaces: string[] }) => {
        searched.push(o.workspaces);
        return [];
      },
      add: async (m: { workspace: string }) => {
        stored.push(m.workspace);
        return 1;
      },
    } as unknown as Memory;
    orch = createOrchestrator({ db, home, providers: { "cli-claude": p }, memory });
    orch.syncAgents();
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const drain = async () => {
    for (let i = 0; i < 20 && (await orch.workOnce()); i++);
  };
  const give = (agent: string, project?: string) => {
    const thread = createThread(db, project ? { project } : {});
    const r = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent, title: "Fix cart", instructions: "go" },
    );
    if (!r.ok) throw new Error(r.reason);
    return r.taskId;
  };

  it("the boss sees the thread's project and PROJECT.md; its delegated task carries the project", async () => {
    behave = () =>
      result({
        structured: {
          action: "delegate",
          message: "ok",
          task: { title: "Fix cart", description: "d", assignee: "web-dev", language: "English" },
        },
      });
    const thread = createThread(db, { project: "acme" });
    await orch.handleMessage(thread.id, "fix the cart", "web");
    expect(calls[0]?.req.prompt).toContain("Never touch the live shop.");
    expect(calls[0]?.req.prompt).toContain("Project: Acme shop (acme, workspace web-clients)");
    const task = db.prepare("SELECT project FROM tasks").get();
    expect(task?.project).toBe("acme");
  });

  it("an agent of the project's workspace works in files/ and gets PROJECT.md", async () => {
    give("web-dev", "acme");
    await drain();
    const req = calls[0]?.req;
    expect(req?.cwd).toBe(join(home, "projects", "acme", "files"));
    expect(req?.prompt).toContain("Never touch the live shop.");
  });

  it("an agent of another workspace gets the text but not the folder", async () => {
    give("writer", "acme");
    await drain();
    const req = calls[0]?.req;
    expect(req?.prompt).toContain("Never touch the live shop.");
    expect(req?.cwd).not.toContain(join("projects", "acme"));
    expect(req?.addDirs ?? []).not.toContain(join(home, "projects", "acme", "files"));
  });

  it("project memory has its own namespace; other runs do not search it", async () => {
    give("web-dev", "acme");
    give("web-dev");
    await drain();
    expect(searched[0]).toEqual(["web-clients", "shared", "web-clients/acme"]);
    expect(searched[1]).toEqual(["web-clients", "shared"]);
    expect(stored).toEqual(["web-clients/acme", "web-clients"]);
  });

  it("a project's workflow.yaml replaces the workspace's for its cards", () => {
    writeFileSync(
      join(home, "projects", "acme", "workflow.yaml"),
      "columns: [doing, staged, live]\nstart: doing\nfinish: staged\ntransitions:\n  - { from: staged, to: live, by: owner }\n",
    );
    const id = give("web-dev", "acme");
    expect(getTask(db, id)?.column).toBe("doing");
    expect(orch.ownerMove(id, "doing", "live")).toEqual({ ok: true, override: true });
  });

  it("a task for an unknown project fails without running", async () => {
    give("web-dev", "gone");
    await drain();
    expect(calls).toHaveLength(0);
    expect(db.prepare("SELECT status, error FROM tasks").get()).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/unknown project gone/),
    });
  });
});
