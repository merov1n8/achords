import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isAlive, parseEtime, processAgeMs, readLivePid } from "./proc.ts";

describe("parseEtime", () => {
  it("parses ps etime formats", () => {
    expect(parseEtime("00:05")).toBe(5_000);
    expect(parseEtime(" 01:02:03\n")).toBe((3600 + 120 + 3) * 1000);
    expect(parseEtime("2-00:00:01")).toBe((2 * 86400 + 1) * 1000);
    expect(parseEtime("garbage")).toBeUndefined();
  });
});

describe("process probes", () => {
  it("reports liveness and age of a real process", async () => {
    const child = spawn("sleep", ["30"]);
    const pid = child.pid as number;
    expect(isAlive(pid)).toBe(true);
    expect(processAgeMs(pid)).toBeLessThan(5_000);
    expect(processAgeMs(process.pid)).toBeGreaterThanOrEqual(0);
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
    expect(isAlive(pid)).toBe(false);
    expect(processAgeMs(pid)).toBeUndefined();
  });
});

describe("readLivePid", () => {
  it("accepts a live process younger than the pidfile, rejects stale or reused PIDs", () => {
    const dir = mkdtempSync(join(tmpdir(), "achords-pid-"));
    const file = join(dir, "x.pid");
    try {
      expect(readLivePid(file)).toBeUndefined();
      writeFileSync(file, "not a pid");
      expect(readLivePid(file)).toBeUndefined();
      writeFileSync(file, "999999");
      expect(readLivePid(file)).toBeUndefined();

      // Pidfile written a minute before this process started: the PID was reused.
      writeFileSync(file, String(process.pid));
      const age = processAgeMs(process.pid) ?? 0;
      const old = (Date.now() - age - 60_000) / 1000;
      utimesSync(file, old, old);
      expect(readLivePid(file)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the PID of a process started before its pidfile was written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "achords-pid-"));
    const child = spawn("sleep", ["30"]);
    try {
      const file = join(dir, "x.pid");
      writeFileSync(file, String(child.pid));
      expect(readLivePid(file)).toBe(child.pid);
    } finally {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
