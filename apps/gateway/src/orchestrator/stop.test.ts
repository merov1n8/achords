import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createThread,
  getTask,
  listMessages,
  openCoreDatabase,
  stopThread,
  type Task,
} from "@achords/core";
import type { ModelProvider, RunResult } from "@achords/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunTokens } from "../mcp/tokens.ts";
import { createOrchestrator, type Orchestrator } from "./orchestrator.ts";

const killed: RunResult = {
  ok: false,
  stopReason: "error",
  text: "",
  error: "claude exited with exit code null and no result",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  windows: [],
  durationMs: 1,
};

describe("Stop from the chat page", () => {
  let home: string;
  let db: ReturnType<typeof openCoreDatabase>;
  let orch: Orchestrator;
  let calls: number;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-stop-"));
    for (const id of ["boss", "dev"]) {
      mkdirSync(join(home, "agents", id), { recursive: true });
      writeFileSync(
        join(home, "agents", id, "agent.yaml"),
        `id: ${id}\nname: ${id}\nrole: ${id}\nworkspace: shared\nmodels:\n  default: cli-claude/sonnet\n`,
      );
    }
    db = openCoreDatabase(join(home, "core.db"));
    calls = 0;
    const p: ModelProvider = {
      id: "cli-claude",
      async run() {
        calls++;
        // The owner presses Stop while the agent works; its process group dies.
        const row = db.prepare("SELECT thread_id FROM tasks WHERE status = 'claimed'").get();
        stopThread(db, String(row?.thread_id));
        return killed;
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

  it("a stopped task stays cancelled: no retry, no failure message in the chat", async () => {
    const thread = createThread(db, {});
    const r = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: "dev", title: "Build", instructions: "go" },
    );
    if (!r.ok) throw new Error(r.reason);
    for (let i = 0; i < 5 && (await orch.workOnce()); i++);
    expect(calls).toBe(1);
    expect((getTask(db, r.taskId) as Task).status).toBe("cancelled");
    expect(listMessages(db, thread.id).some((m) => /failed/i.test(m.content))).toBe(false);
  });
});
