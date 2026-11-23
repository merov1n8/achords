import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThread, enqueue, getTask, listMessages, openCoreDatabase } from "@achords/core";
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

describe("model fallback on a usage limit (ADR-0058)", () => {
  let home: string;
  let db: ReturnType<typeof openCoreDatabase>;
  let calls: RunRequest[];
  let limited: string[];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-fallback-"));
    seedAgents(SEED_DIR, join(home, "agents"), home);
    mkdirSync(join(home, "agents", "reviewer"));
    writeFileSync(
      join(home, "agents", "reviewer", "agent.yaml"),
      "id: reviewer\nname: Reviewer\nrole: reviewer\nworkspace: shared\nmodels:\n  default: cli-codex/astra\n  allowed: [cli-codex/astra, cli-codex/sol]\n",
    );
    db = openCoreDatabase(join(home, "core.db"));
    calls = [];
    limited = ["astra"];
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const make = () => {
    const p: ModelProvider = {
      id: "cli-codex",
      async run(req) {
        calls.push(req);
        return limited.includes(req.model)
          ? result({ ok: false, stopReason: "unavailable", error: "You've hit your usage limit." })
          : result({ text: `done on ${req.model}` });
      },
    };
    const orch = createOrchestrator({ db, home, providers: { "cli-codex": p } });
    orch.syncAgents();
    return orch;
  };

  it("continues on the next allowed model and says so in the chat", async () => {
    const orch = make();
    const thread = createThread(db, {});
    const task = enqueue(db, { title: "Review", threadId: thread.id, assigneeAgentId: "reviewer" });
    for (let i = 0; i < 3 && (await orch.workOnce()); i++);
    expect(calls.map((c) => c.model)).toEqual(["astra", "sol"]);
    expect(getTask(db, task.id)).toMatchObject({ status: "done", result: "done on sol" });
    expect(
      listMessages(db, thread.id)
        .map((m) => m.content)
        .join("\n"),
    ).toMatch(/cli-codex\/astra reached its usage limit; continuing on cli-codex\/sol/);
    // The limit is remembered: the next task starts on sol right away.
    const next = enqueue(db, { title: "Again", assigneeAgentId: "reviewer" });
    await orch.workOnce();
    expect(calls.at(-1)?.model).toBe("sol");
    expect(getTask(db, next.id)?.status).toBe("done");
  });

  it("with every allowed model at its limit the task waits, as before", async () => {
    limited = ["astra", "sol"];
    const orch = make();
    const task = enqueue(db, { title: "Review", assigneeAgentId: "reviewer" });
    for (let i = 0; i < 3 && (await orch.workOnce()); i++);
    expect(calls.map((c) => c.model)).toEqual(["astra", "sol"]);
    expect(getTask(db, task.id)).toMatchObject({ status: "queued" });
    expect(getTask(db, task.id)?.error).toMatch(/usage limit/);
  });
});
