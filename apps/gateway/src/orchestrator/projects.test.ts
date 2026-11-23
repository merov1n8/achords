import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendMessage,
  createThread,
  getTask,
  listMessages,
  openCoreDatabase,
  type Task,
} from "@achords/core";
import type { Memory } from "@achords/memory";
import { createProject, updateProject } from "@achords/policy";
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

  it("a shell run with more than one folder is told where it starts and how to change folder (ADR-0061)", async () => {
    const repo = join(home, "Game Repo");
    writeFileSync(
      join(home, "agents", "web-dev", "agent.yaml"),
      `id: web-dev\nname: web-dev\nrole: web-dev\nworkspace: web-clients\ntools: [Read, Edit, Bash]\nfs:\n  write: ["${repo}"]\nshell:\n  allow: ["git status"]\nmodels:\n  default: cli-claude/sonnet\n`,
    );
    orch.syncAgents();
    give("web-dev", "acme");
    await drain();
    const files = join(home, "projects", "acme", "files");
    expect(calls[0]?.req.cwd).toBe(files);
    expect(calls[0]?.req.addDirs).toContain(repo);
    expect(calls[0]?.req.prompt).toContain(
      `Your shell starts in ${files}. Your other work folders: ${repo}.`,
    );
    expect(calls[0]?.req.prompt).toMatch(/first run `cd "<folder>"` as a command of its own/);

    // One folder, or no shell: nothing to explain.
    give("web-dev");
    give("writer", "acme");
    await drain();
    expect(calls[1]?.req.prompt).not.toContain("Your shell starts in");
    expect(calls[2]?.req.prompt).not.toContain("Your shell starts in");
  });

  it("a project with a work folder elsewhere starts its runs there; files/ stays a folder of the run (ADR-0064)", async () => {
    const repo = join(home, "Game Repo");
    mkdirSync(repo);
    const yaml = join(home, "projects", "acme", "project.yaml");
    writeFileSync(yaml, `${readFileSync(yaml, "utf8")}workdir: ${JSON.stringify(repo)}\n`);
    give("web-dev", "acme");
    give("writer", "acme"); // another workspace: the text only, as before
    await drain();
    expect(calls[0]?.req.cwd).toBe(repo);
    expect(calls[0]?.req.addDirs).toContain(join(home, "projects", "acme", "files"));
    expect(calls[1]?.req.cwd).not.toBe(repo);
    expect(calls[1]?.req.addDirs ?? []).not.toContain(repo);
    // Edited in the web form (name, accounts): the work folder is kept.
    updateProject(join(home, "projects"), "acme", { name: "Acme 2" });
    expect(readFileSync(yaml, "utf8")).toContain(`workdir: ${JSON.stringify(repo)}`);
  });

  it("an agent of the project's workspace works in files/ and gets PROJECT.md", async () => {
    updateProject(join(home, "projects"), "acme", {
      integrations: { instagram: ["@acme", "@acme.shop"] },
    });
    give("web-dev", "acme");
    await drain();
    const req = calls[0]?.req;
    expect(req?.cwd).toBe(join(home, "projects", "acme", "files"));
    expect(req?.prompt).toContain("Never touch the live shop.");
    expect(req?.prompt).toContain("Client accounts:\n- instagram: @acme, @acme.shop");
  });

  it("an agent working for the owner sees the chat so far (follow-ups keep their context)", async () => {
    const thread = createThread(db, { project: "acme" });
    appendMessage(db, {
      threadId: thread.id,
      role: "user",
      channel: "web",
      content: "Plan the club system. Tier 0 is the old 11% discount.",
    });
    appendMessage(db, {
      threadId: thread.id,
      role: "agent",
      author: "web-dev",
      channel: "web",
      content: "Done: plan written. Open question: where is the 11% stored?",
    });
    appendMessage(db, {
      threadId: thread.id,
      role: "agent",
      author: "trace",
      channel: "web",
      content: "tool noise",
      visibility: "trace",
    });
    const r = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: "web-dev", title: "Answer", instructions: "It is in the price surcharge." },
    );
    if (!r.ok) throw new Error(r.reason);
    await drain();
    const prompt = calls[0]?.req.prompt ?? "";
    expect(prompt).toContain("Conversation in this chat so far");
    expect(prompt).toContain("owner: Plan the club system. Tier 0 is the old 11% discount.");
    expect(prompt).toContain(
      "web-dev: Done: plan written. Open question: where is the 11% stored?",
    );
    expect(prompt).not.toContain("tool noise");
    // The task itself still comes last and wins.
    expect(prompt.indexOf("Conversation in this chat so far")).toBeLessThan(
      prompt.indexOf("# Task: Answer"),
    );
  });

  it("long chat messages reach the agent whole; past the total budget the oldest drop out", async () => {
    const thread = createThread(db, { project: "acme" });
    const say = (role: "user" | "agent", content: string) =>
      appendMessage(db, {
        threadId: thread.id,
        role,
        ...(role === "agent" ? { author: "web-dev" } : {}),
        channel: "web",
        content,
      });
    say("user", `OLDEST ${"o".repeat(30_000)}`);
    say("user", `PASTED ${"p".repeat(25_000)} END-OF-PASTE`);
    say("agent", `REPLY ${"r".repeat(9_000)} END-OF-REPLY`);
    const r = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: "web-dev", title: "Answer", instructions: "Go on." },
    );
    if (!r.ok) throw new Error(r.reason);
    await drain();
    const prompt = calls[0]?.req.prompt ?? "";
    expect(prompt).toContain("END-OF-PASTE");
    expect(prompt).toContain("END-OF-REPLY");
    expect(prompt).not.toContain("OLDEST");
  });

  it("posts a long agent reply to the chat in full", async () => {
    const thread = createThread(db, { project: "acme" });
    const long = `${"a".repeat(9_000)} END`;
    behave = () => result({ text: long });
    const r = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: "web-dev", title: "Write", instructions: "Write a lot." },
    );
    if (!r.ok) throw new Error(r.reason);
    await drain();
    const posted = listMessages(db, thread.id).map((m) => m.content);
    expect(posted.some((c) => c.includes(long))).toBe(true);
  });

  it("lists the project's git repositories as the only ones to work in", async () => {
    updateProject(join(home, "projects"), "acme", {
      integrations: {
        repository: ["https://github.com/acme/booking", "https://gitlab.com/acme/theme"],
        instagram: ["@acme"],
      },
    });
    give("web-dev", "acme");
    await drain();
    const prompt = calls[0]?.req.prompt ?? "";
    expect(prompt).toContain(
      "Git repositories of this project (work only in these):\n- https://github.com/acme/booking\n- https://gitlab.com/acme/theme",
    );
    expect(prompt).toContain(`clone them into ${join(home, "projects", "acme", "files")}`);
    expect(prompt).toContain("Client accounts:\n- instagram: @acme");
    expect(prompt).not.toContain("- repository:");
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
