// ADR-0066 part 5: one CLI session per agent and card. The CLI keeps the transcript in the
// card's own config folder; the record says which session to resume and under what conditions.
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db/database.ts";

export interface CardSessionKey {
  /** The card's task id (a root task; delegated steps use their root's). */
  card: string;
  agent: string;
  /** "" without a project. */
  project: string;
}

export interface CardSession extends CardSessionKey {
  sessionId: string;
  /** Provider and model, e.g. "cli-claude/sonnet". */
  model: string;
  trust: string;
  createdAt: number;
  lastUsedAt: number;
}

/** The CLI config folder of one agent on one card; nothing else of the owner's config is in it. */
export const sessionDir = (home: string, card: string, agent?: string) =>
  agent ? join(home, "sessions", card, agent) : join(home, "sessions", card);

export function getCardSession(db: Db, k: CardSessionKey): CardSession | undefined {
  const r = db
    .prepare("SELECT * FROM card_sessions WHERE card = ? AND agent = ? AND project = ?")
    .get(k.card, k.agent, k.project);
  if (!r) return undefined;
  return {
    card: r.card as string,
    agent: r.agent as string,
    project: r.project as string,
    sessionId: r.session_id as string,
    model: r.model as string,
    trust: r.trust as string,
    createdAt: Number(r.created_at),
    lastUsedAt: Number(r.last_used_at),
  };
}

/** Stores the session a run ended with; a different session than before replaces it. */
export function saveCardSession(
  db: Db,
  s: CardSessionKey & { sessionId: string; model: string; trust: string },
  now = Date.now(),
): void {
  db.prepare(
    `INSERT INTO card_sessions (card, agent, project, session_id, model, trust, created_at,
       last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (card, agent, project) DO UPDATE SET
       created_at = CASE WHEN session_id = excluded.session_id THEN created_at ELSE excluded.created_at END,
       session_id = excluded.session_id, model = excluded.model, trust = excluded.trust,
       last_used_at = excluded.last_used_at`,
  ).run(s.card, s.agent, s.project, s.sessionId, s.model, s.trust, now, now);
}

export function dropCardSession(db: Db, k: CardSessionKey): void {
  db.prepare("DELETE FROM card_sessions WHERE card = ? AND agent = ? AND project = ?").run(
    k.card,
    k.agent,
    k.project,
  );
}

/** The next task of the chat took the card over: its sessions go with it (ADR-0059). */
export function carryCardSessions(db: Db, home: string, from: string, to: string): void {
  if (from === to) return;
  db.prepare("UPDATE card_sessions SET card = ? WHERE card = ?").run(to, from);
  // ADR-0067 step 4: so do its "for this card" approvals (JSON lists, merged).
  const approvals = (card: string): unknown[] =>
    JSON.parse(
      String(
        db.prepare("SELECT value FROM settings WHERE key = ?").get(`approval:${card}`)?.value ||
          "[]",
      ),
    );
  const carried = approvals(from);
  if (carried.length) {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).run(`approval:${to}`, JSON.stringify([...approvals(to), ...carried]));
    db.prepare("DELETE FROM settings WHERE key = ?").run(`approval:${from}`);
  }
  if (existsSync(sessionDir(home, from))) {
    mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
    renameSync(sessionDir(home, from), sessionDir(home, to));
  }
}

/** The card is done, archived or deleted: its records and transcripts go. */
export function endCardSessions(db: Db, home: string, cards: string[]): void {
  for (const card of cards) {
    db.prepare("DELETE FROM card_sessions WHERE card = ?").run(card);
    // ADR-0067 step 4: "for this card" approvals end with the card (done, archived, deleted).
    db.prepare("DELETE FROM settings WHERE key = ?").run(`approval:${card}`);
    rmSync(sessionDir(home, card), { recursive: true, force: true });
  }
}

/**
 * The session key of a task's card: its root. A successor (review rework, handoff) shares its
 * root with the task it continues, so it keeps the same sessions.
 */
export function cardKey(task: { id: string; rootId?: string | null }): string {
  return task.rootId ?? task.id;
}

/** The task that holds the card for a session key (the newest one with a column). */
export function cardHolder(db: Db, key: string): { id: string; column: string } | undefined {
  const row = db
    .prepare(
      "SELECT id, board_column AS col FROM tasks WHERE (id = ? OR root_id = ?) AND board_column IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(key, key);
  return row ? { id: row.id as string, column: row.col as string } : undefined;
}

/** The session keys of a chat's cards (archived or deleted with it). */
export function chatCards(db: Db, threadId: string): string[] {
  return db
    .prepare(
      "SELECT DISTINCT COALESCE(root_id, id) AS k FROM tasks WHERE thread_id = ? AND parent_id IS NULL",
    )
    .all(threadId)
    .map((r) => r.k as string);
}
