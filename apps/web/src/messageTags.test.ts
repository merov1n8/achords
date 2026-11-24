import { describe, expect, it } from "vitest";
import { t } from "./i18n.ts";
import { messageTags } from "./messageTags.ts";

// The messages are built from the shared catalog, so a wording change there fails here.
const agent = (author: string, content: string) => ({ role: "agent" as const, author, content });

describe("messageTags", () => {
  it("a report drops its 'Done (agent):' lead-in for a Done tag", () => {
    const content = t("thread.done", { agent: "web-dev", title: "Login page", result: "Built." });
    expect(messageTags(agent("web-dev", content))).toEqual({
      agent: "web-dev",
      kind: "done",
      content: "Login page\n\nBuilt.",
    });
  });

  it("a review drops its 'Review (agent):' lead-in", () => {
    const content = t("thread.reviewed", { agent: "code-reviewer", title: "Login", result: "OK" });
    expect(messageTags(agent("code-reviewer", content))).toEqual({
      agent: "code-reviewer",
      kind: "review",
      content: "Login\n\nOK",
    });
  });

  it("a question keeps its card title, not the agent's name", () => {
    const content = t("thread.question", {
      agent: "game-dev",
      title: "Level 3 (boss fight)",
      question: "Which colours?",
    });
    expect(messageTags(agent("game-dev", content))).toEqual({
      agent: "game-dev",
      kind: "question",
      content: "Level 3 (boss fight): Which colours?",
    });
  });

  it("a command request keeps the card title and the command", () => {
    const content = t("thread.commandRequest", {
      agent: "web-dev",
      title: "Deploy",
      command: "npm publish",
      reason: "release",
    });
    const tags = messageTags(agent("web-dev", content));
    expect(tags.kind).toBe("command");
    expect(tags.agent).toBe("web-dev");
    expect(tags.content.startsWith("Deploy:\nnpm publish\nWhy: release\n")).toBe(true);
  });

  it("a new skill and a skill change get their own tags", () => {
    const vars = { agent: "code-reviewer", name: "lint", workspace: "web-clients" };
    const created = t("thread.skillNew", {
      ...vars,
      description: "Runs the linter",
      reason: "often needed",
      source: "",
      preview: "# Lint",
    });
    const tagsNew = messageTags(agent("code-reviewer", created));
    expect(tagsNew.kind).toBe("skillNew");
    expect(tagsNew.content.startsWith('"lint" for web-clients: Runs the linter')).toBe(true);

    const changed = t("thread.skillChange", {
      ...vars,
      reason: "clearer",
      rename: "",
      descriptionChange: "",
      source: "",
      before: "a",
      after: "b",
    });
    const tagsChange = messageTags(agent("code-reviewer", changed));
    expect(tagsChange.kind).toBe("skillChange");
    expect(tagsChange.content.startsWith('"lint" (web-clients): clearer')).toBe(true);
  });

  it("a plain agent reply is tagged with its author and left as written", () => {
    expect(messageTags(agent("boss", "Done (web-dev): on it"))).toEqual({
      agent: "boss",
      kind: null,
      content: "Done (web-dev): on it",
    });
    expect(messageTags({ role: "system", author: null, content: "Hi" })).toEqual({
      agent: "system",
      kind: null,
      content: "Hi",
    });
  });

  it("the owner's own messages get no tag", () => {
    expect(messageTags({ role: "user", author: "owner", content: "Done (web-dev): x" })).toEqual({
      agent: null,
      kind: null,
      content: "Done (web-dev): x",
    });
  });
});
