import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homePaths, openCoreDatabase, readLivePid, setSetting } from "@achords/core";

export const HEARTBEAT_KEY = "gateway.heartbeat";
const TICK_MS = 1000;

const log = (msg: string) => console.log(`${new Date().toISOString()} gateway: ${msg}`);

/**
 * Runs until SIGTERM/SIGINT or until the STOP marker appears. Every "won't run" path exits 0:
 * the launchd job uses KeepAlive.SuccessfulExit=false, so only crashes are respawned.
 */
export function runGateway(home: string): Promise<number> {
  const paths = homePaths(home);
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });

  if (existsSync(paths.stopFile)) {
    log("emergency stop is active; run `achords resume` to clear it");
    return Promise.resolve(0);
  }
  const other = readLivePid(paths.pidFile);
  if (other !== undefined && other !== process.pid) {
    log(`already running (pid ${other})`);
    return Promise.resolve(0);
  }
  const db = openCoreDatabase(paths.db);

  return new Promise((resolve) => {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const shutdown = (reason: string) => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      db.close();
      // Only remove our own pidfile; a successor may already have written its own.
      if (readLivePid(paths.pidFile) === process.pid) rmSync(paths.pidFile, { force: true });
      log(`stopped (${reason})`);
      resolve(0);
    };
    const tick = () => {
      if (existsSync(paths.stopFile)) return shutdown("stop marker");
      setSetting(db, HEARTBEAT_KEY, String(Date.now()));
    };
    const onTerm = () => shutdown("SIGTERM");
    const onInt = () => shutdown("SIGINT");
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    // Pidfile last: once it is visible, `achords stop` may SIGTERM us, so handlers must be ready.
    writeFileSync(paths.pidFile, String(process.pid), { mode: 0o600 });
    log(`started (pid ${process.pid}, home ${home})`);
    timer = setInterval(tick, TICK_MS);
    tick();
  });
}
