import { describe, expect, it } from "vitest";
import { openCoreDatabase } from "./db/database.ts";
import { enqueue } from "./queue.ts";
import { closeRoom, getRoom, listRooms, nextTurn, openRoom, recordTurn } from "./rooms.ts";
import { createThread, listMessages, listThreads } from "./threads.ts";

describe("agent rooms (ADR-0032)", () => {
  const setup = () => {
    const db = openCoreDatabase(":memory:");
    const opener = enqueue(db, { title: "landing page" });
    const room = openRoom(db, {
      openerTaskId: opener.id,
      openerAgentId: "dev",
      topic: "Hero copy",
      question: "Short or long headline?",
      participants: ["qa", "writer"],
      rounds: 2,
    });
    return { db, room };
  };

  it("is a hidden thread: never among the owner's chats", () => {
    const { db, room } = setup();
    createThread(db, {});
    expect(listThreads(db).map((t) => t.id)).not.toContain(room.id);
    expect(listMessages(db, room.id).map((m) => [m.author, m.content])).toEqual([
      ["dev", "Short or long headline?"],
    ]);
  });

  it("gives every participant one turn per round, in order, then ends", () => {
    const { db, room } = setup();
    const order: string[] = [];
    for (let turn = nextTurn(getRoom(db, room.id)); turn; turn = nextTurn(getRoom(db, room.id))) {
      order.push(`${turn.round}:${turn.agentId}`);
      recordTurn(db, room.id, turn.agentId, `view of ${turn.agentId}`);
    }
    expect(order).toEqual(["1:qa", "1:writer", "2:qa", "2:writer"]);
    expect(listMessages(db, room.id)).toHaveLength(5);
  });

  it("closing appends the decision and lists the room for the audit view", () => {
    const { db, room } = setup();
    closeRoom(db, room.id, "Decision: short headline.");
    expect(getRoom(db, room.id)?.closedAt).not.toBeNull();
    expect(nextTurn(getRoom(db, room.id))).toBeUndefined();
    expect(listMessages(db, room.id).at(-1)).toMatchObject({
      author: "dev",
      content: "Decision: short headline.",
    });
    expect(listRooms(db)).toEqual([
      expect.objectContaining({
        id: room.id,
        topic: "Hero copy",
        participants: ["qa", "writer"],
        turnsDone: 0,
      }),
    ]);
  });
});
