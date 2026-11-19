import { describe, expect, it } from "vitest";
import { setLanguage, t } from "./index.ts";

describe("t", () => {
  it("fills placeholders and keeps unknown ones visible", () => {
    expect(t("action.approved", { agent: "tester" })).toBe("Approved: agent tester.");
    expect(t("thread.done", { title: "X" })).toBe("Done: X\n\n{result}");
  });

  it("falls back to English for unknown languages and keys", () => {
    setLanguage("xx");
    expect(t("nav.chat")).toBe("Chat");
    expect(t("no.such.key")).toBe("no.such.key");
    setLanguage("en");
  });
});
