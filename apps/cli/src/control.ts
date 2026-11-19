import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  finishRun,
  getSetting,
  type HomePaths,
  isPaused,
  listActiveRuns,
  openCoreDatabase,
  processAgeMs,
  readLivePid,
  setPaused,
  startedAfter,
} from "@achords/core";
import type { ServiceManager } from "./launchd.ts";

// Duplicated from @achords/gateway to keep the CLI free of a gateway dependency.
const HEARTBEAT_KEY = "gateway.heartbeat";

export interface ControlContext {
  paths: HomePaths;
  service: ServiceManager;
}

function withDb<T>(paths: HomePaths, fn: (db: ReturnType<typeof openCoreDatabase>) => T): T {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const db = openCoreDatabase(paths.db);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function start({ paths, service }: ControlContext, waitMs = 5000): string {
  if (stopMarkerExists(paths)) {
    throw new Error("emergency stop is active; run `achords resume` first");
  }
  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  service.start();
  // The service manager only reports "loaded"; wait for the gateway's own pidfile.
  const until = Date.now() + waitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (readLivePid(paths.pidFile) === undefined) {
    if (Date.now() >= until) {
      service.stop();
      throw new Error(
        `gateway did not start within ${waitMs / 1000}s; see ${join(paths.logDir, "gateway.log")}`,
      );
    }
    Atomics.wait(pause, 0, 0, 100);
  }
  return `gateway started (${service.kind})`;
}

/** Graceful: unloads the service (SIGTERM to the gateway). The queue keeps its state. */
export function stop({ paths, service }: ControlContext): string {
  const unloaded = service.stop();
  // Foreground (dev) gateway without a service: same graceful signal.
  const pid = readLivePid(paths.pidFile);
  if (pid !== undefined) process.kill(pid, "SIGTERM");
  return unloaded || pid !== undefined ? "gateway stopped" : "gateway was not running";
}

export interface KillReport {
  steps: string[];
  errors: string[];
}

/**
 * Emergency stop. Every step runs even if an earlier one fails, and nothing depends on a
 * responsive gateway: the marker blocks restarts, the service is unloaded, then processes die.
 */
export function kill({ paths, service }: ControlContext): KillReport {
  const report: KillReport = { steps: [], errors: [] };
  const step = (name: string, fn: () => string | undefined) => {
    try {
      const msg = fn();
      if (msg) report.steps.push(msg);
    } catch (err) {
      report.errors.push(`${name}: ${(err as Error).message}`);
    }
  };

  step("stop marker", () => {
    mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.stopFile, `${new Date().toISOString()}\n`);
    return "STOP marker written";
  });
  step("service", () => (service.stop() ? "service unloaded" : "service was not loaded"));
  step("gateway", () => {
    const pid = readLivePid(paths.pidFile);
    if (pid === undefined) return "no live gateway process";
    process.kill(pid, "SIGKILL");
    return `gateway killed (pid ${pid})`;
  });
  step("runs", () =>
    withDb(paths, (db) => {
      setPaused(db, true);
      report.steps.push("queue paused");
      for (const run of listActiveRuns(db)) {
        report.steps.push(killRun(run.pid, run.pgid, run.startedAt));
        finishRun(db, run.id, "cancelled", { error: "emergency stop" });
      }
      return undefined;
    }),
  );
  return report;
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

export function resume({ paths }: ControlContext): string {
  rmSync(paths.stopFile, { force: true });
  withDb(paths, (db) => setPaused(db, false));
  return "emergency stop cleared, queue resumed; run `achords start` to start the gateway";
}

export interface Status {
  service: "loaded" | "not loaded";
  gatewayPid: number | null;
  heartbeatAgeMs: number | null;
  paused: boolean;
  emergencyStop: boolean;
  activeRuns: number;
}

export function status({ paths, service }: ControlContext, now = Date.now()): Status {
  return withDb(paths, (db) => {
    const beat = getSetting(db, HEARTBEAT_KEY);
    return {
      service: service.isLoaded() ? "loaded" : "not loaded",
      gatewayPid: readLivePid(paths.pidFile) ?? null,
      heartbeatAgeMs: beat === undefined ? null : now - Number(beat),
      paused: isPaused(db),
      emergencyStop: stopMarkerExists(paths),
      activeRuns: listActiveRuns(db).length,
    };
  });
}

function stopMarkerExists(paths: HomePaths): boolean {
  return existsSync(paths.stopFile);
}
