import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMonitor, enqueue, getMonitor, openCoreDatabase, setSetting } from "@achords/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inQuietHours, QUIET_HOURS_KEY, runMonitors } from "./monitors.ts";

describe("heartbeat monitors (ADR-0039)", () => {
  let dir: string;
  let db: ReturnType<typeof openCoreDatabase>;
  let told: string[];
  let status: number | "down";
  const fakeFetch = (async () => {
    if (status === "down") throw Object.assign(new Error("x"), { name: "TimeoutError" });
    return new Response("", { status });
  }) as typeof fetch;
  let clock: Date;
  const run = () =>
    runMonitors({ db, notify: (t) => told.push(t), fetch: fakeFetch, now: () => clock });
  const later = (minutes: number) => {
    clock = new Date(clock.getTime() + minutes * 60_000);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "achords-mon-"));
    db = openCoreDatabase(join(dir, "core.db"));
    told = [];
    status = 200;
    clock = new Date(2026, 10, 20, 12, 0);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stays quiet while the site is up and tells once when it goes down and back", async () => {
    createMonitor(
      db,
      { name: "Shop", kind: "site", config: { url: "https://shop" }, everyMinutes: 5 },
      clock.getTime(),
    );
    await run();
    later(5);
    await run();
    expect(told).toEqual([]);
    status = 503;
    later(5);
    await run();
    later(5);
    await run();
    expect(told).toEqual(["⚠️ Shop: https://shop answers 503"]);
    status = "down";
    later(5);
    await run();
    expect(told).toHaveLength(1);
    status = 200;
    later(5);
    await run();
    expect(told[1]).toMatch(/^✅ Shop: back to normal/);
  });

  it("holds news during quiet hours and tells it afterwards", async () => {
    setSetting(db, QUIET_HOURS_KEY, "22-7");
    clock = new Date(2026, 10, 20, 23, 0);
    createMonitor(
      db,
      { name: "Shop", kind: "site", config: { url: "https://shop" }, everyMinutes: 5 },
      clock.getTime(),
    );
    status = "down";
    await run();
    expect(told).toEqual([]);
    clock = new Date(2026, 10, 21, 7, 0);
    await run();
    expect(told[0]).toMatch(/Shop: https:\/\/shop is not reachable \(TimeoutError\)/);
  });

  it("finds kanban cards that have not moved for too long", async () => {
    const m = createMonitor(
      db,
      { name: "Board", kind: "stuck", config: { hours: 48 }, everyMinutes: 60 },
      clock.getTime(),
    );
    const task = enqueue(db, { title: "Fix cart" });
    db.prepare("UPDATE tasks SET board_column = 'in_progress', updated_at = ? WHERE id = ?").run(
      clock.getTime() - 49 * 3_600_000,
      task.id,
    );
    await run();
    expect(getMonitor(db, m.id)?.state).toBe("alert");
    expect(told[0]).toMatch(/1 card\(s\) have not moved for 48 hours:\n- Fix cart \(in_progress\)/);
  });

  it("parses quiet hours across midnight", () => {
    expect(inQuietHours("22-7", 23)).toBe(true);
    expect(inQuietHours("22-7", 6)).toBe(true);
    expect(inQuietHours("22-7", 7)).toBe(false);
    expect(inQuietHours("13-14", 13)).toBe(true);
    expect(inQuietHours(undefined, 3)).toBe(false);
  });

  it("integration monitors tell news from the orchestrator's check, nothing else", async () => {
    createMonitor(
      db,
      { name: "Reviews", kind: "integration", config: {}, everyMinutes: 30 },
      clock.getTime(),
    );
    const answers = [
      { state: "ok" as const, detail: "first result stored", result: "A", news: false },
      { state: "alert" as const, detail: "1 new review: 2 stars", result: "AB", news: true },
      { state: "ok" as const, detail: "no change", result: "AB", news: false },
    ];
    const previous: (string | null)[] = [];
    const check = () =>
      runMonitors({
        db,
        notify: (t) => told.push(t),
        now: () => clock,
        checkIntegration: async (m) => {
          previous.push(m.lastResult);
          return answers.shift() as (typeof answers)[number];
        },
      });
    for (let i = 0; i < 3; i++) {
      await check();
      later(30);
    }
    expect(previous).toEqual([null, "A", "AB"]);
    expect(told).toEqual(["🔔 Reviews: 1 new review: 2 stars"]);
  });
});
