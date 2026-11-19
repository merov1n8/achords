import { describe, expect, it } from "vitest";
import { openCoreDatabase } from "./db/database.ts";
import {
  addSpend,
  childFinished,
  enqueueChild,
  listChildren,
  remainingBudget,
} from "./delegation.ts";
import { claim, complete, enqueue, getTask } from "./queue.ts";

const LEASE = 60_000;

describe("linked tasks", () => {
  it("a child links to parent and root, inherits sensitivity, and the parent waits for it", () => {
    const db = openCoreDatabase(":memory:");
    const root = enqueue(db, { title: "root", sensitivity: "local-only", budgetUsd: 2 });
    claim(db, { workerId: "w", leaseMs: LEASE });
    const child = enqueueChild(db, root, { title: "child", caller: "web-dev" });
    expect(child).toMatchObject({
      parentId: root.id,
      rootId: root.id,
      depth: root.depth + 1,
      agentChain: ["web-dev"],
      sensitivity: "local-only",
    });
    // The parent finishes its run but must not be picked up again until the child is done.
    complete(db, root.id, "w", "delegated");
    db.prepare("UPDATE tasks SET status = 'queued' WHERE id = ?").run(root.id);
    expect(getTask(db, root.id)?.waitingChildren).toBe(1);
    expect(claim(db, { workerId: "w", leaseMs: LEASE })?.id).toBe(child.id);
    expect(claim(db, { workerId: "w", leaseMs: LEASE })).toBeUndefined();

    complete(db, child.id, "w", "child result");
    childFinished(db, child.id);
    expect(getTask(db, root.id)?.waitingChildren).toBe(0);
    expect(claim(db, { workerId: "w", leaseMs: LEASE })?.id).toBe(root.id);
    expect(listChildren(db, root.id).map((c) => c.result)).toEqual(["child result"]);
  });

  it("a child that fails by lease expiry (worker crash) still wakes its parent", () => {
    const db = openCoreDatabase(":memory:");
    const root = enqueue(db, { title: "root" }, 0);
    const child = enqueueChild(db, root, { title: "c", caller: "boss", maxAttempts: 1 }, 0);
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(root.id);
    db.prepare("UPDATE tasks SET status = 'queued' WHERE id = ?").run(root.id);
    claim(db, { workerId: "dead", leaseMs: 10 }, 0); // claims the child
    expect(getTask(db, root.id)?.waitingChildren).toBe(1);
    claim(db, { workerId: "w", leaseMs: 10 }, 100); // reclaim: child fails (last attempt)
    expect(getTask(db, child.id)?.status).toBe("failed");
    expect(getTask(db, root.id)?.waitingChildren).toBe(0);
  });

  it("grandchildren keep the root, extend the chain and can only be more sensitive", () => {
    const db = openCoreDatabase(":memory:");
    const root = enqueue(db, { title: "root", sensitivity: "local-only" });
    const a = enqueueChild(db, root, { title: "a", caller: "boss" });
    const b = enqueueChild(db, a, { title: "b", caller: "web-dev", sensitivity: "normal" });
    expect(b).toMatchObject({ rootId: root.id, depth: 2, agentChain: ["boss", "web-dev"] });
    // A caller cannot lower sensitivity.
    expect(b.sensitivity).toBe("local-only");
  });

  it("one budget per root, shared by the whole chain", () => {
    const db = openCoreDatabase(":memory:");
    const root = enqueue(db, { title: "root", budgetUsd: 1 });
    const child = enqueueChild(db, root, { title: "c", caller: "boss" });
    addSpend(db, root.id, 0.4);
    addSpend(db, child.rootId ?? child.id, 0.5);
    expect(remainingBudget(db, child.rootId ?? child.id)).toBeCloseTo(0.1);
    // Without a budget there is no cap.
    expect(remainingBudget(db, enqueue(db, { title: "x" }).id)).toBe(Number.POSITIVE_INFINITY);
  });
});
