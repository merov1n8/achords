import { describe, expect, it } from "vitest";
import { attention, replyState, withCount } from "./alerts.ts";

const th = (id: string, lastAgentSeq: number | null) => ({ id, lastAgentSeq });

describe("reply alerts", () => {
  it("first look: nothing is unread and nothing chimes", () => {
    const r = replyState([th("a", 5), th("b", null)], undefined, undefined, false);
    expect(r).toEqual({ seen: { a: 5, b: 0 }, max: 5, unread: 0, chime: false });
  });

  it("a new reply chimes once and counts until its chat is open in a visible tab", () => {
    const first = replyState([th("a", 5), th("b", null)], undefined, undefined, false);
    const now = [th("a", 9), th("b", 3)];
    const hidden = replyState(now, first, undefined, false);
    expect(hidden).toMatchObject({ unread: 2, chime: true, max: 9 });
    expect(replyState(now, hidden, undefined, false)).toMatchObject({ unread: 2, chime: false });
    // Open, but the tab is in the background: not read yet.
    expect(replyState(now, hidden, "b", false).unread).toBe(2);
    const open = replyState(now, hidden, "a", true);
    expect(open).toMatchObject({ seen: { a: 9, b: 0 }, unread: 1, chime: false });
  });

  it("the count reads the same in the tab title and in the menu, and is left out at zero", () => {
    expect(withCount("Achords", 2)).toBe("Achords (2)");
    expect(withCount("Chat", 2)).toBe("Chat (2)");
    expect(withCount("Chat", 0)).toBe("Chat");
  });

  it("a chat made after the first look counts from its first reply", () => {
    const first = replyState([th("a", 5)], undefined, undefined, false);
    expect(replyState([th("a", 5), th("new", 7)], first, undefined, false)).toMatchObject({
      unread: 1,
      chime: true,
    });
  });

  it("the open chat's own reply chimes too, but is not counted", () => {
    const first = replyState([th("a", 5)], undefined, "a", true);
    expect(replyState([th("a", 6)], first, "a", true)).toMatchObject({
      seen: { a: 6 },
      unread: 0,
      chime: true,
    });
  });

  it("after a reload the saved marks still count what came meanwhile", () => {
    const r = replyState([th("a", 8)], { seen: { a: 5 } }, undefined, false);
    expect(r).toMatchObject({ unread: 1, chime: false, max: 8 });
  });

  it("a chat asks for attention while a reply is unread, with a badge when it waits for the owner", () => {
    const chat = (lastAgentSeq: number | null, waitingOwner = false) => ({
      id: "a",
      lastAgentSeq,
      waitingOwner,
    });
    expect(attention(chat(5), { a: 3 }, undefined)).toBe("unread");
    expect(attention(chat(5, true), { a: 3 }, undefined)).toBe("waiting");
    // Opening it marks it read: an open question alone does not bring the badge back...
    expect(attention(chat(5, true), { a: 5 }, undefined)).toBeUndefined();
    expect(attention(chat(5, true), { a: 3 }, "a")).toBeUndefined();
    // ...a new question or approval (a new agent message) does.
    expect(attention(chat(6, true), { a: 5 }, undefined)).toBe("waiting");
    // Never looked at, or no reply yet: nothing to mark.
    expect(attention(chat(5, true), undefined, undefined)).toBeUndefined();
    expect(attention(chat(null), { a: 0 }, undefined)).toBeUndefined();
  });
});
