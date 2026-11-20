import { describe, expect, it } from "vitest";
import { allowRules } from "./permissions.ts";

describe("CLI allow rules scoped to the manifest (ADR-0010)", () => {
  it("scopes file tools to the agent's own folders instead of the whole disk", () => {
    const rules = allowRules({
      tools: ["Read", "Glob", "Grep", "Edit", "Write"],
      read: ["/srv/clients"],
      write: ["/srv/clients/site-a"],
      network: [],
      shell: [],
    });
    // A bare "Read" or "Edit" would allow every file the user can reach.
    expect(rules).not.toContain("Read");
    expect(rules).not.toContain("Edit");
    expect(rules).not.toContain("Write");
    expect(rules).toEqual([
      "Read(//srv/clients/site-a/**)",
      "Read(//srv/clients/**)",
      "Edit(//srv/clients/site-a/**)",
    ]);
  });

  it("gives no write rule without write folders and no fetch rule without allowed hosts", () => {
    expect(
      allowRules({
        tools: ["Read", "Edit", "WebFetch"],
        read: ["/a"],
        write: [],
        network: [],
        shell: [],
      }),
    ).toEqual(["Read(//a/**)"]);
  });

  it("limits WebFetch to the allowed hosts and keeps other tools as they are", () => {
    expect(
      allowRules({
        tools: ["WebFetch", "WebSearch", "Bash"],
        read: [],
        write: [],
        network: ["example.com", "api.example.com"],
        shell: ["git status"],
      }),
    ).toEqual([
      "WebFetch(domain:example.com)",
      "WebFetch(domain:api.example.com)",
      "WebSearch",
      "Bash(git status:*)",
    ]);
  });
});
