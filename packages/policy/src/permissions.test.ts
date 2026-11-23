import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { allowRules, siteOf, webFetchSettings } from "./permissions.ts";

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

  it("opens the web only for the full-access marker", () => {
    const rules = allowRules({
      tools: ["WebFetch"],
      read: [],
      write: [],
      network: ["*"],
      shell: [],
    });
    expect(rules).toEqual(["WebFetch"]);
  });

  it("a site with a path is fetched only under that path (ADR-0057)", () => {
    expect(siteOf("https://www.Beds24.com/api/")).toBe("www.beds24.com/api/");
    expect(siteOf("https://acme.example")).toBe("acme.example");
    expect(siteOf("https://acme.example/")).toBe("acme.example");
    expect(siteOf("https://acme.example/a b")).toBeUndefined();
    expect(siteOf("not a url")).toBeUndefined();
    expect(
      allowRules({
        tools: ["WebFetch"],
        read: [],
        write: [],
        network: ["www.beds24.com/api/", "acme.example"],
        shell: [],
      }),
    ).toEqual(["WebFetch(domain:www.beds24.com)", "WebFetch(domain:acme.example)"]);
    // Hosts only, or the open web: the domain rules suffice.
    expect(webFetchSettings(["acme.example"])).toBeUndefined();
    expect(webFetchSettings(["*", "www.beds24.com/api/"])).toBeUndefined();
    const settings = webFetchSettings(["www.beds24.com/api/", "acme.example"]);
    const command = JSON.parse(settings ?? "{}").hooks.PreToolUse[0].hooks[0].command as string;
    const allowed = (url: string) => {
      try {
        execFileSync("sh", ["-c", command], { input: JSON.stringify({ tool_input: { url } }) });
        return true;
      } catch {
        return false;
      }
    };
    expect(allowed("https://www.beds24.com/api/v2/bookings?x=1")).toBe(true);
    expect(allowed("https://www.beds24.com/pricing")).toBe(false);
    expect(allowed("https://www.beds24.com/api/../pricing")).toBe(false);
    expect(allowed("https://www.beds24.com/api/%2e%2e/pricing")).toBe(false);
    expect(allowed("https://acme.example/any/page")).toBe(true);
    expect(allowed("https://acme.example")).toBe(true);
    expect(allowed("https://acme.example.evil.com/")).toBe(false);
  });
});
