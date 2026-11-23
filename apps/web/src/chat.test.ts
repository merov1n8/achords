import { describe, expect, it } from "vitest";
import { formatTokens, formatUsd, hasOpenWork, imageParts, mention, withImages } from "./chat.ts";

describe("chat page helpers", () => {
  it("shortens token counts and formats dollars", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(48_200)).toBe("48.2k");
    expect(formatTokens(3_400_000)).toBe("3.4M");
    expect(formatUsd(0.4099)).toBe("$0.41");
    expect(formatUsd(5)).toBe("$5.00");
  });

  it("a mention goes first (the gateway only reads a leading @agent) and replaces an earlier one", () => {
    expect(mention("", "coder")).toBe("@coder ");
    expect(mention("fix the tests", "coder")).toBe("@coder fix the tests");
    expect(mention("@reviewer  fix the tests", "coder")).toBe("@coder fix the tests");
    expect(mention("@coder", "coder")).toBe("@coder ");
  });

  it("there is something to stop while an agent runs, waits or is queued", () => {
    const p = (status: "running" | "queued" | "idle" | "waiting") => ({
      participants: [{ agent: "a", name: "A", status }],
    });
    expect(hasOpenWork(p("idle"))).toBe(false);
    expect(hasOpenWork(p("queued"))).toBe(true);
    expect(hasOpenWork(p("waiting"))).toBe(true);
    expect(hasOpenWork(p("running"))).toBe(true);
  });
});

describe("images in chat messages", () => {
  it("shows this chat's images as pictures and keeps the rest as text", () => {
    const content =
      "Nézd meg\n\n[image: /Users/x/.achords/attachments/t1/a.png]\n[image: /Users/x/.achords/attachments/t2/b.png]";
    expect(imageParts(content, "t1")).toEqual({
      text: "Nézd meg\n\n[image: /Users/x/.achords/attachments/t2/b.png]",
      images: ["a.png"],
    });
    expect(imageParts("plain", "t1")).toEqual({ text: "plain", images: [] });
  });

  it("writes image lines after the text", () => {
    expect(withImages(" hi ", ["/a/1.png"])).toBe("hi\n\n[image: /a/1.png]");
    expect(withImages("", ["/a/1.png", "/a/2.gif"])).toBe("[image: /a/1.png]\n[image: /a/2.gif]");
  });
});
