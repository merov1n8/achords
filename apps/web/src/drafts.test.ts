import { describe, expect, it } from "vitest";
import { loadDraft, pruneDrafts, saveDraft } from "./drafts.ts";

const memory = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
    m,
  };
};

describe("chat drafts", () => {
  it("keeps unsent text per chat and clears it when empty", () => {
    const s = memory();
    saveDraft("a", "half a sentence", s);
    saveDraft("b", "other chat", s);
    expect(loadDraft("a", s)).toBe("half a sentence");
    expect(loadDraft("b", s)).toBe("other chat");
    expect(loadDraft("c", s)).toBe("");
    saveDraft("a", "   ", s);
    expect(loadDraft("a", s)).toBe("");
    expect(s.m.has("achords.draft.a")).toBe(false);
  });

  it("drops drafts older than 30 days and broken entries", () => {
    const s = memory();
    const day = 24 * 60 * 60 * 1000;
    saveDraft("old", "x", s, 0);
    saveDraft("new", "y", s, 40 * day);
    s.setItem("achords.draft.bad", "{");
    s.setItem("achords.appearance", "{}");
    pruneDrafts(s, 40 * day);
    expect(loadDraft("old", s)).toBe("");
    expect(loadDraft("new", s)).toBe("y");
    expect(s.m.has("achords.draft.bad")).toBe(false);
    expect(s.m.has("achords.appearance")).toBe(true);
  });

  it("works without storage", () => {
    expect(loadDraft("a", undefined)).toBe("");
    expect(() => saveDraft("a", "x", undefined)).not.toThrow();
  });
});
