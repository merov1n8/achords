import { describe, expect, it } from "vitest";
import { openCoreDatabase } from "./db/database.ts";
import { enqueueChild, enqueueRoot } from "./delegation.ts";
import { getTask } from "./queue.ts";
import { createThread, getThread, setThreadProject } from "./threads.ts";

describe("projects on threads and tasks (ADR-0031)", () => {
  it("a thread carries a project; root tasks take it from the thread, children inherit it", () => {
    const db = openCoreDatabase(":memory:");
    const thread = createThread(db, { project: "acme" });
    expect(getThread(db, thread.id)?.project).toBe("acme");
    const root = enqueueRoot(db, {
      caller: "boss",
      title: "t",
      threadId: thread.id,
      project: "acme",
    });
    const child = enqueueChild(db, root, { title: "c", caller: "dev" });
    expect(getTask(db, child.id)?.project).toBe("acme");

    setThreadProject(db, thread.id, null);
    expect(getThread(db, thread.id)?.project).toBeNull();
    // Already created tasks keep the project they were started in.
    expect(getTask(db, root.id)?.project).toBe("acme");
  });
});
