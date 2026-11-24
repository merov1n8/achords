import { describe, expect, it } from "vitest";
import { moveCard, placeCard } from "./board.ts";
import { openCoreDatabase } from "./db/database.ts";
import { enqueueRoot } from "./delegation.ts";
import { claim, extendLease } from "./queue.ts";
import { startRun } from "./runs.ts";
import { setSetting } from "./settings.ts";
import {
  chainProgress,
  findStalls,
  markStallNoticed,
  STALL_MINUTES_KEY,
  stallSettings,
} from "./stalls.ts";
import { stopChain } from "./thread-work.ts";
import { appendMessage, createThread } from "./threads.ts";

const MIN = 60_000;

function chain() {
  const db = openCoreDatabase(":memory:");
  const thread = createThread(db, {});
  const root = enqueueRoot(db, { caller: "boss", title: "Build", threadId: thread.id }, 0);
  claim(db, { workerId: "w", leaseMs: 10 * MIN }, 0);
  startRun(db, { provider: "cli-claude", taskId: root.id }, 0);
  return { db, threadId: thread.id, rootId: root.id };
}

describe("stall watcher queries (ADR-0066)", () => {
  it("defaults to 15 minutes and 80 %", () => {
    const db = openCoreDatabase(":memory:");
    expect(stallSettings(db)).toEqual({ minutes: 15, percent: 80 });
    setSetting(db, STALL_MINUTES_KEY, "abc");
    expect(stallSettings(db).minutes).toBe(15);
  });

  it("progress ignores lease renewal and the boss's posts, and counts moves", () => {
    const { db, threadId, rootId } = chain();
    extendLease(db, rootId, "w", 10 * MIN, 5 * MIN);
    appendMessage(db, { threadId, role: "agent", author: "boss", channel: "system", content: "x" });
    expect(chainProgress(db, rootId).at).toBe(0);
    placeCard(db, rootId, "todo", "system", 1 * MIN);
    moveCard(db, { taskId: rootId, from: "todo", to: "in_progress", actor: "owner" }, 7 * MIN);
    expect(chainProgress(db, rootId)).toEqual({ at: 7 * MIN, what: "card move" });
  });

  it("finds an idle chain once until new progress", () => {
    const { db, rootId } = chain();
    const opts = { minutes: 15, percent: 80 };
    expect(findStalls(db, { ...opts, now: 14 * MIN })).toEqual([]);
    expect(findStalls(db, { ...opts, now: 15 * MIN }).map((s) => s.reason)).toEqual(["idle"]);
    markStallNoticed(db, rootId, "idle", 15 * MIN);
    expect(findStalls(db, { ...opts, now: 60 * MIN })).toEqual([]);
    // In-memory activity (a stream event) after the notice starts a new period.
    const activity = () => 20 * MIN;
    expect(findStalls(db, { ...opts, now: 34 * MIN, activity })).toEqual([]);
    expect(findStalls(db, { ...opts, now: 35 * MIN, activity })[0]).toMatchObject({
      reason: "idle",
      lastWhat: "agent activity",
    });
  });

  it("keeps 'spend' as the reason once given", () => {
    const { db, rootId } = chain();
    markStallNoticed(db, rootId, "spend", 1);
    markStallNoticed(db, rootId, "idle", 2);
    expect(db.prepare("SELECT stall_reason, stall_noticed_at FROM tasks").get()).toEqual({
      stall_reason: "spend",
      stall_noticed_at: 2,
    });
  });

  it("stopChain cancels one chain's open tasks and runs", () => {
    const { db, rootId } = chain();
    const other = enqueueRoot(db, { caller: "boss", title: "Other" });
    expect(stopChain(db, rootId)).toEqual({ cancelled: 1, stopped: 1 });
    expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(other.id)).toEqual({
      status: "queued",
    });
  });
});
