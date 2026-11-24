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
  threadCard,
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

  it("neither the card's own run nor its review gets ask_parent (ADR-0066)", async () => {
    setup([
      ["dev", "roles: [dev]"],
      ["qa", "roles: [qa]"],
    ]);
    const { id } = give();
    let asked: unknown;
    behave = (_req, task) => {
      if (task.assigneeAgentId === "qa") {
        asked = orch.askParent({ from: "task", taskId: task.id }, "Is this enough?");
        orch.moveTask({ from: "task", taskId: task.id }, { taskId: id, to: "done" });
      }
      return result();
    };
    await drain();
    expect(calls.map((c) => c.task.assigneeAgentId)).toEqual(["dev", "qa"]);
    for (const c of calls) expect(c.req.allowedTools).not.toContain("mcp__achords__ask_parent");
    expect(asked).toMatchObject({ ok: false });
  });

  it("a review's verdict is posted in the chat; a card sent back restarts its agent with the findings (ADR-0062)", async () => {
    setup([
      ["dev", "roles: [dev]"],
      ["qa", "roles: [qa]"],
    ]);
    const { id, thread } = give();
    let reviews = 0;
    behave = (_req, task) => {
      if (task.assigneeAgentId === "dev") return result({ text: `built v${reviews + 1}` });
      // QA sends the first version back and approves the second.
      const card = String(threadCard(db, thread.id));
      reviews++;
      orch.moveTask(
        { from: "task", taskId: task.id },
        { taskId: card, to: reviews === 1 ? "in_progress" : "done" },
      );
      return result({ text: reviews === 1 ? "Needs a fix: the button is dead." : "Approved." });
    };
    await drain();
    expect(calls.map((c) => c.task.assigneeAgentId)).toEqual(["dev", "qa", "dev", "qa"]);
    // The second dev run is told what the review found, and sees its own earlier report.
    expect(calls[2]?.req.prompt).toMatch(
      /qa reviewed this work and sent it back[\s\S]*the button is dead/,
    );
    expect(calls[2]?.req.prompt).toContain("built v1");
    expect(calls[2]?.task.id).not.toBe(id);
    // One card all along (ADR-0059): it ends in done, on the newest task.
    const card = String(threadCard(db, thread.id));
    expect(card).toBe(calls[2]?.task.id);
    expect(column(card)).toBe("done");
    expect(column(id)).toBeNull();
    const chat = listMessages(db, thread.id).map((m) => [m.author, m.content]);
    expect(chat).toContainEqual([
      "qa",
      "Review (qa): Build page\n\nNeeds a fix: the button is dead.",
    ]);
    expect(chat).toContainEqual(["boss", "→ dev continues with what the review found."]);
    expect(chat).toContainEqual(["qa", "Review (qa): Build page\n\nApproved."]);
  });

  it("a workflow that needs checks holds unverified work back from review (ADR-0065)", async () => {
    setup([
      ["dev", "roles: [dev]"],
      ["qa", "roles: [qa]"],
    ]);
    const wf = join(home, "workflows", "shared.yaml");
    writeFileSync(
      wf,
      readFileSync(wf, "utf8").replace(
        "review: { assign: role:qa }",
        "review: { assign: role:qa, needs_checks: true }",
      ),
    );
    // Not reported at all: no review run, the card stays, the chat says why.
    const first = give();
    await drain();
    expect(calls.map((c) => c.task.assigneeAgentId)).toEqual(["dev"]);
    expect(calls[0]?.req.allowedTools).toContain("mcp__achords__report_checks");
    expect(calls[0]?.req.prompt).toMatch(/call report_checks/);
    expect(column(first.id)).toBe("in_progress");
    expect(listMessages(db, first.thread.id).at(-1)?.content).toMatch(
      /not sent to review[\s\S]*no build or test result was reported/,
    );

    // Reported as failed: held back with the agent's own reason.
    behave = (_req, task) => {
      if (task.assigneeAgentId === "dev") {
        orch.reportChecks(
          { from: "task", taskId: task.id },
          { passed: false, summary: "Unity was not running" },
        );
      }
      return result();
    };
    const second = give();
    await drain();
    expect(column(second.id)).toBe("in_progress");
    expect(listMessages(db, second.thread.id).at(-1)?.content).toMatch(/Unity was not running/);
    expect(calls.filter((c) => c.task.assigneeAgentId === "qa")).toHaveLength(0);

    // Reported as passed: review as usual.
    behave = (_req, task) => {
      if (task.assigneeAgentId === "dev") {
        orch.reportChecks(
          { from: "task", taskId: task.id },
          { passed: true, summary: "42 tests green" },
        );
      }
      return result();
    };
    const third = give();
    await drain();
    expect(column(third.id)).toBe("review");
    expect(calls.at(-1)?.task.assigneeAgentId).toBe("qa");
    expect(calls.at(-1)?.req.prompt).toContain("42 tests green");
    expect(calls.at(-1)?.req.allowedTools).not.toContain("mcp__achords__report_checks");
  });

  it("a card sent back again and again stops at the owner", async () => {
    setup([
      ["dev", "roles: [dev]"],
      ["qa", "roles: [qa]"],
    ]);
    const { thread } = give();
    behave = (_req, task) => {
      if (task.assigneeAgentId === "qa") {
        orch.moveTask(
          { from: "task", taskId: task.id },
          { taskId: String(threadCard(db, thread.id)), to: "in_progress" },
        );
      }
      return result({ text: "x" });
    };
    for (let i = 0; i < 40 && (await orch.workOnce()); i++);
    // The first version and three reworks, each reviewed; the fourth send-back is not acted on.
    expect(calls.filter((c) => c.task.assigneeAgentId === "dev")).toHaveLength(4);
    expect(listMessages(db, thread.id).at(-1)?.content).toMatch(
      /sent back 4 times[\s\S]*waits for you/,
    );
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
  describe("an owner's card move starts work (ADR-0066)", () => {
    const tasksOf = (agent: string) =>
      db
        .prepare("SELECT id, status FROM tasks WHERE assignee_agent_id = ? ORDER BY rowid")
        .all(agent) as { id: string; status: string }[];

    it("an owner move of a done card queues the assignee once, as a successor on the same card", async () => {
      setup([["dev", "roles: [dev]"]]);
      const { id, thread } = give();
      await drain();
      expect(getTask(db, id)).toMatchObject({ status: "done", column: "review" });
      expect(orch.ownerMove(id, "review", "in_progress")).toMatchObject({ ok: true });
      const queued = tasksOf("dev").filter((x) => x.status === "queued");
      expect(queued).toHaveLength(1);
      const next = getTask(db, queued[0]?.id as string) as Task;
      // The same card (ADR-0059) and the same session key, so the agent's session carries on.
      expect(next).toMatchObject({ rootId: id, continuesFrom: id, column: "in_progress" });
      expect(threadCard(db, thread.id)).toBe(next.id);
      expect(column(id)).toBeNull();
      expect(listMessages(db, thread.id).at(-1)?.content).toBe("→ dev is on it.");
      await drain();
      expect(calls.map((c) => c.task.id)).toEqual([id, next.id]);
      expect(calls[1]?.req.prompt).toMatch(/owner moved this card to "in_progress"/);
      // Owner moves are not review send-backs (ADR-0062 counts only agent moves).
      expect(listMoves(db, next.id).filter((m) => m.actor.startsWith("agent:"))).toEqual([]);
    });

    it("a done card moved back from done also gets a successor", async () => {
      setup([["dev", "roles: [dev]"]]);
      const { id } = give();
      await drain();
      orch.ownerMove(id, "review", "done");
      expect(tasksOf("dev").filter((x) => x.status === "queued")).toHaveLength(0);
      orch.ownerMove(id, "done", "in_progress");
      expect(tasksOf("dev").filter((x) => x.status === "queued")).toHaveLength(1);
    });

    it("the same move by an agent queues nothing", async () => {
      setup([
        ["dev", "roles: [dev]"],
        ["qa", "roles: [qa]"],
      ]);
      const { id } = give();
      let queuedAfterMove: number | undefined;
      behave = (_req, task) => {
        if (task.assigneeAgentId === "qa" && queuedAfterMove === undefined) {
          expect(
            orch.moveTask({ from: "task", taskId: task.id }, { taskId: id, to: "in_progress" }),
          ).toEqual({ ok: true });
          queuedAfterMove = tasksOf("dev").filter((x) => x.status === "queued").length;
        }
        return result();
      };
      await orch.workOnce(); // dev
      await orch.workOnce(); // qa moves the card back
      // Only the review's own end restarts the card (ADR-0062), never the move itself.
      expect(queuedAfterMove).toBe(0);
    });

    it("a card assigned to the owner queues nothing", async () => {
      setup([["dev", "roles: [dev]"]]);
      const r = orch.createCard({ title: "Mine" });
      if (!r.ok) throw new Error(r.reason);
      expect(orch.ownerMove(r.taskId, "backlog", "in_progress")).toMatchObject({ ok: true });
      expect(getTask(db, r.taskId)).toMatchObject({ parked: true, column: "in_progress" });
      await drain();
      expect(calls).toEqual([]);
    });

    it("a card already queued or claimed gets no second task", async () => {
      setup([["dev", "roles: [dev]"]]);
      const { id } = give();
      orch.ownerMove(id, "in_progress", "todo");
      orch.ownerMove(id, "todo", "in_progress");
      expect(tasksOf("dev")).toHaveLength(1);
      let during: number | undefined;
      behave = () => {
        orch.ownerMove(id, "in_progress", "todo");
        orch.ownerMove(id, "todo", "in_progress");
        during = tasksOf("dev").length;
        return result();
      };
      await drain();
      expect(during).toBe(1);
      expect(calls).toHaveLength(1);
    });

    it("a parked card starts with its budget and stays in the column it was dropped in", async () => {
      setup([["dev", "roles: [dev]\nbudget:\n  per_run_usd: 2"]]);
      const r = orch.createCard({ title: "Write the FAQ", agent: "dev" });
      if (!r.ok) throw new Error(r.reason);
      expect(orch.ownerMove(r.taskId, "backlog", "in_progress")).toMatchObject({ ok: true });
      expect(getTask(db, r.taskId)).toMatchObject({
        parked: false,
        budgetUsd: 2,
        column: "in_progress",
      });
      await drain();
      expect(calls.map((c) => c.task.id)).toEqual([r.taskId]);
    });

    it("a spent budget refuses the dispatch with a chat message", async () => {
      setup([["dev", "roles: [dev]\nbudget:\n  per_run_usd: 1"]]);
      const { id, thread } = give();
      await drain();
      db.prepare("UPDATE tasks SET spent_usd = 1 WHERE id = ?").run(id);
      expect(orch.ownerMove(id, "review", "in_progress")).toMatchObject({ ok: true });
      expect(tasksOf("dev")).toHaveLength(1);
      expect(column(id)).toBe("in_progress");
      expect(listMessages(db, thread.id).at(-1)?.content).toMatch(
        /"Build page" was moved but not started: .*budget/,
      );
    });

    it("a custom column with the key starts work; a column without it behaves as today", async () => {
      setup([["dev", "roles: [dev]"]]);
      const path = join(home, "workflows", "shared.yaml");
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(
          "in_progress: { start: assignee }",
          "todo: { start: assignee }",
        ),
      );
      const { id } = give();
      await drain();
      orch.ownerMove(id, "review", "in_progress");
      expect(tasksOf("dev").filter((x) => x.status === "queued")).toHaveLength(0);
      orch.ownerMove(id, "in_progress", "todo");
      const queued = tasksOf("dev").filter((x) => x.status === "queued");
      expect(queued).toHaveLength(1);
      expect(column(queued[0]?.id as string)).toBe("todo");
      await drain();
      expect(calls).toHaveLength(2);
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
