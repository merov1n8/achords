import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addChecklistItem,
  addComment,
  createThread,
  getTask,
  getThread,
  listMessages,
  listMoves,
  liveProgress,
  openCoreDatabase,
  setDraining,
  type Task,
} from "@achords/core";
import { createProject } from "@achords/policy";
import type { ModelProvider, RunRequest, RunResult } from "@achords/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunTokens } from "../mcp/tokens.ts";
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

describe("kanban workflow in the gateway (ADR-0030)", () => {
  let home: string;
  let db: ReturnType<typeof openCoreDatabase>;
  let orch: Orchestrator;
  let calls: { task: Task; req: RunRequest }[];
  let behave: (req: RunRequest, task: Task) => RunResult;

  const setup = (agents: [string, string][]) => {
    for (const [id, extra] of [["boss", ""], ...agents] as [string, string][]) {
      mkdirSync(join(home, "agents", id), { recursive: true });
      writeFileSync(
        join(home, "agents", id, "agent.yaml"),
        `id: ${id}\nname: ${id}\nrole: ${id}\nworkspace: shared\nmodels:\n  default: cli-claude/sonnet\n${extra}\n`,
      );
    }
    db = openCoreDatabase(join(home, "core.db"));
    const p: ModelProvider = {
      id: "cli-claude",
      async run(req) {
        const row = db.prepare("SELECT id FROM tasks WHERE status = 'claimed'").get();
        const task = getTask(db, String(row?.id)) as Task;
        calls.push({ task, req });
        return behave(req, task);
      },
    };
    orch = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": p },
      hub: { url: "http://127.0.0.1:1", tokens: createRunTokens(), serverEntry: "/x.ts" },
    });
    orch.syncAgents();
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-board-"));
    calls = [];
    behave = () => result();
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const give = (agent = "dev") => {
    const thread = createThread(db, {});
    const r = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent, title: "Build page", instructions: "go" },
    );
    if (!r.ok) throw new Error(r.reason);
    return { thread, id: r.taskId };
  };
  const drain = async () => {
    for (let i = 0; i < 20 && (await orch.workOnce()); i++);
  };
  const column = (id: string) => getTask(db, id)?.column;

  it("seeds the workspace workflow once and never overwrites it", () => {
    setup([["dev", "roles: [dev]"]]);
    const path = join(home, "workflows", "shared.yaml");
    expect(readFileSync(path, "utf8")).toContain("columns: [backlog");
    writeFileSync(path, `${readFileSync(path, "utf8")}# mine\n`);
    orch.syncAgents();
    expect(readFileSync(path, "utf8")).toContain("# mine");
  });

  it("a task given to an agent gets a card in the start column", () => {
    setup([["dev", "roles: [dev]"]]);
    const { id } = give();
    expect(column(id)).toBe("in_progress");
  });

  it("finished work lands in review; without a QA agent nobody is assigned (the owner reviews)", async () => {
    setup([["dev", "roles: [dev]"]]);
    const { id } = give();
    await drain();
    expect(column(id)).toBe("review");
    expect(calls.map((c) => c.task.assigneeAgentId)).toEqual(["dev"]);
    expect(listMoves(db, id).map((m) => [m.from, m.to, m.actor])).toEqual([
      [null, "in_progress", "system"],
      ["in_progress", "review", "system"],
    ]);
  });

  it("review goes to the QA agent; QA can approve, the dev cannot approve its own work", async () => {
    setup([
      ["dev", "roles: [dev]"],
      ["qa", "roles: [qa]"],
    ]);
    const { id } = give();
    let devTry: unknown;
    let qaTry: unknown;
    behave = (req, task) => {
      if (task.assigneeAgentId === "dev") {
        devTry = orch.moveTask({ from: "task", taskId: task.id }, { taskId: id, to: "done" });
      } else {
        expect(req.prompt).toContain(id); // QA is told which card to move
        qaTry = orch.moveTask({ from: "task", taskId: task.id }, { taskId: id, to: "done" });
      }
      return result();
    };
    await drain();
    expect(devTry).toEqual({ ok: false, reason: expect.stringMatching(/not allowed/) });
    expect(qaTry).toEqual({ ok: true });
    expect(column(id)).toBe("done");
    expect(calls.map((c) => c.task.assigneeAgentId)).toEqual(["dev", "qa"]);
    // The review run is part of the card, not a card of its own.
    expect(calls[1]?.task.parentId).toBe(id);
    expect(getTask(db, calls[1]?.task.id ?? "")?.column).toBeNull();
  });

  it("live progress: the run keeps its checklist (TodoWrite) state for the web", async () => {
    setup([["dev", "roles: [dev]\ntools: [Read]"]]);
    give();
    let during: unknown;
    behave = (req) => {
      req.onProgress?.({ done: 1, total: 4, current: "Writing tests" });
      during = liveProgress(db);
      return result();
    };
    await drain();
    expect(calls[0]?.req.tools).toEqual(["Read", "TodoWrite"]);
    expect(calls[0]?.req.allowedTools).toContain("TodoWrite");
    expect(calls[0]?.req.appendSystemPrompt).toMatch(/TodoWrite/);
    expect(during).toEqual([
      expect.objectContaining({
        agentId: "dev",
        title: "Build page",
        done: 1,
        total: 4,
        current: "Writing tests",
      }),
    ]);
    expect(liveProgress(db)).toEqual([]);
  });

  it("the assignee sees the owner's checklist and comments on the card", async () => {
    setup([["dev", "roles: [dev]"]]);
    const { id } = give();
    addChecklistItem(db, id, "Hero section");
    const layout = addChecklistItem(db, id, "Layout");
    db.prepare("UPDATE task_checklist SET done = 1 WHERE id = ?").run(layout?.id ?? 0);
    addComment(db, id, "Use the blue logo");
    await orch.workOnce();
    expect(calls[0]?.req.prompt).toContain(
      "Owner's checklist for this card:\n- [ ] Hero section\n- [x] Layout\n\nOwner's comments on this card:\n- Use the blue logo",
    );
  });

  it("planned stop: a running task is interrupted and continues later from a note, no attempt lost", async () => {
    setup([["dev", "roles: [dev]"]]);
    const { id } = give();
    const abort = new AbortController();
    behave = (req) => {
      if (calls.length === 1) {
        req.onProgress?.({
          done: 1,
          total: 3,
          current: "Hero section",
          items: [
            { content: "Layout", status: "completed" },
            { content: "Hero section", status: "in_progress" },
            { content: "Footer", status: "pending" },
          ],
        });
        abort.abort(); // the gateway is shutting down for `achords stop`
        return result({ ok: false, stopReason: "cancelled", text: "" });
      }
      return result();
    };
    await orch.workOnce(abort.signal);
    expect(getTask(db, id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(getTask(db, id)?.resumeNote).toMatch(
      /\[x\] Layout[\s\S]*\[ \] Hero section \(in progress\)[\s\S]*\[ \] Footer/,
    );

    // While draining nothing new starts; after the restart it continues with the note.
    setDraining(db, true);
    expect(await orch.workOnce()).toBe(false);
    setDraining(db, false);
    await drain();
    expect(calls[1]?.req.prompt).toMatch(/planned stop[\s\S]*\[x\] Layout/);
    expect(getTask(db, id)).toMatchObject({ status: "done", resumeNote: null });
  });

  it("agents get the move_task tool", async () => {
    setup([["dev", "roles: [dev]"]]);
    give();
    await drain();
    expect(calls[0]?.req.allowedTools).toContain("mcp__achords__move_task");
  });

  it("the owner can move anything; moves outside the rules are logged as overrides", () => {
    setup([["dev", "roles: [dev]"]]);
    const { id } = give();
    expect(orch.ownerMove(id, "in_progress", "deployed")).toEqual({ ok: true, override: true });
    expect(listMoves(db, id).at(-1)).toMatchObject({ actor: "owner", override: true });
    // Stale view: the card is no longer where the owner saw it.
    expect(orch.ownerMove(id, "in_progress", "done")).toEqual({
      ok: false,
      reason: expect.stringMatching(/moved/),
    });
  });

  it("the owner moving a card into review assigns it to QA", async () => {
    setup([
      ["dev", "roles: [dev]"],
      ["qa", "roles: [qa]"],
    ]);
    const { id } = give();
    orch.ownerMove(id, "in_progress", "review");
    behave = () => result();
    await drain();
    expect(calls.map((c) => c.task.assigneeAgentId)).toContain("qa");
  });

  it("approve: owner holds an agent's move until the owner presses Approve", async () => {
    setup([
      ["dev", "roles: [dev]"],
      ["qa", "roles: [qa]"],
    ]);
    const path = join(home, "workflows", "shared.yaml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("on_enter:\n", "on_enter:\n  done: { approve: owner }\n"),
    );
    const { thread, id } = give();
    behave = (_req, task) => {
      if (task.assigneeAgentId === "qa") {
        expect(
          orch.moveTask({ from: "task", taskId: task.id }, { taskId: id, to: "done" }),
        ).toEqual({
          ok: true,
          pending: true,
        });
      }
      return result();
    };
    await drain();
    expect(column(id)).toBe("review");
    const ask = listMessages(db, thread.id).find((m) => m.actions?.length);
    expect(ask?.actions?.map((a) => a.data)).toEqual([`move:approve:${id}`, `move:reject:${id}`]);
    expect(orch.runAction(`move:approve:${id}`)).toEqual({
      ok: true,
      message: expect.stringMatching(/done/),
    });
    expect(column(id)).toBe("done");
    expect(listMoves(db, id).at(-1)).toMatchObject({ actor: "agent:qa" });
    expect(listMessages(db, thread.id).find((m) => m.id === ask?.id)?.actions).toBeNull();
    expect(orch.runAction(`move:approve:${id}`)).toEqual({
      ok: false,
      message: expect.stringMatching(/no pending/i),
    });
  });
  describe("cards made by hand", () => {
    it("a card that is not started gets its own chat and is never worked on", async () => {
      setup([["dev", "roles: [dev]"]]);
      const r = orch.createCard({
        title: "Write the FAQ",
        description: "five questions",
        agent: "dev",
      });
      if (!r.ok) throw new Error(r.reason);
      const task = getTask(db, r.taskId) as Task;
      expect(task).toMatchObject({ parked: true, column: "backlog", assigneeAgentId: "dev" });
      expect(getThread(db, task.threadId as string)?.title).toBe("Write the FAQ");
      expect(listMessages(db, task.threadId as string).length).toBeGreaterThan(0);
      await drain();
      expect(calls).toEqual([]);
      expect(listMoves(db, r.taskId).map((m) => [m.from, m.to, m.actor])).toEqual([
        [null, "backlog", "owner"],
      ]);
    });

    it("Start un-parks it, moves it to the start column (logged) and the agent works on it", async () => {
      setup([["dev", "roles: [dev]"]]);
      const r = orch.createCard({ title: "Write the FAQ" });
      if (!r.ok) throw new Error(r.reason);
      expect(orch.startCard(r.taskId)).toEqual({
        ok: false,
        reason: expect.stringMatching(/agent/),
      });
      expect(orch.startCard(r.taskId, "dev")).toEqual({ ok: true });
      expect(getTask(db, r.taskId)).toMatchObject({ parked: false, assigneeAgentId: "dev" });
      expect(listMoves(db, r.taskId).map((m) => [m.from, m.to, m.actor])).toEqual([
        [null, "backlog", "owner"],
        ["backlog", "in_progress", "owner"],
      ]);
      expect(orch.startCard(r.taskId, "dev")).toEqual({
        ok: false,
        reason: expect.stringMatching(/already/),
      });
      await drain();
      expect(calls.map((c) => c.task.id)).toEqual([r.taskId]);
      expect(column(r.taskId)).toBe("review");
    });

    it("Start now hands it to the agent at once, through the same path as a chat message", async () => {
      setup([["dev", "roles: [dev]"]]);
      const r = orch.createCard({ title: "Fix login", agent: "dev", column: "todo", start: true });
      if (!r.ok) throw new Error(r.reason);
      expect(getTask(db, r.taskId)).toMatchObject({ parked: false, column: "in_progress" });
      await drain();
      expect(calls.map((c) => c.task.id)).toEqual([r.taskId]);
    });

    it("a card without an agent follows its project's workspace and workflow", () => {
      setup([["dev", "roles: [dev]"]]);
      createProject(join(home, "projects"), { slug: "acme", name: "Acme", workspace: "clients" });
      writeFileSync(
        join(home, "workflows", "clients.yaml"),
        "columns: [ideas, doing, done]\nstart: doing\nfinish: done\ntransitions: []\n",
      );
      const r = orch.createCard({ title: "Logo", project: "acme" });
      if (!r.ok) throw new Error(r.reason);
      const task = getTask(db, r.taskId) as Task;
      expect(task).toMatchObject({ column: "ideas", project: "acme" });
      expect(getThread(db, task.threadId as string)?.project).toBe("acme");
    });

    it("refuses an unknown agent or column, and Start now without an agent", () => {
      setup([["dev", "roles: [dev]"]]);
      expect(orch.createCard({ title: "x", agent: "nobody" })).toEqual({
        ok: false,
        reason: expect.stringMatching(/no agent called nobody/i),
      });
      expect(orch.createCard({ title: "x", project: "ghost" })).toEqual({
        ok: false,
        reason: "There is no project called ghost.",
      });
      expect(orch.createCard({ title: "x", column: "nowhere" })).toEqual({
        ok: false,
        reason: expect.stringMatching(/column/i),
      });
      expect(orch.createCard({ title: "x", start: true })).toEqual({
        ok: false,
        reason: expect.stringMatching(/agent/i),
      });
      expect(db.prepare("SELECT COUNT(*) AS n FROM threads").get()?.n).toBe(0);
    });

    it("moving a parked card into review does not start a QA run", async () => {
      setup([
        ["dev", "roles: [dev]"],
        ["qa", "roles: [qa]"],
      ]);
      const r = orch.createCard({ title: "x", agent: "dev" });
      if (!r.ok) throw new Error(r.reason);
      expect(orch.ownerMove(r.taskId, "backlog", "review")).toMatchObject({ ok: true });
      await drain();
      expect(calls).toEqual([]);
    });
  });
});
