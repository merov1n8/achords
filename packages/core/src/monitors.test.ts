import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCoreDatabase } from "./index.ts";
import {
  createMonitor,
  dueMonitors,
  getMonitor,
  markNotified,
  recordCheck,
  unnotifiedMonitors,
  updateMonitor,
} from "./monitors.ts";

describe("monitors (ADR-0039)", () => {
  let dir: string;
  let db: ReturnType<typeof openCoreDatabase>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "achords-monitors-"));
    db = openCoreDatabase(join(dir, "core.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const site = () =>
    createMonitor(
      db,
      { name: "Shop up", kind: "site", config: { url: "https://x" }, everyMinutes: 10 },
      1000,
    );

  it("is due at once, then every N minutes", () => {
    const m = site();
    expect(dueMonitors(db, 1000).map((d) => d.id)).toEqual([m.id]);
    recordCheck(db, m.id, { state: "ok", detail: "200" }, 1000);
    expect(dueMonitors(db, 1000 + 9 * 60_000)).toEqual([]);
    expect(dueMonitors(db, 1000 + 10 * 60_000)).toHaveLength(1);
  });

  it("reports changes of state only, not every check", () => {
    const m = site();
    expect(recordCheck(db, m.id, { state: "ok", detail: "200" }).changed).toBe(false); // baseline
    expect(recordCheck(db, m.id, { state: "ok", detail: "200" }).changed).toBe(false);
    expect(recordCheck(db, m.id, { state: "alert", detail: "503" })).toEqual({
      changed: true,
      from: "ok",
    });
    expect(unnotifiedMonitors(db).map((x) => x.detail)).toEqual(["503"]);
    markNotified(db, m.id);
    expect(recordCheck(db, m.id, { state: "alert", detail: "503" }).changed).toBe(false);
    expect(recordCheck(db, m.id, { state: "ok", detail: "200" }).changed).toBe(true);
  });

  it("a first check that finds a problem is a change", () => {
    const m = site();
    expect(recordCheck(db, m.id, { state: "alert", detail: "down" }).changed).toBe(true);
  });

  it("validates input, and a changed check starts fresh", () => {
    expect(() =>
      createMonitor(db, { name: "x", kind: "site", config: {}, everyMinutes: 1 }),
    ).toThrow(/at least 5/);
    expect(() =>
      createMonitor(db, { name: "x", kind: "nope" as never, config: {}, everyMinutes: 5 }),
    ).toThrow(/kind/);
    const m = site();
    recordCheck(db, m.id, { state: "alert", detail: "down" });
    updateMonitor(db, m.id, { config: { url: "https://y" } });
    expect(getMonitor(db, m.id)).toMatchObject({ state: "unknown", notified: true });
  });

  it("a problem that is gone before it was told is not told at all", () => {
    const m = site();
    recordCheck(db, m.id, { state: "ok", detail: "200" });
    recordCheck(db, m.id, { state: "alert", detail: "503" }); // during quiet hours, untold
    expect(recordCheck(db, m.id, { state: "ok", detail: "200" }).changed).toBe(false);
    expect(unnotifiedMonitors(db)).toEqual([]);
  });

  it("integration monitors tell each piece of news and keep the last result", () => {
    const m = createMonitor(db, {
      name: "Reviews",
      kind: "integration",
      config: { integration: "meta" },
      everyMinutes: 30,
    });
    expect(
      recordCheck(db, m.id, { state: "ok", detail: "baseline", result: "A", news: false }).changed,
    ).toBe(false);
    expect(getMonitor(db, m.id)?.lastResult).toBe("A");
    expect(
      recordCheck(db, m.id, { state: "alert", detail: "1 new review", result: "AB", news: true })
        .changed,
    ).toBe(true);
    markNotified(db, m.id);
    expect(
      recordCheck(db, m.id, { state: "alert", detail: "another", result: "ABC", news: true })
        .changed,
    ).toBe(true);
    // The next quiet check does not announce "back to normal".
    markNotified(db, m.id);
    expect(recordCheck(db, m.id, { state: "ok", detail: "no change", news: false }).changed).toBe(
      false,
    );
    expect(getMonitor(db, m.id)?.lastResult).toBe("ABC");
  });
});
