import { describe, expect, it } from "vitest";
import { placeCard, takeOverCard } from "./board.ts";
import { listComments } from "./cards.ts";
import { openCoreDatabase } from "./db/database.ts";
import { enqueueChild } from "./delegation.ts";
import { enqueue } from "./queue.ts";
import {
  closeRoom,
  getRoom,
  listRooms,
  NOT_STATED,
  nextTurn,
  openRoom,
  ROOM_FAILED,
  recordTurn,
} from "./rooms.ts";
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
    return { db, room, opener };
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
    closeRoom(db, room.id, { decision: "Decision: short headline." });
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

  describe("outcome (ADR-0066 part 4)", () => {
    it("is stored on the room and commented on the opener's card, never in a chat", () => {
      const { db, room, opener } = setup();
      placeCard(db, opener.id, "in_progress", "system");
      const chat = createThread(db, {});
      closeRoom(db, room.id, {
        decision: "Short headline.",
        decidedBy: "dev and qa",
        openPoints: ["subline wording", " "],
      });
      expect(getRoom(db, room.id)?.outcome).toEqual({
        decision: "Short headline.",
        decidedBy: "dev and qa",
        openPoints: ["subline wording"],
      });
      expect(listComments(db, opener.id)).toEqual([
        expect.objectContaining({
          author: "dev",
          roomId: room.id,
          text: "Room outcome: Hero copy\nDecision: Short headline.\nDecided by: dev and qa\nOpen points:\n- subline wording",
        }),
      ]);
      expect(listMessages(db, chat.id)).toEqual([]);
    });

    it("is never empty: blank fields fall back", () => {
      const { db, room } = setup();
      closeRoom(db, room.id, { decision: "  " });
      expect(getRoom(db, room.id)?.outcome).toEqual({
        decision: NOT_STATED,
        decidedBy: "dev",
        openPoints: [],
      });
    });

    it("a failed room records no decision", () => {
      const { db, room, opener } = setup();
      placeCard(db, opener.id, "in_progress", "system");
      closeRoom(db, room.id, { decision: ROOM_FAILED, openPoints: [NOT_STATED] });
      expect(getRoom(db, room.id)?.outcome?.decision).toBe("no decision: room failed");
      expect(listComments(db, opener.id)[0]?.text).toContain("Decision: no decision: room failed");
    });

    it("a child opener's outcome lands on the root's card", () => {
      const db = openCoreDatabase(":memory:");
      const root = enqueue(db, { title: "site" });
      placeCard(db, root.id, "in_progress", "system");
      const child = enqueueChild(db, root, { title: "hero", caller: "lead" });
      const room = openRoom(db, {
        openerTaskId: child.id,
        openerAgentId: "dev",
        topic: "Hero copy",
        question: "?",
        participants: ["qa"],
        rounds: 1,
      });
      closeRoom(db, room.id, { decision: "Short." });
      expect(listComments(db, child.id)).toEqual([]);
      expect(listComments(db, root.id)).toEqual([
        expect.objectContaining({ author: "dev", roomId: room.id }),
      ]);
    });

    it("moves with the card to a successor", () => {
      const { db, room, opener } = setup();
      placeCard(db, opener.id, "in_progress", "system");
      closeRoom(db, room.id, { decision: "Short." });
      const next = enqueue(db, { title: "rework" });
      takeOverCard(db, opener.id, next.id, "in_progress", "system");
      expect(listComments(db, next.id).map((c) => c.roomId)).toEqual([room.id]);
    });

    it("closing twice keeps the first outcome", () => {
      const { db, room } = setup();
      closeRoom(db, room.id, { decision: "First." });
      expect(closeRoom(db, room.id, { decision: "Second." })).toBeUndefined();
      expect(getRoom(db, room.id)?.outcome?.decision).toBe("First.");
    });
  });
});
