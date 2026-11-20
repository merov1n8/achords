import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThread, listUsageWindows, openCoreDatabase, spendSince } from "@achords/core";
import type { ModelProvider, RunResult, UsageWindow } from "@achords/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOrchestrator, type Orchestrator } from "./orchestrator.ts";

const HOUR = 3600_000;

describe("usage meters and limit warnings (step 6)", () => {
  let home: string;
  let db: ReturnType<typeof openCoreDatabase>;
  let orch: Orchestrator;
  let windows: UsageWindow[];
  let notes: string[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-usage-"));
    for (const id of ["boss", "dev"]) {
      mkdirSync(join(home, "agents", id), { recursive: true });
      writeFileSync(
        join(home, "agents", id, "agent.yaml"),
        `id: ${id}\nname: ${id}\nrole: ${id}\nworkspace: shared\nmodels:\n  default: cli-claude/sonnet\n`,
      );
    }
    db = openCoreDatabase(join(home, "core.db"));
    notes = [];
    windows = [];
    const p: ModelProvider = {
      id: "cli-claude",
      run: async (): Promise<RunResult> => ({
        ok: true,
        stopReason: "completed",
        text: "done",
        structured: { action: "answer", message: "ok" },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.2,
        },
        windows,
        durationMs: 1,
      }),
    };
    orch = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": p },
      notify: (text) => notes.push(text),
    });
    orch.syncAgents();
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const runTask = async () => {
    const thread = createThread(db, {});
    orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: "dev", title: "x", instructions: "go" },
    );
    for (let i = 0; i < 5 && (await orch.workOnce()); i++);
  };
  const five = (utilization: number, resetsAt = Date.now() + 2 * HOUR) => ({
    kind: "five_hour",
    utilization,
    resetsAt,
    status: "allowed",
  });

  it("stores the windows and cost every run reports, the boss's too", async () => {
    windows = [
      five(0.3),
      { kind: "seven_day", utilization: 0.1, resetsAt: Date.now() + 90 * HOUR, status: "allowed" },
    ];
    await runTask();
    await orch.handleMessage(createThread(db, {}).id, "hi", "web");
    expect(listUsageWindows(db).map((w) => [w.kind, w.utilization])).toEqual([
      ["five_hour", 0.3],
      ["seven_day", 0.1],
    ]);
    expect(spendSince(db, 0)).toBeCloseTo(0.4);
    expect(notes).toEqual([]);
  });

  it("warns once at 80% and once at 95% per window, again after it resets", async () => {
    const resets = Date.now() + 2 * HOUR;
    windows = [five(0.82, resets)];
    await runTask();
    await runTask();
    windows = [five(0.96, resets)];
    await runTask();
    windows = [five(0.85, resets + 5 * HOUR)]; // a new window
    await runTask();
    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatch(/5-hour window.*82%/);
    expect(notes[1]).toMatch(/96%/);
    expect(notes[2]).toMatch(/85%/);
  });
});
