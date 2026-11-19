import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { openCoreDatabase } from "./db/database.ts";
import {
  cancel,
  claim,
  complete,
  enqueue,
  extendLease,
  fail,
  getTask,
  isPaused,
  listTasks,
  setPaused,
} from "./queue.ts";

const LEASE = 60_000;

describe("task queue", () => {
  it("claims highest priority first, then FIFO", () => {
    const db = openCoreDatabase(":memory:");
    const a = enqueue(db, { title: "a" }, 1);
    const b = enqueue(db, { title: "b", priority: 5 }, 2);
    const c = enqueue(db, { title: "c" }, 3);
    const order = [1, 2, 3].map(() => claim(db, { workerId: "w", leaseMs: LEASE })?.id);
    expect(order).toEqual([b.id, a.id, c.id]);
    expect(claim(db, { workerId: "w", leaseMs: LEASE })).toBeUndefined();
  });

  it("completes only for the worker holding the claim", () => {
    const db = openCoreDatabase(":memory:");
    const t = enqueue(db, { title: "t" });
    claim(db, { workerId: "w1", leaseMs: LEASE });
    expect(complete(db, t.id, "w2", "nope")).toBe(false);
    expect(complete(db, t.id, "w1", "ok")).toBe(true);
    expect(getTask(db, t.id)).toMatchObject({ status: "done", result: "ok", claimedBy: null });
    expect(complete(db, t.id, "w1", "again")).toBe(false);
  });

  it("requeues on failure until max attempts, then fails", () => {
    const db = openCoreDatabase(":memory:");
    const t = enqueue(db, { title: "t", maxAttempts: 2 });
    claim(db, { workerId: "w", leaseMs: LEASE });
    expect(fail(db, t.id, "w", "boom")).toBe(true);
    expect(getTask(db, t.id)).toMatchObject({ status: "queued", attempts: 1, error: "boom" });
    claim(db, { workerId: "w", leaseMs: LEASE });
    fail(db, t.id, "w", "boom2");
    expect(getTask(db, t.id)).toMatchObject({ status: "failed", attempts: 2, error: "boom2" });
  });

  it("reclaims expired leases (crash recovery) and respects extensions", () => {
    const db = openCoreDatabase(":memory:");
    const t = enqueue(db, { title: "t", maxAttempts: 2 }, 0);
    claim(db, { workerId: "dead", leaseMs: 100 }, 0);
    expect(claim(db, { workerId: "w", leaseMs: 100 }, 50)).toBeUndefined();
    expect(extendLease(db, t.id, "dead", 100, 50)).toBe(true);
    expect(claim(db, { workerId: "w", leaseMs: 100 }, 120)).toBeUndefined();
    const again = claim(db, { workerId: "w", leaseMs: 100 }, 151);
    expect(again).toMatchObject({ id: t.id, claimedBy: "w", attempts: 2 });
    expect(complete(db, t.id, "dead", "stale")).toBe(false);
  });

  it("fails a task whose lease expires on its last attempt", () => {
    const db = openCoreDatabase(":memory:");
    const t = enqueue(db, { title: "t", maxAttempts: 1 }, 0);
    claim(db, { workerId: "dead", leaseMs: 10 }, 0);
    expect(claim(db, { workerId: "w", leaseMs: 10 }, 11)).toBeUndefined();
    expect(getTask(db, t.id)).toMatchObject({ status: "failed", error: "lease expired" });
  });

  it("claims nothing while paused", () => {
    const db = openCoreDatabase(":memory:");
    enqueue(db, { title: "t" });
    expect(isPaused(db)).toBe(false);
    setPaused(db, true);
    expect(isPaused(db)).toBe(true);
    expect(claim(db, { workerId: "w", leaseMs: LEASE })).toBeUndefined();
    setPaused(db, false);
    expect(claim(db, { workerId: "w", leaseMs: LEASE })).toBeDefined();
  });

  it("lists tasks for the kanban, most recently updated first", () => {
    const db = openCoreDatabase(":memory:");
    const a = enqueue(db, { title: "a" }, 1);
    const b = enqueue(db, { title: "b" }, 2);
    cancel(db, a.id, 3);
    expect(listTasks(db).map((t) => [t.id, t.status])).toEqual([
      [a.id, "cancelled"],
      [b.id, "queued"],
    ]);
  });

  it("cancels queued and claimed tasks but not finished ones", () => {
    const db = openCoreDatabase(":memory:");
    const a = enqueue(db, { title: "a" });
    const b = enqueue(db, { title: "b" });
    expect(cancel(db, a.id)).toBe(true);
    claim(db, { workerId: "w", leaseMs: LEASE });
    expect(cancel(db, b.id)).toBe(true);
    expect(complete(db, b.id, "w", "late")).toBe(false);
    expect(cancel(db, b.id)).toBe(false);
  });
});

describe("task queue concurrency", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function runWorkers(path: string, parties = 4): Promise<string[][]> {
    const workerUrl = new URL("./queue.worker.test-helper.ts", import.meta.url);
    const barrier = new SharedArrayBuffer(4);
    return Promise.all(
      Array.from(
        { length: parties },
        (_, i) =>
          new Promise<string[]>((resolve, reject) => {
            const w = new Worker(workerUrl, {
              workerData: { path, workerId: `w${i}`, barrier, parties },
            });
            w.once("message", resolve);
            w.once("error", reject);
          }),
      ),
    );
  }

  it("never hands the same task to two connections", async () => {
    dir = mkdtempSync(join(tmpdir(), "achords-queue-"));
    const path = join(dir, "core.db");
    const db = openCoreDatabase(path);
    for (let i = 0; i < 200; i++) enqueue(db, { title: `t${i}` });
    db.close();

    const results = await runWorkers(path);
    const all = results.flat();
    expect(all).toHaveLength(200);
    expect(new Set(all).size).toBe(200);
    // Guards the test itself: real contention means more than one worker got work.
    expect(results.filter((r) => r.length > 0).length).toBeGreaterThan(1);
  });

  it("lets several processes open and migrate a fresh database at once", async () => {
    dir = mkdtempSync(join(tmpdir(), "achords-queue-"));
    const results = await runWorkers(join(dir, "core.db"));
    expect(results.flat()).toEqual([]);
  });
});
