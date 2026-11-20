import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createThread,
  getTask,
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
        "tools: [Read, Edit, Bash]\nshell:\n  allow: [ls]\ndelegation:\n  can_delegate_to: [qa, writer]",
      ],
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
  });
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
});
