import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  homePaths,
  isAlive,
  isPaused,
  listActiveRuns,
  openCoreDatabase,
  processAgeMs,
  readLivePid,
  startRun,
} from "@achords/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kill, resume, start, status, stop } from "./control.ts";
import type { ServiceManager } from "./launchd.ts";

/** `pidFile`: if given, start() "launches" a gateway by writing this (live) process's PID. */
function fakeService(loaded = false, pidFile?: string) {
  const calls: string[] = [];
  const svc: ServiceManager = {
    kind: "fake",
    isLoaded: () => loaded,
    start: () => {
      calls.push("start");
      loaded = true;
      if (pidFile) writeFileSync(pidFile, String(process.pid));
    },
    stop: () => {
      calls.push("stop");
      const was = loaded;
      loaded = false;
      return was;
    },
  };
  return { svc, calls };
}

const exited = (c: ChildProcess) => new Promise((r) => c.once("exit", (_code, sig) => r(sig)));

function groupMembers(pgid: number): string {
  try {
    return execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" }).trim();
  } catch {
    return ""; // pgrep exits 1 when nothing matches
  }
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("control", () => {
  let home: string;
  const children: ChildProcess[] = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-ctl-"));
  });
  afterEach(() => {
    for (const c of children) c.kill("SIGKILL");
    children.length = 0;
    rmSync(home, { recursive: true, force: true });
  });

  it("kill: stops the service, kills run process groups, pauses the queue, leaves a STOP marker", async () => {
    const paths = homePaths(home);
    const { svc, calls } = fakeService(true);

    // A run whose process group has a grandchild, as an agent CLI with subprocesses would.
    const runner = spawn("sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
    children.push(runner);
    const pgid = runner.pid as number;
    // A stale run row whose PID now belongs to an older, unrelated process (this test process).
    const selfStart = Date.now() - (processAgeMs(process.pid) ?? 0);

    const db = openCoreDatabase(paths.db);
    startRun(db, { provider: "test", pid: pgid, pgid }, Date.now() - 1000);
    startRun(db, { provider: "test", pid: process.pid }, selfStart - 60_000);
    db.close();
    await waitFor(() => groupMembers(pgid).split("\n").length >= 2);

    const runnerExit = exited(runner);
    const report = kill({ paths, service: svc });

    expect(await runnerExit).toBe("SIGKILL");
    await waitFor(() => groupMembers(pgid) === "");
    expect(isAlive(process.pid)).toBe(true);
    expect(calls).toEqual(["stop"]);
    expect(existsSync(paths.stopFile)).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.steps.join("\n")).toMatch(/PID reused/);

    const after = openCoreDatabase(paths.db);
    expect(isPaused(after)).toBe(true);
    expect(listActiveRuns(after)).toEqual([]);
    after.close();
  });

  it("kill: takes down a foreground gateway via its pidfile", async () => {
    const paths = homePaths(home);
    const main = new URL("../../gateway/src/main.ts", import.meta.url).pathname;
    const gw = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", main], {
      env: { ...process.env, ACHORDS_HOME: home },
      stdio: "ignore",
    });
    children.push(gw);
    await waitFor(() => readLivePid(paths.pidFile) === gw.pid);

    const gwExit = exited(gw);
    kill({ paths, service: fakeService().svc });
    expect(await gwExit).toBe("SIGKILL");
  });

  it("start refuses during an emergency stop; resume clears it", () => {
    const paths = homePaths(home);
    const { svc, calls } = fakeService(false, paths.pidFile);
    kill({ paths, service: svc });
    expect(() => start({ paths, service: svc })).toThrow(/achords resume/);

    resume({ paths, service: svc });
    expect(existsSync(paths.stopFile)).toBe(false);
    const db = openCoreDatabase(paths.db);
    expect(isPaused(db)).toBe(false);
    db.close();

    expect(start({ paths, service: svc })).toMatch(/started/);
    expect(calls).toEqual(["stop", "start"]);
  });

  it("start reports a gateway that never comes up, with the log path", () => {
    const paths = homePaths(home);
    const { svc, calls } = fakeService();
    expect(() => start({ paths, service: svc }, 300)).toThrow(/did not start.*gateway\.log/);
    // Unloaded again, so launchd does not keep respawning a crashing gateway.
    expect(calls).toEqual(["start", "stop"]);
  });

  it("stop unloads the service without pausing the queue", () => {
    const paths = homePaths(home);
    const { svc } = fakeService(true);
    expect(stop({ paths, service: svc })).toMatch(/stopped/);
    expect(stop({ paths, service: svc })).toMatch(/not running/);
    const db = openCoreDatabase(paths.db);
    expect(isPaused(db)).toBe(false);
    db.close();
  });

  it("status summarises service, gateway, queue and runs", () => {
    const paths = homePaths(home);
    const { svc } = fakeService(true);
    expect(status({ paths, service: svc })).toEqual({
      service: "loaded",
      gatewayPid: null,
      heartbeatAgeMs: null,
      paused: false,
      emergencyStop: false,
      activeRuns: 0,
    });
    kill({ paths, service: svc });
    expect(status({ paths, service: svc })).toMatchObject({
      service: "not loaded",
      paused: true,
      emergencyStop: true,
    });
  });
});
