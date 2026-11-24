// ADR-0069: notes to running work, with a fake CLI whose run the test holds open.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createThread,
  getTask,
  listComments,
  listMessages,
  openCoreDatabase,
  threadCard,
} from "@achords/core";
import type { RunRequest, RunResult } from "@achords/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inboxDir, takeNotes } from "../inbox.ts";
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

describe("notes to running work (ADR-0069)", () => {
  let home: string;
  let db: ReturnType<typeof openCoreDatabase>;
  let orch: Orchestrator;
  let agentReqs: RunRequest[];
  let release: () => void;
  let decision: { action: string; message: string };

  const agent = (id: string, model = "cli-claude/sonnet") => {
    mkdirSync(join(home, "agents", id), { recursive: true });
    writeFileSync(
      join(home, "agents", id, "agent.yaml"),
      `id: ${id}\nname: ${id}\nrole: ${id}\nworkspace: shared\nmodels:\n  default: ${model}\n`,
    );
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-notes-"));
    db = openCoreDatabase(join(home, "core.db"));
    agentReqs = [];
    release = () => {};
    decision = { action: "note_running", message: "Passing it on." };
    agent("boss");
    agent("coder");
    agent("gem", "cli-gemini/gemini-pro");
    const run = async (req: RunRequest) => {
      if (req.jsonSchema) return result({ structured: decision });
      agentReqs.push(req);
      // Held open until the test releases it, as a long run would be.
      await new Promise<void>((done) => {
        release = done;
      });
      return result();
    };
    orch = createOrchestrator({
      db,
      home,
      providers: {
        "cli-claude": { id: "cli-claude", run },
        "cli-gemini": { id: "cli-gemini", run },
      },
      hub: { url: "http://127.0.0.1:7420", tokens: createRunTokens(), serverEntry: "/x.ts" },
    });
    orch.syncAgents();
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  /** A card for `who`, its run started and held open. */
  const running = async (who = "coder") => {
    const thread = createThread(db, {});
    const r = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: who, title: "Fix the deploy", instructions: "fix it" },
    );
    if (!r.ok) throw new Error(r.reason);
    const work = orch.workOnce();
    for (let i = 0; i < 50 && agentReqs.length === 0; i++) await new Promise((d) => setTimeout(d));
    return { threadId: thread.id, taskId: r.taskId, work };
  };
  const texts = (threadId: string) => listMessages(db, threadId).map((m) => m.content);

  it("hands a chat note to the running agent through its hook, and says it arrived", async () => {
    const { threadId, taskId, work } = await running();
    const req = agentReqs[0] as RunRequest;
    const dir = inboxDir(home, taskId);
    expect(req.inboxHook?.post).toContain(dir);
    expect(req.inboxHook?.stop).toMatch(/ stop$/);

    expect(await orch.handleMessage(threadId, "Deploy from main, not closed-beta.", "web")).toBe(
      "note_running",
    );
    expect(texts(threadId).at(-1)).toMatch(/^📝 Note for coder .*: Deploy from main/);
    // What the hook would hand to the model.
    expect(takeNotes(dir)).toEqual([
      "Message from the owner while you work (sent through Achords): Deploy from main, not closed-beta.",
    ]);
    req.onActivity?.();
    expect(texts(threadId).at(-1)).toBe("✓ coder got your note.");
    release();
    await work;
    expect(texts(threadId).join("\n")).not.toMatch(/finished before it got your note/);
    expect(existsSync(dir)).toBe(false);
    expect(listComments(db, taskId)).toMatchObject([
      { kind: "note", deliveredAt: expect.any(Number) },
    ]);
  });

  it("a note the run never took is put to the owner: continue with it", async () => {
    const { threadId, taskId, work } = await running();
    await orch.handleMessage(threadId, "Also skip the PlayMode tests.", "web");
    release();
    await work;
    const ask = listMessages(db, threadId).at(-1);
    expect(ask?.content).toMatch(/coder finished before it got your note:\n- Also skip/);
    expect(ask?.actions?.map((a) => a.data)).toEqual([
      `note:continue:${taskId}`,
      `note:drop:${taskId}`,
    ]);
    expect(orch.runAction(`note:continue:${taskId}`)).toMatchObject({ ok: true });
    const next = getTask(db, threadCard(db, threadId) as string);
    expect(next?.id).not.toBe(taskId);
    expect(next).toMatchObject({ status: "queued", assigneeAgentId: "coder" });
    expect(next?.description).toMatch(/run ended before it arrived[\s\S]*- Also skip the PlayMode/);
    // Decided once: the buttons are gone and a second press finds nothing.
    expect(
      listMessages(db, threadId).find((m) => m.id === ask?.id)?.actions ?? undefined,
    ).toBeUndefined();
    expect(orch.runAction(`note:continue:${taskId}`)).toMatchObject({ ok: false });
  });

  it("…or drop it: it stays on the card, out of later prompts", async () => {
    const { threadId, taskId, work } = await running();
    await orch.handleMessage(threadId, "Never mind the logs.", "web");
    release();
    await work;
    expect(orch.runAction(`note:drop:${taskId}`)).toMatchObject({ ok: true });
    expect(threadCard(db, threadId)).toBe(taskId);
    expect(listComments(db, taskId)).toMatchObject([{ kind: "dropped" }]);
  });

  it("without running work the boss's note has nowhere to go, and says so", async () => {
    const thread = createThread(db, {});
    expect(await orch.handleMessage(thread.id, "use main", "web")).toBe("note_running");
    expect(texts(thread.id).at(-1)).toMatch(/Nothing is running in this chat/);
    expect(orch.noteRunning("missing", "x")).toBeUndefined();
  });

  it("a board comment on a running card is a note; a CLI without hooks gets it at the end", async () => {
    const { threadId, taskId, work } = await running("gem");
    expect(agentReqs[0]?.inboxHook).toBeUndefined();
    const note = orch.noteRunning(taskId, "Check the iOS build too.");
    expect(note).toMatchObject({ kind: "note", forTask: taskId });
    expect(texts(threadId).at(-1)).toMatch(/This run cannot take notes while it works/);
    release();
    await work;
    expect(texts(threadId).at(-1)).toMatch(/gem finished before it got your note/);
  });
});
