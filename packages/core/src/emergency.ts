import { mkdirSync, writeFileSync } from "node:fs";
import type { Db } from "./db/database.ts";
import type { HomePaths } from "./home.ts";
import { processAgeMs, startedAfter } from "./proc.ts";
import { setPaused } from "./queue.ts";
import { finishRun, listActiveRuns } from "./runs.ts";

/** Blocks the gateway from (re)starting until `achords resume` removes it. */
export function writeStopMarker(paths: HomePaths): void {
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.stopFile, `${new Date().toISOString()}\n`);
}

/** Pauses the queue and SIGKILLs every active run's process group. Returns one line per run. */
export function killActiveRuns(db: Db): string[] {
  setPaused(db, true);
  const lines = ["queue paused"];
  for (const run of listActiveRuns(db)) {
    lines.push(killRun(run.pid, run.pgid, run.startedAt));
    finishRun(db, run.id, "cancelled", { error: "emergency stop" });
  }
  return lines;
}

function killRun(pid: number | null, pgid: number | null, startedAt: number): string {
  const probe = pgid ?? pid;
  if (probe === null) return "run without pid: marked cancelled";
  const age = processAgeMs(probe);
  if (age === undefined) return `run ${probe}: already gone`;
  // Never SIGKILL a process that started after the run was recorded: its PID was reused.
  if (startedAfter(age, startedAt)) return `run ${probe}: PID reused by another process, skipped`;
  try {
    // Negative PID = whole process group, so agent subprocesses die too.
    process.kill(pgid !== null ? -pgid : probe, "SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
  return `run ${probe}: killed`;
}
