import { describe, expect, it } from "vitest";
import { agentSummary } from "./agent-doc.ts";

describe("agentSummary", () => {
  it("is the first paragraph after the title, on one line", () => {
    expect(
      agentSummary("# Web developer\n\nBuilds client sites\nin PHP.\n\n## Does not\n- deploy"),
    ).toBe("Builds client sites in PHP.");
  });
  it("is capped and empty for an empty file", () => {
    expect(agentSummary(`# X\n\n${"a".repeat(500)}`)).toHaveLength(300);
    expect(agentSummary("")).toBe("");
  });
});
