import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createThread,
  getRoom,
  getTask,
  listComments,
  listMessages,
  listRooms,
  listThreads,
  openCoreDatabase,
  type Task,
} from "@achords/core";
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

describe("agent rooms (ADR-0032)", () => {
  let home: string;
  let db: ReturnType<typeof openCoreDatabase>;
  let orch: Orchestrator;
  let calls: { task: Task; req: RunRequest }[];
  let behave: (req: RunRequest, task: Task) => RunResult;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-rooms-"));
    const agents: [string, string][] = [
      ["boss", ""],
      [
        "dev",
        "tools: [Read, Edit, Bash]\nshell:\n  allow: [ls]\ndelegation:\n  can_delegate_to: [qa, writer]\n  accepts_from: [lead]",
      ],
      ["lead", "tools: [Read]\ndelegation:\n  can_delegate_to: [dev]"],
      ["qa", "tools: [Read, Grep, Write]\ndelegation:\n  accepts_from: [dev]"],
      ["writer", "tools: [Read]\ndelegation:\n  accepts_from: [dev]"],
      ["stranger", "tools: [Read]"],
    ];
    for (const [id, extra] of agents) {
      mkdirSync(join(home, "agents", id), { recursive: true });
      writeFileSync(
        join(home, "agents", id, "agent.yaml"),
        `id: ${id}\nname: ${id}\nrole: ${id}\nworkspace: shared\nmodels:\n  default: cli-claude/sonnet\n${extra}\n`,
      );
    }
    db = openCoreDatabase(join(home, "core.db"));
    calls = [];
    behave = () => result();
    provider = {
      id: "cli-claude",
      async run(req) {
        const row = db.prepare("SELECT id FROM tasks WHERE status = 'claimed'").get();
        const task = getTask(db, String(row?.id)) as Task;
        calls.push({ task, req });
        return behave(req, task);
      },
    };
    orch = build();
  });
  let provider: ModelProvider;
  const build = (extra: Partial<Parameters<typeof createOrchestrator>[0]> = {}) => {
    const o = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": provider },
      hub: { url: "http://127.0.0.1:1", tokens: createRunTokens(), serverEntry: "/x.ts" },
      ...extra,
    });
    o.syncAgents();
    return o;
  };
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const drain = async () => {
    for (let i = 0; i < 30 && (await orch.workOnce()); i++);
  };

  const opening = {
    topic: "Hero copy",
    question: "Short or long headline?",
    participants: ["qa", "writer"],
    rounds: 2,
  };

  it("runs a bounded, read-only discussion and lets the opener decide; hidden from the owner's chats", async () => {
    const thread = createThread(db, {});
    const root = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: "dev", title: "Landing", instructions: "go" },
    );
    if (!root.ok) throw new Error(root.reason);
    let opened: unknown;
    behave = (req, task) => {
      if (task.assigneeAgentId === "dev" && !req.prompt.includes("Discussion")) {
        opened = orch.openRoom({ from: "task", taskId: task.id }, opening);
        return result({ text: "waiting" });
      }
      if (task.roomId) return result({ text: `${task.assigneeAgentId}: my view` });
      return result({ text: "Decision: short headline." });
    };
    await drain();
    expect(opened).toMatchObject({ ok: true });
    expect(calls.map((c) => c.task.assigneeAgentId)).toEqual([
      "dev",
      "qa",
      "writer",
      "qa",
      "writer",
      "dev",
    ]);

    // Turns are read-only: own read tools only, no shell, no hub tools.
    const qaTurn = calls[1]?.req;
    expect(qaTurn?.tools).toEqual(["Read", "Grep"]);
    expect(qaTurn?.allowedTools).not.toContain("mcp__achords__delegate");
    expect(qaTurn?.mcpConfigPath).toBeUndefined();
    // Later speakers see the transcript so far.
    expect(calls[2]?.req.prompt).toContain("qa: my view");

    // The opener resumes with the transcript; its result closes the room.
    expect(calls[5]?.req.prompt).toContain("writer: my view");
    const [room] = listRooms(db);
    expect(room?.closedAt).not.toBeNull();
    expect(listMessages(db, room?.id as string).at(-1)?.content).toBe("Decision: short headline.");

    // Hidden: not a chat thread, nothing posted into the owner's thread from the room.
    expect(listThreads(db).map((t) => t.id)).toEqual([thread.id]);
    expect(
      listMessages(db, thread.id)
        .map((m) => m.content)
        .join("\n"),
    ).not.toContain("my view");
    expect(getTask(db, root.taskId)?.status).toBe("done");
  });

  it("refuses participants the opener may not delegate to, itself, and rooms from inside a turn", async () => {
    const thread = createThread(db, {});
    const root = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: "dev", title: "x", instructions: "go" },
    );
    if (!root.ok) throw new Error(root.reason);
    const from = { from: "task" as const, taskId: root.taskId };
    expect(orch.openRoom(from, { ...opening, participants: ["stranger"] })).toMatchObject({
      ok: false,
    });
    expect(orch.openRoom(from, { ...opening, participants: ["dev"] })).toMatchObject({ ok: false });
    expect(orch.openRoom(from, { ...opening, rounds: 4 })).toMatchObject({ ok: false });
    expect(orch.openRoom(from, { ...opening, participants: ["qa", "writer", "qa"] })).toMatchObject(
      { ok: false },
    );

    let nested: unknown;
    behave = (_req, task) => {
      if (task.roomId)
        nested = orch.openRoom(
          { from: "task", taskId: task.id },
          { ...opening, participants: ["writer"] },
        );
      return result();
    };
    expect(orch.openRoom(from, { ...opening, participants: ["qa"], rounds: 1 })).toMatchObject({
      ok: true,
    });
    await drain();
    expect(nested).toEqual({ ok: false, reason: expect.stringMatching(/discussion/) });
  });

  it("agents that may delegate get the open_room tool", async () => {
    const thread = createThread(db, {});
    orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: "dev", title: "x", instructions: "go" },
    );
    await drain();
    expect(calls[0]?.req.allowedTools).toContain("mcp__achords__open_room");
  });

  describe("outcomes on the card (ADR-0066 part 4)", () => {
    const start = (agent = "dev") => {
      const thread = createThread(db, {});
      const root = orch.delegate(
        { from: "boss", threadId: thread.id },
        { agent, title: "Landing", instructions: "go" },
      );
      if (!root.ok) throw new Error(root.reason);
      return { thread, rootId: root.taskId };
    };
    /** dev opens a one-round room with qa, then `decide` runs in its resumed run. */
    const discuss = (decide: (taskId: string, roomId: string) => RunResult) => {
      behave = (_req, task) => {
        if (task.roomId) return result({ text: "qa: short" });
        if (task.assigneeAgentId !== "dev") return result({ text: "lead done" });
        const [room] = listRooms(db);
        if (!room)
          orch.openRoom(
            { from: "task", taskId: task.id },
            { ...opening, participants: ["qa"], rounds: 1 },
          );
        return room ? decide(task.id, room.id) : result({ text: "waiting" });
      };
    };
    const hubTools = (i: number) => calls[i]?.req.allowedTools ?? [];
    const chatText = (threadId: string) =>
      listMessages(db, threadId)
        .map((m) => m.content)
        .join("\n");

    it("with the tool, the outcome is stored and commented on the card; nothing in the chat", async () => {
      const { thread, rootId } = start();
      let recorded: unknown;
      discuss((taskId, roomId) => {
        recorded = orch.recordRoomOutcome(
          { from: "task", taskId },
          {
            room: roomId,
            decision: "Short headline.",
            decidedBy: "dev and qa",
            openPoints: ["subline"],
          },
        );
        return result({ text: "Landing done." });
      });
      await drain();
      expect(recorded).toEqual({ ok: true });
      // Only the opener's run after the room gets the tool.
      expect(calls.map((c) => c.task.assigneeAgentId)).toEqual(["dev", "qa", "dev"]);
      expect(hubTools(0)).not.toContain("mcp__achords__record_room_outcome");
      expect(hubTools(2)).toContain("mcp__achords__record_room_outcome");
      expect(calls[2]?.req.prompt).toContain("record_room_outcome (room ");
      const [room] = listRooms(db);
      expect(room?.outcome).toEqual({
        decision: "Short headline.",
        decidedBy: "dev and qa",
        openPoints: ["subline"],
      });
      expect(listComments(db, rootId)).toEqual([
        expect.objectContaining({
          author: "dev",
          roomId: room?.id,
          text: expect.stringContaining("Decision: Short headline.\nDecided by: dev and qa"),
        }),
      ]);
      // Nothing is posted to the chat (or Telegram, which relays the chat).
      expect(chatText(thread.id)).not.toMatch(/Room outcome|Short headline/);
    });

    it("refuses outcomes for rooms the caller did not open, or that are still going on", () => {
      const { rootId } = start();
      const other = start();
      const opened = orch.openRoom({ from: "task", taskId: rootId }, opening);
      if (!opened.ok) throw new Error(opened.reason);
      const ask = (taskId: string) =>
        orch.recordRoomOutcome(
          { from: "task", taskId },
          { room: opened.roomId, decision: "x", decidedBy: "dev", openPoints: [] },
        );
      expect(ask(other.rootId)).toMatchObject({ ok: false, reason: /not one you opened/ });
      expect(ask(rootId)).toMatchObject({ ok: false, reason: /still going on/ });
      expect(getRoom(db, opened.roomId)?.closedAt).toBeNull();
    });

    it("without the tool, the opener's result is the decision", async () => {
      const { thread, rootId } = start();
      discuss(() => result({ text: "We go with the short headline." }));
      await drain();
      expect(listRooms(db)[0]?.outcome).toEqual({
        decision: "We go with the short headline.",
        decidedBy: "dev",
        openPoints: ["not stated"],
      });
      expect(listComments(db, rootId)[0]?.text).toContain("Open points:\n- not stated");
      expect(chatText(thread.id)).not.toContain("Room outcome");
    });

    it("a failed room records no decision", async () => {
      const { rootId } = start();
      discuss(() => result({ text: "Decided without them." }));
      const inner = behave;
      behave = (req, task) =>
        task.roomId ? result({ ok: false, stopReason: "error", error: "boom" }) : inner(req, task);
      await drain();
      expect(listRooms(db)[0]?.outcome?.decision).toBe("no decision: room failed");
      expect(listComments(db, rootId)).toHaveLength(1);
      // The opener resumes but the room is closed already: no tool, no second outcome.
      expect(hubTools(calls.length - 1)).not.toContain("mcp__achords__record_room_outcome");
    });

    it("a later successor of the card sees the outcome", async () => {
      const { thread } = start();
      discuss(() => result({ text: "Short headline." }));
      await drain();
      behave = () => result({ text: "follow-up done" });
      const next = orch.delegate(
        { from: "boss", threadId: thread.id },
        { agent: "writer", title: "Follow-up", instructions: "polish" },
      );
      if (!next.ok) throw new Error(next.reason);
      await drain();
      const last = calls.at(-1);
      expect(last?.task.id).toBe(next.taskId);
      expect(last?.req.prompt).toContain(
        "Room outcomes on this card (newest first):\nRoom outcome: Hero copy\nDecision: Short headline.",
      );
      expect(last?.req.prompt).not.toContain("Owner's comments");
    });

    it("a child opener's outcome lands on the root's card and reaches the root's resumed session", async () => {
      let n = 0;
      orch = build({ claudeToken: () => ({ CLAUDE_CODE_OAUTH_TOKEN: "tok" }) });
      const { thread, rootId } = start("lead");
      const inner = (_req: RunRequest, task: Task) => {
        if (task.assigneeAgentId === "lead" && !task.parentId && !listRooms(db).length) {
          orch.delegate(
            { from: "task", taskId: task.id },
            { agent: "dev", title: "Hero", instructions: "x" },
          );
          return result({ text: "waiting" });
        }
        return result({ text: "Short headline." });
      };
      discuss(() => result({ text: "Short headline." }));
      const dev = behave;
      behave = (req, task) => {
        n++;
        const r = task.assigneeAgentId === "dev" || task.roomId ? dev(req, task) : inner(req, task);
        return { ...r, sessionId: req.session?.resume ?? `s-${n}` };
      };
      await drain();
      expect(calls.map((c) => c.task.assigneeAgentId)).toEqual([
        "lead",
        "dev",
        "qa",
        "dev",
        "lead",
      ]);
      const child = calls[1]?.task.id as string;
      expect(listComments(db, child)).toEqual([]);
      expect(listComments(db, rootId)).toEqual([expect.objectContaining({ author: "dev" })]);
      const wake = calls.at(-1)?.req;
      expect(wake?.session).toEqual({ resume: "s-1" });
      expect(wake?.prompt).toContain("New room outcomes on this card (newest first):");
      expect(chatText(thread.id)).not.toContain("Room outcome");
    });

    it("a card run sees at most 5 outcomes, newest first", async () => {
      const { thread, rootId } = start();
      behave = () => result();
      await drain();
      for (let i = 1; i <= 6; i++) {
        db.prepare(
          "INSERT INTO task_comments (task_id, text, author, room_id, created_at) VALUES (?, ?, 'dev', ?, ?)",
        ).run(rootId, `Room outcome: topic ${i}`, `r${i}`, i);
      }
      const next = orch.delegate(
        { from: "boss", threadId: thread.id },
        { agent: "writer", title: "Follow-up", instructions: "polish" },
      );
      if (!next.ok) throw new Error(next.reason);
      await drain();
      const prompt = calls.at(-1)?.req.prompt ?? "";
      expect(prompt.match(/Room outcome: topic \d/g)).toEqual([
        "Room outcome: topic 6",
        "Room outcome: topic 5",
        "Room outcome: topic 4",
        "Room outcome: topic 3",
        "Room outcome: topic 2",
      ]);
    });
  });
});
