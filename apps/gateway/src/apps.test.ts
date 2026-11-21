import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppControl } from "@achords/platform";
import type { CatalogApp } from "@achords/policy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApps } from "./apps.ts";

const BLENDER: CatalogApp = {
  name: "Blender",
  open: ["-g", "-a", "Blender"],
  ready: { port: 9876, timeout_s: 60 },
};
const UNITY: CatalogApp = {
  name: "Unity",
  open: ["-g", "-a", "Unity", "--args", "-projectPath", "{workdir}"],
  requires: "ProjectSettings/ProjectVersion.txt",
};

describe("apps achords opens and closes (ADR-0054)", () => {
  let clock: number;
  let running: Map<string, number>;
  let listening: Set<number>;
  let calls: string[];
  let logs: string[];
  let failOpen: boolean;
  // Seconds after `open` until the app's process appears and its socket listens.
  let startsAfter: { process: number; port: number };
  let openedAt: number | undefined;
  let dir: string;

  const control: AppControl = {
    pid: async (p) => {
      if (openedAt !== undefined && clock - openedAt >= startsAfter.process * 1000) {
        if (!running.has(p)) running.set(p, 100 + running.size);
      }
      return running.get(p);
    },
    open: async (args) => {
      calls.push(`open ${args.join(" ")}`);
      if (failOpen) throw new Error("Unable to find application named 'Blender'");
      openedAt = clock;
    },
    quit: async (name) => {
      calls.push(`quit ${name}`);
      running.delete(name);
    },
    listening: async (port) =>
      listening.has(port) ||
      (openedAt !== undefined && clock - openedAt >= startsAfter.port * 1000),
  };
  const apps = () =>
    createApps({
      control,
      log: (m) => logs.push(m),
      graceMs: 180_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

  beforeEach(() => {
    clock = 1_000_000;
    running = new Map();
    listening = new Set();
    calls = [];
    logs = [];
    failOpen = false;
    startsAfter = { process: 2, port: 8 };
    openedAt = undefined;
    dir = mkdtempSync(join(tmpdir(), "achords-apps-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("opens a closed app in the background and waits until its socket answers", async () => {
    const a = apps();
    expect(await a.ensure(BLENDER, dir)).toEqual({ ok: true, opened: true });
    expect(calls).toEqual(["open -g -a Blender"]);
    expect(clock - 1_000_000).toBeGreaterThanOrEqual(8000);
    expect(logs.join("\n")).toMatch(/opened Blender/);
    // The next step finds it running and does not open it again.
    expect(await a.ensure(BLENDER, dir)).toEqual({ ok: true, opened: false });
    expect(calls).toHaveLength(1);
  });

  it("leaves an app the owner opened alone: never opens or closes it", async () => {
    running.set("Blender", 7);
    const a = apps();
    expect(await a.ensure(BLENDER, dir)).toEqual({ ok: true, opened: false });
    clock += 3_600_000;
    await a.sweep(() => new Set());
    clock += 3_600_000;
    await a.sweep(() => new Set());
    expect(calls).toEqual([]);
  });

  it("closes what it opened only after no active task needs it for the grace period", async () => {
    const a = apps();
    await a.ensure(BLENDER, dir);
    // A task still needs it: stays open however long.
    clock += 3_600_000;
    await a.sweep(() => new Set(["Blender"]));
    // Idle, but within the grace period (a next step may follow).
    await a.sweep(() => new Set());
    clock += 120_000;
    await a.sweep(() => new Set());
    expect(calls).not.toContain("quit Blender");
    // Needed again meanwhile: the grace period starts over.
    await a.sweep(() => new Set(["Blender"]));
    await a.sweep(() => new Set());
    clock += 120_000;
    await a.sweep(() => new Set());
    expect(calls).not.toContain("quit Blender");
    clock += 61_000;
    await a.sweep(() => new Set());
    expect(calls).toContain("quit Blender");
    expect(logs.join("\n")).toMatch(/closed Blender/);
    // Closed once; nothing left to close.
    await a.sweep(() => new Set());
    expect(calls.filter((c) => c === "quit Blender")).toHaveLength(1);
  });

  it("does not close an app the owner quit and reopened meanwhile", async () => {
    const a = apps();
    await a.ensure(BLENDER, dir);
    running.set("Blender", 999);
    await a.sweep(() => new Set());
    clock += 200_000;
    await a.sweep(() => new Set());
    expect(calls).not.toContain("quit Blender");
  });

  it("reports an app that cannot be opened or does not get ready", async () => {
    failOpen = true;
    expect(await apps().ensure(BLENDER, dir)).toEqual({
      ok: false,
      reason: "could not be opened",
    });
    failOpen = false;
    startsAfter = { process: 2, port: 1_000 };
    const a = apps();
    expect(await a.ensure(BLENDER, dir)).toEqual({
      ok: false,
      reason: "opened, but did not answer within 60 s",
    });
    // Still ours: closed later like any app it opened.
    await a.sweep(() => new Set());
    clock += 200_000;
    await a.sweep(() => new Set());
    expect(calls).toContain("quit Blender");
  });

  it("opens Unity on the working folder only when it is a project", async () => {
    expect(await apps().ensure(UNITY, dir)).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
    mkdirSync(join(dir, "ProjectSettings"));
    writeFileSync(
      join(dir, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 6000.6.0f1",
    );
    expect(await apps().ensure(UNITY, dir)).toEqual({ ok: true, opened: true });
    expect(calls).toEqual([`open -g -a Unity --args -projectPath ${dir}`]);
  });
});
