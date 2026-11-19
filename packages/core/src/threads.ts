import { randomUUID } from "node:crypto";
import type { Db } from "./db/database.ts";
import { transaction } from "./db/database.ts";

export interface Thread {
  id: string;
  title: string | null;
  workspace: string | null;
  createdAt: number;
  updatedAt: number;
}

export type MessageRole = "user" | "agent" | "system";
export type Channel = "web" | "telegram" | "system";
export type Visibility = "normal" | "trace";

export interface Message {
  id: string;
  /** Monotonic insertion order (SQLite rowid); channels use it as a delivery cursor. */
  seq: number;
  threadId: string;
  role: MessageRole;
  author: string | null;
  channel: Channel;
  content: string;
  visibility: Visibility;
  createdAt: number;
}

type Row = Record<string, unknown>;

const toThread = (r: Row): Thread => ({
  id: r.id as string,
  title: r.title as string | null,
  workspace: r.workspace as string | null,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const toMessage = (r: Row): Message => ({
  id: r.id as string,
  seq: Number(r.seq),
  threadId: r.thread_id as string,
  role: r.role as MessageRole,
  author: r.author as string | null,
  channel: r.channel as Channel,
  content: r.content as string,
  visibility: r.visibility as Visibility,
  createdAt: Number(r.created_at),
});

export function createThread(
  db: Db,
  input: { title?: string; workspace?: string },
  now = Date.now(),
): Thread {
  const row = db
    .prepare(
      `INSERT INTO threads (id, title, workspace, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(randomUUID(), input.title ?? null, input.workspace ?? null, now, now);
  return toThread(row as Row);
}

export function getThread(db: Db, id: string): Thread | undefined {
  const row = db.prepare("SELECT * FROM threads WHERE id = ?").get(id);
  return row ? toThread(row) : undefined;
}

export function listThreads(db: Db, limit = 50): Thread[] {
  return db
    .prepare("SELECT * FROM threads ORDER BY updated_at DESC, rowid DESC LIMIT ?")
    .all(limit)
    .map(toThread);
}

export function appendMessage(
  db: Db,
  input: {
    threadId: string;
    role: MessageRole;
    author?: string;
    channel: Channel;
    content: string;
    visibility?: Visibility;
  },
  now = Date.now(),
): Message {
  return transaction(db, () => {
    const row = db
      .prepare(
        `INSERT INTO messages (id, thread_id, role, author, channel, content, visibility, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING rowid AS seq, *`,
      )
      .get(
        randomUUID(),
        input.threadId,
        input.role,
        input.author ?? null,
        input.channel,
        input.content,
        input.visibility ?? "normal",
        now,
      );
    db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(now, input.threadId);
    return toMessage(row as Row);
  });
}

export function listMessages(
  db: Db,
  threadId: string,
  opts: { includeTraces?: boolean } = {},
): Message[] {
  const filter = opts.includeTraces ? "" : "AND visibility = 'normal'";
  return db
    .prepare(
      `SELECT rowid AS seq, * FROM messages WHERE thread_id = ? ${filter} ORDER BY created_at, rowid`,
    )
    .all(threadId)
    .map(toMessage);
}

export function listMessagesAfter(db: Db, threadId: string, seq: number): Message[] {
  return db
    .prepare(
      `SELECT rowid AS seq, * FROM messages
       WHERE thread_id = ? AND rowid > ? AND visibility = 'normal' ORDER BY rowid`,
    )
    .all(threadId, seq)
    .map(toMessage);
}
