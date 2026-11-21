import { describe, expect, it } from "vitest";
import { openCoreDatabase } from "./db/database.ts";
import {
  appendMessage,
  clearActions,
  createThread,
  deleteThread,
  getThread,
  listMessages,
  listMessagesAfter,
  listThreads,
  makeThreadLocalOnly,
  updateThread,
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

  it("names the agent that wrote last in each chat (traces left out)", () => {
    const db = openCoreDatabase(":memory:");
    db.prepare(
      "INSERT INTO agents (id, name, role, workspace, created_at, updated_at) VALUES ('coder', 'Coder', 'dev', 'shared', 0, 0)",
    ).run();
    const a = createThread(db, { title: "a" });
    const agent = (author: string, visibility?: "trace") =>
      appendMessage(db, {
        threadId: a.id,
        role: "agent",
        channel: "web",
        content: "x",
        author,
        ...(visibility ? { visibility } : {}),
      });
    expect(getThread(db, a.id)?.lastAgent).toBeNull();
    agent("ghost");
    expect(listThreads(db)[0]?.lastAgent).toBe("ghost");
    agent("coder");
    agent("boss", "trace");
    expect(listThreads(db)[0]?.lastAgent).toBe("Coder");
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

  it("clears an action everywhere once it has been decided", () => {
    const db = openCoreDatabase(":memory:");
    const t = createThread(db, {});
    appendMessage(db, {
      threadId: t.id,
      role: "agent",
      channel: "system",
      content: "approve?",
      actions: [
        { label: "ok", data: "proposal:approve:ab12" },
        { label: "no", data: "proposal:reject:ab12" },
      ],
    });
    appendMessage(db, {
      threadId: t.id,
      role: "agent",
      channel: "system",
      content: "other",
      actions: [{ label: "ok", data: "proposal:approve:cd34" }],
    });
    expect(clearActions(db, "proposal:", "ab12")).toBe(1);
    expect(listMessages(db, t.id).map((m) => m.actions?.length ?? 0)).toEqual([0, 1]);
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

  it("pins, renames, archives, searches and deletes chats", () => {
    const db = openCoreDatabase(":memory:");
    const a = createThread(db, { title: "Cart bug", project: "acme" }, 1);
    const b = createThread(db, { title: "Blog post" }, 2);
    appendMessage(db, {
      threadId: b.id,
      role: "user",
      channel: "web",
      content: "write about 100% growth",
    });
    expect(updateThread(db, a.id, { pinned: true, title: " Cart fix " })).toBe(true);
    expect(getThread(db, a.id)).toMatchObject({ pinned: true, title: "Cart fix" });
    // Search: title or any message; % is literal.
    expect(listThreads(db, { q: "cart" }).map((t) => t.id)).toEqual([a.id]);
    expect(listThreads(db, { q: "100%" }).map((t) => t.id)).toEqual([b.id]);
    expect(listThreads(db, { q: "1%0" })).toEqual([]);
    expect(listThreads(db, { project: "acme" }).map((t) => t.id)).toEqual([a.id]);
    // Archived chats leave the list and come back.
    updateThread(db, b.id, { archived: true });
    expect(listThreads(db).map((t) => t.id)).toEqual([a.id]);
    expect(listThreads(db, { archived: true }).map((t) => t.id)).toEqual([b.id]);
    updateThread(db, b.id, { archived: false });
    expect(listThreads(db)).toHaveLength(2);
    // Delete takes the messages with it.
    expect(deleteThread(db, b.id)).toBe(true);
    expect(listMessages(db, b.id)).toEqual([]);
    expect(deleteThread(db, b.id)).toBe(false);
    expect(updateThread(db, "missing", { pinned: true })).toBe(false);
  });
});
