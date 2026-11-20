import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSchedule,
  getSchedule,
  getThread,
  listMessages,
  listSchedules,
  openCoreDatabase,
} from "@achords/core";
import type { ModelProvider, RunResult } from "@achords/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOrchestrator, type Orchestrator } from "./orchestrator.ts";
import { seedSchedules } from "./seed.ts";

describe("scheduler (step 7)", () => {
  let home: string;
  let db: ReturnType<typeof openCoreDatabase>;
  let orch: Orchestrator;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-sched-"));
    for (const id of ["boss", "dev"]) {
      mkdirSync(join(home, "agents", id), { recursive: true });
      writeFileSync(
        join(home, "agents", id, "agent.yaml"),
        `id: ${id}\nname: ${id}\nrole: ${id}\nworkspace: shared\nmodels:\n  default: cli-claude/sonnet\n`,
      );
    }
    db = openCoreDatabase(join(home, "core.db"));
    const p: ModelProvider = {
      id: "cli-claude",
      run: async (): Promise<RunResult> => ({
        ok: true,
        stopReason: "completed",
        text: "All good this week.",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        },
        windows: [],
        durationMs: 1,
      }),
    };
    orch = createOrchestrator({ db, home, providers: { "cli-claude": p } });
    orch.syncAgents();
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const schedule = (over = {}) =>
    createSchedule(
      db,
      {
        name: "Weekly check",
        cron: "0 9 * * *",
        agentId: "dev",
        title: "Check",
        instructions: "Look around.",
        ...over,
      },
      0,
    );
  const drain = async () => {
    for (let i = 0; i < 10 && (await orch.workOnce()); i++);
  };

  it("a due schedule becomes a task; the result is reported in its own thread", async () => {
    const s = schedule();
    expect(orch.runDueSchedules(Date.now())).toBe(1);
    const after = getSchedule(db, s.id);
    expect(after?.nextRunAt).toBeGreaterThan(Date.now());
    const thread = getThread(db, after?.threadId as string);
    expect(thread?.title).toBe("Scheduled: Weekly check");
    await drain();
    expect(listMessages(db, thread?.id as string).at(-1)?.content).toMatch(/All good this week/);
    expect(listSchedules(db)[0]?.lastStatus).toBe("done");
    // Next time the same thread is reused.
    db.prepare("UPDATE schedules SET next_run_at = 0").run();
    orch.runDueSchedules(Date.now());
    expect(getSchedule(db, s.id)?.threadId).toBe(thread?.id);
  });

  it("does not start again while the previous run is still going; it just moves on", () => {
    const s = schedule();
    orch.runDueSchedules(Date.now());
    const first = getSchedule(db, s.id)?.lastTaskId;
    db.prepare("UPDATE schedules SET next_run_at = 0").run();
    expect(orch.runDueSchedules(Date.now())).toBe(0);
    expect(getSchedule(db, s.id)?.lastTaskId).toBe(first);
    expect(getSchedule(db, s.id)?.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("a schedule for an agent that cannot take it says why in its thread and moves on", () => {
    const s = schedule({ agentId: "ghost" });
    expect(orch.runDueSchedules(Date.now())).toBe(0);
    const after = getSchedule(db, s.id);
    expect(listMessages(db, after?.threadId as string).at(-1)?.content).toMatch(/ghost/);
    expect(after?.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("seeds shipped schedules once (disabled by default) and never overwrites edits", () => {
    const dir = join(home, "seed-schedules");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "weekly.yaml"),
      "id: weekly\nname: Weekly check\ncron: 0 9 * * 1\nagent: dev\ntitle: Check\ninstructions: Look around.\n",
    );
    expect(seedSchedules(dir, db)).toEqual(["weekly"]);
    expect(listSchedules(db)[0]).toMatchObject({ seedId: "weekly", enabled: false });
    db.prepare("UPDATE schedules SET name = 'Mine'").run();
    expect(seedSchedules(dir, db)).toEqual([]);
    expect(listSchedules(db)[0]?.name).toBe("Mine");
  });
});
