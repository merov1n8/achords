import { describe, expect, it } from "vitest";
import { openCoreDatabase } from "./db/database.ts";
import {
  addSpend,
  answerOwnerQuestion,
  answerParentQuestion,
  askOwner,
  askParent,
  childFinished,
  childQuestions,
  childQuestionsSeen,
  enqueueChild,
  enqueueSuccessor,
  handoffHops,
  lineTaskCount,
  listChildren,
  openQuestion,
  remainingBudget,
  requestHandoff,
} from "./delegation.ts";
import { claim, complete, enqueue, getTask, type Task } from "./queue.ts";
import { createThread } from "./threads.ts";

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

describe("questions to the owner", () => {
  it("a task with an open question is not claimable until it is answered, oldest first", () => {
    const db = openCoreDatabase(":memory:");
    const thread = createThread(db, {});
    const a = enqueue(db, { title: "a", threadId: thread.id }, 1);
    const b = enqueue(db, { title: "b", threadId: thread.id }, 2);
    askOwner(db, a.id, "Melyik színt szeretnéd?", 3);
    askOwner(db, b.id, "És a betűtípus?", 4);
    expect(claim(db, { workerId: "w", leaseMs: LEASE })).toBeUndefined();
    expect(openQuestion(db, thread.id)?.id).toBe(a.id);

    expect(answerOwnerQuestion(db, thread.id, "kék")?.id).toBe(a.id);
    expect(getTask(db, a.id)).toMatchObject({ waitingOwner: false, ownerAnswer: "kék" });
    expect(claim(db, { workerId: "w", leaseMs: LEASE })?.id).toBe(a.id);
    expect(openQuestion(db, thread.id)?.id).toBe(b.id);
    expect(answerOwnerQuestion(db, createThread(db, {}).id, "x")).toBeUndefined();
  });
});

describe("questions to the parent (ADR-0066)", () => {
  const setup = () => {
    const db = openCoreDatabase(":memory:");
    const thread = createThread(db, {});
    const root = enqueue(db, { title: "root", threadId: thread.id }, 1);
    claim(db, { workerId: "w", leaseMs: LEASE }, 2);
    const child = enqueueChild(db, root, { title: "c", caller: "lead" }, 3);
    const other = enqueueChild(db, root, { title: "d", caller: "lead" }, 4);
    // The parent's run ended: it waits for both children.
    db.prepare("UPDATE tasks SET status = 'queued', claimed_by = NULL WHERE id = ?").run(root.id);
    return { db, thread, root, child, other };
  };
  const next = (db: ReturnType<typeof openCoreDatabase>, now = 10) =>
    claim(db, { workerId: "w", leaseMs: LEASE }, now) as Task | undefined;

  it("a child's question wakes the parent despite open children; the answer requeues the child", () => {
    const { db, root, child, other } = setup();
    expect(next(db)?.id).toBe(child.id);
    askParent(db, child.id, "Which tone?", 5);
    db.prepare("UPDATE tasks SET status = 'queued', claimed_by = NULL WHERE id = ?").run(child.id);
    expect(getTask(db, child.id)).toMatchObject({
      waitingParent: true,
      parentQuestion: "Which tone?",
      parentQuestions: 1,
    });
    // The parent goes first (older), although both children are open.
    expect(next(db)?.id).toBe(root.id);
    expect(childQuestions(db, root.id).map((c) => c.id)).toEqual([child.id]);
    expect(answerParentQuestion(db, child.id, "Friendly.", 6)).toBe(true);
    expect(answerParentQuestion(db, child.id, "again", 7)).toBe(false);
    db.prepare("UPDATE tasks SET status = 'queued', claimed_by = NULL WHERE id = ?").run(root.id);
    // Answered: the parent waits again; the child resumes with the answer.
    expect(next(db)?.id).toBe(child.id);
    expect(getTask(db, child.id)).toMatchObject({
      waitingParent: false,
      parentAnswer: "Friendly.",
    });
    expect(next(db)?.id).toBe(other.id);
    expect(next(db)).toBeUndefined();
  });

  it("a question the parent saw and left open stays open but wakes it no more", () => {
    const { db, root, child, other } = setup();
    askParent(db, child.id, "Which tone?", 5);
    expect(next(db)?.id).toBe(root.id);
    db.prepare("UPDATE tasks SET status = 'queued', claimed_by = NULL WHERE id = ?").run(root.id);
    childQuestionsSeen(db, [child.id]);
    expect(next(db)?.id).toBe(other.id);
    expect(next(db)).toBeUndefined();
    expect(childQuestions(db, root.id).map((c) => c.id)).toEqual([child.id]);
    expect(answerParentQuestion(db, child.id, "Friendly.", 6)).toBe(true);
    expect(next(db)?.id).toBe(child.id);
  });

  it("the owner's reply never answers a parent question", () => {
    const { db, thread, child } = setup();
    askParent(db, child.id, "Which tone?", 5);
    expect(answerOwnerQuestion(db, thread.id, "Friendly.")).toBeUndefined();
    expect(getTask(db, child.id)).toMatchObject({ waitingParent: true, parentAnswer: null });
  });
});

describe("handoff (ADR-0055)", () => {
  it("the successor is a sibling: same parent, root and depth; the caller joins its chain", () => {
    const db = openCoreDatabase(":memory:");
    const root = enqueue(db, { title: "root", sensitivity: "local-only" });
    const step = enqueueChild(db, root, { title: "script", caller: "marketing" });
    expect(getTask(db, root.id)?.waitingChildren).toBe(1);
    const next = enqueueSuccessor(db, step, {
      title: "voice",
      description: "record it",
      caller: "video-producer",
    });
    expect(next).toMatchObject({
      parentId: root.id,
      rootId: root.id,
      depth: step.depth,
      agentChain: ["marketing", "video-producer"],
      continuesFrom: step.id,
      sensitivity: "local-only",
      description: "record it",
    });
    // The parent now waits for the successor as well; the caller's own finish releases one.
    expect(getTask(db, root.id)?.waitingChildren).toBe(2);
    childFinished(db, step.id);
    expect(getTask(db, root.id)?.waitingChildren).toBe(1);
    expect(handoffHops(db, next)).toBe(1);
    const third = enqueueSuccessor(db, next, { title: "edit", caller: "audio" });
    expect(handoffHops(db, third)).toBe(2);
  });

  it("a root's successor is a root-level task in the same thread under the same budget", () => {
    const db = openCoreDatabase(":memory:");
    const thread = createThread(db, {});
    const root = enqueue(db, { title: "root", threadId: thread.id, project: "acme" });
    const next = enqueueSuccessor(db, root, { title: "next", caller: "web-dev" });
    expect(next).toMatchObject({
      parentId: null,
      rootId: root.id,
      threadId: thread.id,
      project: "acme",
      depth: root.depth,
    });
    expect(lineTaskCount(db, root.id)).toBe(2);
  });

  it("a requested handoff is stored on the task until its run ends", () => {
    const db = openCoreDatabase(":memory:");
    const t = enqueue(db, { title: "t" });
    expect(getTask(db, t.id)?.handoff).toBeNull();
    requestHandoff(db, t.id, { agent: "seo", title: "x", instructions: "y" });
    expect(getTask(db, t.id)?.handoff).toEqual({ agent: "seo", title: "x", instructions: "y" });
  });
});
