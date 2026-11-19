import { randomUUID } from "node:crypto";
import type { Db } from "./db/database.ts";
import { transaction } from "./db/database.ts";

export type Sensitivity = "normal" | "local-only";

export interface Thread {
  id: string;
  title: string | null;
  workspace: string | null;
  sensitivity: Sensitivity;
  createdAt: number;
  updatedAt: number;
}

export type MessageRole = "user" | "agent" | "system";
export type Channel = "web" | "telegram" | "system";
export type Visibility = "normal" | "trace";

/** An action a channel may render as a button; `data` is "<kind>:<verb>:<id>" (≤ 64 bytes). */
export interface MessageAction {
  label: string;
  data: string;
}

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
  actions: MessageAction[] | null;
  createdAt: number;
}

type Row = Record<string, unknown>;

const toThread = (r: Row): Thread => ({
  id: r.id as string,
  title: r.title as string | null,
  workspace: r.workspace as string | null,
  sensitivity: r.sensitivity as Sensitivity,
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
  actions: r.actions ? (JSON.parse(String(r.actions)) as MessageAction[]) : null,
  createdAt: Number(r.created_at),
});

export function createThread(
  db: Db,
  input: { title?: string; workspace?: string; sensitivity?: Sensitivity },
  now = Date.now(),
): Thread {
  const row = db
    .prepare(
      `INSERT INTO threads (id, title, workspace, sensitivity, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      randomUUID(),
      input.title ?? null,
      input.workspace ?? null,
      input.sensitivity ?? "normal",
      now,
      now,
    );
  return toThread(row as Row);
}

/**
 * One way on purpose: a thread that was local-only must never become normal, or its history
 * could reach a frontier model later. Start a new thread for normal work.
 */
export function makeThreadLocalOnly(db: Db, id: string): boolean {
  return (
    db.prepare("UPDATE threads SET sensitivity = 'local-only' WHERE id = ?").run(id).changes === 1
  );
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
    actions?: MessageAction[];
  },
  now = Date.now(),
): Message {
  return transaction(db, () => {
    const row = db
      .prepare(
        `INSERT INTO messages (id, thread_id, role, author, channel, content, visibility, actions,
           created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING rowid AS seq, *`,
      )
      .get(
        randomUUID(),
        input.threadId,
        input.role,
        input.author ?? null,
        input.channel,
        input.content,
        input.visibility ?? "normal",
        input.actions?.length ? JSON.stringify(input.actions) : null,
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
