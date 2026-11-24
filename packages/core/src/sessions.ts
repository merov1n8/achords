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
  db.prepare("UPDATE card_sessions SET card = ? WHERE card = ?").run(to, from);
  if (existsSync(sessionDir(home, from))) {
    mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
    renameSync(sessionDir(home, from), sessionDir(home, to));
  }
}

/** The card is done, archived or deleted: its records and transcripts go. */
export function endCardSessions(db: Db, home: string, cards: string[]): void {
  for (const card of cards) {
    db.prepare("DELETE FROM card_sessions WHERE card = ?").run(card);
    rmSync(sessionDir(home, card), { recursive: true, force: true });
  }
}

/** The cards of a chat (archived or deleted with it). */
export function chatCards(db: Db, threadId: string): string[] {
  return db
    .prepare("SELECT id FROM tasks WHERE thread_id = ? AND parent_id IS NULL")
    .all(threadId)
    .map((r) => r.id as string);
}
