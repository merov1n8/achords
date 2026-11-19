import { describe, expect, it } from "vitest";
import { openCoreDatabase } from "./db/database.ts";
import {
  appendMessage,
  createThread,
  getThread,
  listMessages,
  listMessagesAfter,
  listThreads,
  makeThreadLocalOnly,
} from "./threads.ts";

describe("threads", () => {
  it("creates and fetches a thread", () => {
    const db = openCoreDatabase(":memory:");
    const t = createThread(db, { title: "TODO app", workspace: "web-clients" });
    expect(getThread(db, t.id)).toEqual(t);
    expect(getThread(db, "missing")).toBeUndefined();
  });

  it("lists threads by most recent activity", () => {
    const db = openCoreDatabase(":memory:");
    const a = createThread(db, { title: "a" }, 1);
    const b = createThread(db, { title: "b" }, 2);
    appendMessage(db, { threadId: a.id, role: "user", channel: "web", content: "hi" }, 3);
    expect(listThreads(db).map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it("hides trace messages unless asked", () => {
    const db = openCoreDatabase(":memory:");
    const t = createThread(db, {});
    appendMessage(db, { threadId: t.id, role: "user", channel: "telegram", content: "do X" }, 1);
    appendMessage(
      db,
      {
        threadId: t.id,
        role: "agent",
        channel: "system",
        content: "tool call",
        visibility: "trace",
      },
      2,
    );
    appendMessage(
      db,
      { threadId: t.id, role: "agent", author: "boss", channel: "telegram", content: "done" },
      3,
    );
    expect(listMessages(db, t.id).map((m) => m.content)).toEqual(["do X", "done"]);
    expect(listMessages(db, t.id, { includeTraces: true })).toHaveLength(3);
  });

  it("lists normal messages after a sequence cursor (for channel delivery)", () => {
    const db = openCoreDatabase(":memory:");
    const t = createThread(db, {});
    const a = appendMessage(db, { threadId: t.id, role: "user", channel: "web", content: "a" }, 1);
    appendMessage(
      db,
      { threadId: t.id, role: "agent", channel: "system", content: "x", visibility: "trace" },
      1,
    );
    const c = appendMessage(
      db,
      { threadId: t.id, role: "agent", channel: "system", content: "c" },
      1,
    );
    expect(c.seq).toBeGreaterThan(a.seq);
    expect(listMessagesAfter(db, t.id, a.seq).map((m) => m.content)).toEqual(["c"]);
    expect(listMessagesAfter(db, t.id, c.seq)).toEqual([]);
  });

  it("marks threads local-only, one way (history must never reach a frontier model later)", () => {
    const db = openCoreDatabase(":memory:");
    const t = createThread(db, {});
    expect(t.sensitivity).toBe("normal");
    const local = createThread(db, { sensitivity: "local-only" });
    expect(getThread(db, local.id)?.sensitivity).toBe("local-only");
    makeThreadLocalOnly(db, t.id);
    expect(getThread(db, t.id)?.sensitivity).toBe("local-only");
  });

  it("messages can carry actions (rendered as buttons by channels)", () => {
    const db = openCoreDatabase(":memory:");
    const t = createThread(db, {});
    const m = appendMessage(db, {
      threadId: t.id,
      role: "agent",
      channel: "system",
      content: "approve?",
      actions: [{ label: "✅ Approve", data: "proposal:approve:ab12" }],
    });
    expect(m.actions).toEqual([{ label: "✅ Approve", data: "proposal:approve:ab12" }]);
    expect(listMessages(db, t.id)[0]?.actions).toEqual(m.actions);
    expect(
      appendMessage(db, { threadId: t.id, role: "user", channel: "web", content: "x" }).actions,
    ).toBeNull();
  });

  it("rejects messages for unknown threads and invalid enums", () => {
    const db = openCoreDatabase(":memory:");
    expect(() =>
      appendMessage(db, { threadId: "nope", role: "user", channel: "web", content: "x" }),
    ).toThrow();
    const t = createThread(db, {});
    expect(() =>
      appendMessage(db, {
        threadId: t.id,
        // @ts-expect-error invalid on purpose
        role: "robot",
        channel: "web",
        content: "x",
      }),
    ).toThrow();
  });
});
