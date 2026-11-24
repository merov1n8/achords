import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { takeOverCard } from "./board.ts";
import { deleteCard } from "./cards.ts";
import { openCoreDatabase } from "./db/database.ts";
import { enqueue } from "./queue.ts";
import {
  carryCardSessions,
  chatCards,
  dropCardSession,
  endCardSessions,
  getCardSession,
  saveCardSession,
  sessionDir,
} from "./sessions.ts";
import { getSetting, setSetting } from "./settings.ts";
import { createThread } from "./threads.ts";

describe("card sessions (ADR-0066)", () => {
  let home: string;
  let db: ReturnType<typeof openCoreDatabase>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-sessions-"));
    db = openCoreDatabase(":memory:");
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const key = (card: string) => ({ card, agent: "coder", project: "" });
  const save = (card: string, sessionId: string, now: number) =>
    saveCardSession(
      db,
      { ...key(card), sessionId, model: "cli-claude/sonnet", trust: "closed" },
      now,
    );

  it("stores one session per card, agent and project; a new session replaces the old", () => {
    const t = enqueue(db, { title: "build" });
    save(t.id, "s1", 1);
    save(t.id, "s1", 5);
    expect(getCardSession(db, key(t.id))).toMatchObject({
      sessionId: "s1",
      createdAt: 1,
      lastUsedAt: 5,
    });
    save(t.id, "s2", 9);
    expect(getCardSession(db, key(t.id))).toMatchObject({ sessionId: "s2", createdAt: 9 });
    expect(getCardSession(db, { ...key(t.id), project: "acme" })).toBeUndefined();
    expect(getCardSession(db, { ...key(t.id), agent: "writer" })).toBeUndefined();
    dropCardSession(db, key(t.id));
    expect(getCardSession(db, key(t.id))).toBeUndefined();
  });

  it("moves with the card to the chat's next task, folder included", () => {
    const t = enqueue(db, { title: "build" });
    const next = enqueue(db, { title: "fix" });
    save(t.id, "s1", 1);
    mkdirSync(sessionDir(home, t.id, "coder"), { recursive: true });
    takeOverCard(db, t.id, next.id, "in_progress", "system");
    carryCardSessions(db, home, t.id, next.id);
    expect(getCardSession(db, key(next.id))?.sessionId).toBe("s1");
    expect(getCardSession(db, key(t.id))).toBeUndefined();
    expect(existsSync(sessionDir(home, next.id, "coder"))).toBe(true);
    expect(existsSync(sessionDir(home, t.id))).toBe(false);
  });

  it("ends a card's sessions with their folder; a deleted card takes its records along", () => {
    const thread = createThread(db, {});
    const a = enqueue(db, { title: "a", threadId: thread.id });
    const b = enqueue(db, { title: "b", threadId: thread.id });
    expect(chatCards(db, thread.id).sort()).toEqual([a.id, b.id].sort());
    save(a.id, "s1", 1);
    mkdirSync(sessionDir(home, a.id, "coder"), { recursive: true });
    endCardSessions(db, home, [a.id]);
    expect(getCardSession(db, key(a.id))).toBeUndefined();
    expect(existsSync(sessionDir(home, a.id))).toBe(false);
    save(b.id, "s2", 1);
    expect(deleteCard(db, b.id).ok).toBe(true);
    expect(getCardSession(db, key(b.id))).toBeUndefined();
  });
  it("card approvals (ADR-0067 step 4) move with the card and end with it", () => {
    const thread = createThread(db, {});
    const t = enqueue(db, { title: "build", threadId: thread.id });
    const next = enqueue(db, { title: "fix", threadId: thread.id });
    setSetting(db, `approval:${t.id}`, JSON.stringify([{ kind: "level", level: 2 }]));
    setSetting(db, `approval:${next.id}`, JSON.stringify([{ kind: "integration", id: "x" }]));
    carryCardSessions(db, home, t.id, next.id);
    expect(getSetting(db, `approval:${t.id}`)).toBeUndefined();
    expect(JSON.parse(getSetting(db, `approval:${next.id}`) ?? "[]")).toEqual([
      { kind: "integration", id: "x" },
      { kind: "level", level: 2 },
    ]);
    // Done, archived or deleted: every path ends the card's sessions, and its approvals.
    endCardSessions(db, home, chatCards(db, thread.id));
    expect(getSetting(db, `approval:${next.id}`)).toBeUndefined();
  });
});
