import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but owned by someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Parses `ps -o etime` output: [[dd-]hh:]mm:ss. */
export function parseEtime(raw: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(raw.trim());
  if (!m) return undefined;
  const [, d = "0", h = "0", min = "0", s = "0"] = m;
  return (((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s)) * 1000;
}

/**
 * How long the process has been running, or undefined if it does not exist. Used to detect PID
 * reuse: a process older than the record that points at it is not the one we started.
 */
export function processAgeMs(pid: number): number | undefined {
  try {
    const out = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseEtime(out);
  } catch {
    return undefined;
  }
}

// Clock skew / ps granularity (whole seconds) allowance for the PID reuse check.
const AGE_SLACK_MS = 2000;

/**
 * PID from a pidfile, if that process is alive and started before the pidfile was written.
 * A process that started later than the file holds a reused PID (e.g. after a reboot).
 */
export function readLivePid(pidFile: string, now = Date.now()): number | undefined {
  if (!existsSync(pidFile)) return undefined;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return undefined;
  const age = processAgeMs(pid);
  if (age !== undefined && startedAfter(age, statSync(pidFile).mtimeMs, now)) return undefined;
  return pid;
}

/** True if a process of the given age started after `timestamp` (beyond clock/ps slack). */
export function startedAfter(ageMs: number, timestamp: number, now = Date.now()): boolean {
  return now - ageMs > timestamp + AGE_SLACK_MS;
}
