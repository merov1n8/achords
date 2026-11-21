import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  getSetting,
  type HomePaths,
  isAlive,
  isPaused,
  killActiveRuns,
  listActiveRuns,
  liveProgress,
  openCoreDatabase,
  readLivePid,
  setDraining,
  setPaused,
  writeStopMarker,
} from "@achords/core";
import { t } from "@achords/i18n";
import type { ServiceManager } from "./launchd.ts";

// Duplicated from @achords/gateway to keep the CLI free of a gateway dependency.
const HEARTBEAT_KEY = "gateway.heartbeat";

export interface ControlContext {
  paths: HomePaths;
  service: ServiceManager;
  /** Kills this install's agent-run containers (ADR-0051); returns their names. */
  killContainers?: () => string[];
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
    throw new Error(t("cli.start.emergency"));
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
  return t("cli.start.done", { kind: service.kind });
}

/** Graceful: unloads the service (SIGTERM to the gateway). The queue keeps its state. */
export interface StopOptions {
  /** Do not wait for running work (it is interrupted and continues after the next start). */
  now?: boolean;
  /** How long to wait for running work before interrupting it. */
  waitMs?: number;
  pollMs?: number;
  print?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Planned stop: the gateway starts nothing new, running work may finish (up to `waitMs`), then
 * the gateway stops. Work still running at that point is interrupted and goes back to the queue
 * with a note; it continues after the next `achords start` without losing an attempt.
 */
export async function stop(ctx: ControlContext, opts: StopOptions = {}): Promise<string> {
  const { paths, service } = ctx;
  const print = opts.print ?? (() => {});
  const pid = readLivePid(paths.pidFile);
  if (pid !== undefined && !opts.now) {
    const waitMs = opts.waitMs ?? DEFAULT_STOP_WAIT_MS;
    const until = Date.now() + waitMs;
    let lastPrint = 0;
    withDb(paths, (db) => setDraining(db, true));
    for (;;) {
      const live = withDb(paths, (db) => liveProgress(db));
      if (live.length === 0) break;
      if (Date.now() >= until) {
        print(t("cli.stop.waitOver", { n: live.length }));
        break;
      }
      if (Date.now() - lastPrint >= STOP_PRINT_EVERY_MS) {
        lastPrint = Date.now();
        print(
          t("cli.stop.waiting", {
            n: live.length,
            minutes: Math.ceil((until - Date.now()) / 60_000),
          }),
        );
        for (const r of live) {
          const steps = r.total ? ` · ${r.done ?? 0}/${r.total}` : "";
          print(`  ${r.agentId ?? "?"} · ${r.title ?? "-"}${steps}`);
        }
      }
      await sleep(opts.pollMs ?? 1000);
    }
  }
  const unloaded = service.stop();
  // Foreground (dev) gateway without a service: same graceful signal.
  if (pid !== undefined) {
    process.kill(pid, "SIGTERM");
    const until = Date.now() + 15_000;
    while (isAlive(pid) && Date.now() < until) await sleep(100);
    const resumed = withDb(paths, (db) => countResumable(db));
    if (resumed > 0) print(t("cli.stop.willContinue", { n: resumed }));
  }
  return unloaded || pid !== undefined ? t("cli.stop.done") : t("cli.stop.notRunning");
}

const DEFAULT_STOP_WAIT_MS = 10 * 60_000;
const STOP_PRINT_EVERY_MS = 15_000;
const countResumable = (db: ReturnType<typeof openCoreDatabase>) =>
  Number(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE status = 'queued' AND resume_note IS NOT NULL",
      )
      .get()?.n ?? 0,
  );

export interface KillReport {
  steps: string[];
  errors: string[];
}

/**
 * Emergency stop. Every step runs even if an earlier one fails, and nothing depends on a
 * responsive gateway: the marker blocks restarts, the service is unloaded, then processes die.
 */
export function kill({ paths, service, killContainers }: ControlContext): KillReport {
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
    writeStopMarker(paths);
    return t("cli.kill.marker");
  });
  step("service", () =>
    service.stop() ? t("cli.kill.serviceUnloaded") : t("cli.kill.serviceNotLoaded"),
  );
  step("gateway", () => {
    const pid = readLivePid(paths.pidFile);
    if (pid === undefined) return t("cli.kill.noGateway");
    process.kill(pid, "SIGKILL");
    return t("cli.kill.gatewayKilled", { pid });
  });
  step("runs", () =>
    withDb(paths, (db) => {
      report.steps.push(...killActiveRuns(db));
      return undefined;
    }),
  );
  // Killing a run's `container run` client leaves its VM running: stop those by name.
  if (killContainers) {
    step("containers", () => {
      const names = killContainers();
      return names.length ? t("cli.kill.containers", { names: names.join(", ") }) : undefined;
    });
  }
  return report;
}

export function resume({ paths }: ControlContext): string {
  rmSync(paths.stopFile, { force: true });
  withDb(paths, (db) => setPaused(db, false));
  return t("cli.resume.done");
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
