import { randomUUID } from "node:crypto";
import { type Db, transaction } from "./db/database.ts";
import { getTask } from "./queue.ts";
import { cardHolder, cardKey } from "./sessions.ts";
import { appendMessage } from "./threads.ts";

// Agent rooms (ADR-0032): a bounded, turn-based discussion kept in a hidden thread.

/** What a room settled (ADR-0066 part 4); stored on the room and commented on the card. */
export interface RoomOutcome {
  decision: string;
  decidedBy: string;
  openPoints: string[];
}

/** Fallbacks: an outcome is never empty. */
export const NOT_STATED = "not stated";
export const ROOM_FAILED = "no decision: room failed";

export interface Room {
  id: string;
  openerTaskId: string;
  openerAgentId: string;
  topic: string;
  question: string;
  participants: string[];
  rounds: number;
  turnsDone: number;
  createdAt: number;
  closedAt: number | null;
  outcome: RoomOutcome | null;
}

const parseOutcome = (raw: unknown): RoomOutcome | null => {
  if (typeof raw !== "string") return null;
  const o = JSON.parse(raw) as { decision: string; decided_by: string; open_points: string[] };
  return { decision: o.decision, decidedBy: o.decided_by, openPoints: o.open_points };
};

const toRoom = (r: Record<string, unknown>): Room => ({
  id: r.id as string,
  openerTaskId: r.opener_task_id as string,
  openerAgentId: r.opener_agent_id as string,
  topic: r.topic as string,
  question: r.question as string,
  participants: JSON.parse(String(r.participants)) as string[],
  rounds: Number(r.rounds),
  turnsDone: Number(r.turns_done),
  createdAt: Number(r.created_at),
  closedAt: r.closed_at === null ? null : Number(r.closed_at),
  outcome: parseOutcome(r.outcome),
});

export function openRoom(
  db: Db,
  input: {
    openerTaskId: string;
    openerAgentId: string;
    topic: string;
    question: string;
    participants: string[];
    rounds: number;
  },
  now = Date.now(),
): Room {
  return transaction(db, () => {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO threads (id, title, kind, created_at, updated_at) VALUES (?, ?, 'room', ?, ?)",
    ).run(id, input.topic, now, now);
    db.prepare(
      `INSERT INTO rooms (id, opener_task_id, opener_agent_id, topic, question, participants, rounds,
         created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.openerTaskId,
      input.openerAgentId,
      input.topic,
      input.question,
      JSON.stringify(input.participants),
      input.rounds,
      now,
    );
    appendMessage(
      db,
      {
        threadId: id,
        role: "agent",
        author: input.openerAgentId,
        channel: "system",
        content: input.question,
      },
      now,
    );
    return getRoom(db, id) as Room;
  });
}

export function getRoom(db: Db, id: string): Room | undefined {
  const row = db.prepare("SELECT * FROM rooms WHERE id = ?").get(id);
  return row ? toRoom(row) : undefined;
}

export function listRooms(db: Db, limit = 100): Room[] {
  return db
    .prepare("SELECT * FROM rooms ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(limit)
    .map(toRoom);
}

/** Who speaks next (each participant once per round, in order); undefined when it is over. */
export function nextTurn(room: Room | undefined): { agentId: string; round: number } | undefined {
  if (!room || room.closedAt !== null) return undefined;
  const n = room.participants.length;
  if (room.turnsDone >= n * room.rounds) return undefined;
  return {
    agentId: room.participants[room.turnsDone % n] as string,
    round: Math.floor(room.turnsDone / n) + 1,
  };
}

export function recordTurn(
  db: Db,
  roomId: string,
  agentId: string,
  text: string,
  now = Date.now(),
): void {
  transaction(db, () => {
    appendMessage(
      db,
      { threadId: roomId, role: "agent", author: agentId, channel: "system", content: text },
      now,
    );
    db.prepare("UPDATE rooms SET turns_done = turns_done + 1 WHERE id = ?").run(roomId);
  });
}

/** The card comment for an outcome: decision, who decided, open points as a short list. */
export function outcomeText(topic: string, o: RoomOutcome): string {
  return [
    `Room outcome: ${topic}`,
    `Decision: ${o.decision}`,
    `Decided by: ${o.decidedBy}`,
    o.openPoints.length
      ? `Open points:\n${o.openPoints.map((p) => `- ${p}`).join("\n")}`
      : "Open points: none",
  ].join("\n");
}

/**
 * Ends the room with its outcome (ADR-0066 part 4): the decision is the room's closing message,
 * the outcome is stored on the room and commented on the card of the opener's root (never in a
 * chat). Blank fields fall back, so an outcome is never empty. Returns undefined when the room
 * was already closed.
 */
export function closeRoom(
  db: Db,
  roomId: string,
  input: { decision: string; decidedBy?: string; openPoints?: string[] },
  now = Date.now(),
): RoomOutcome | undefined {
  return transaction(db, () => {
    const room = getRoom(db, roomId);
    if (!room || room.closedAt !== null) return undefined;
    const outcome: RoomOutcome = {
      decision: input.decision.trim() || NOT_STATED,
      decidedBy: input.decidedBy?.trim() || room.openerAgentId,
      openPoints: (input.openPoints ?? []).map((p) => p.trim()).filter(Boolean),
    };
    appendMessage(
      db,
      {
        threadId: roomId,
        role: "agent",
        author: room.openerAgentId,
        channel: "system",
        content: outcome.decision,
      },
      now,
    );
    db.prepare("UPDATE rooms SET closed_at = ?, outcome = ? WHERE id = ?").run(
      now,
      JSON.stringify({
        decision: outcome.decision,
        decided_by: outcome.decidedBy,
        open_points: outcome.openPoints,
      }),
      roomId,
    );
    const opener = getTask(db, room.openerTaskId);
    const card = opener && cardHolder(db, cardKey(opener));
    if (card) {
      db.prepare(
        "INSERT INTO task_comments (task_id, text, author, room_id, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(card.id, outcomeText(room.topic, outcome), room.openerAgentId, roomId, now);
    }
    return outcome;
  });
}

/** Rooms a task opened that are still open (closed with its decision when it finishes). */
export function openRoomsOf(db: Db, taskId: string): Room[] {
  return db
    .prepare(
      "SELECT * FROM rooms WHERE opener_task_id = ? AND closed_at IS NULL ORDER BY created_at",
    )
    .all(taskId)
    .map(toRoom);
}

/** All rooms a task opened, for its continuation prompt. */
export function roomsOf(db: Db, taskId: string): Room[] {
  return db
    .prepare("SELECT * FROM rooms WHERE opener_task_id = ? ORDER BY created_at")
    .all(taskId)
    .map(toRoom);
}
