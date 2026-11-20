import { randomUUID } from "node:crypto";
import { type Db, transaction } from "./db/database.ts";
import { appendMessage } from "./threads.ts";

// Agent rooms (ADR-0032): a bounded, turn-based discussion kept in a hidden thread.

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
}

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

/** Ends the room; the opener's decision (if any) is its closing message. */
export function closeRoom(db: Db, roomId: string, decision?: string, now = Date.now()): void {
  transaction(db, () => {
    const room = getRoom(db, roomId);
    if (!room || room.closedAt !== null) return;
    if (decision) {
      appendMessage(
        db,
        {
          threadId: roomId,
          role: "agent",
          author: room.openerAgentId,
          channel: "system",
          content: decision,
        },
        now,
      );
    }
    db.prepare("UPDATE rooms SET closed_at = ? WHERE id = ?").run(now, roomId);
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
