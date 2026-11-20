import { describe, expect, it } from "vitest";
import { createMcpTickets, createRunTokens } from "./tokens.ts";

describe("run tokens", () => {
  it("identify the task and agent of a live run and stop working when revoked", () => {
    const tokens = createRunTokens();
    const a = tokens.issue("task-1", "web-dev", ["delegate", "ask_owner"]);
    const b = tokens.issue("task-2", "writer", ["ask_owner"]);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens.resolve(a.token)).toEqual({
      taskId: "task-1",
      agentId: "web-dev",
      tools: ["delegate", "ask_owner"],
    });
    expect(tokens.resolve(b.token)?.agentId).toBe("writer");
    expect(tokens.resolve("forged")).toBeUndefined();
    a.revoke();
    expect(tokens.resolve(a.token)).toBeUndefined();
    expect(tokens.resolve(b.token)).toBeDefined();
  });
});

describe("integration tickets (ADR-0034)", () => {
  it("hand out the launch exactly once and never after revocation", () => {
    const tickets = createMcpTickets();
    const launch = { command: "npx", args: ["x@1"], env: { TOKEN: "s3cret" }, files: {} };
    const a = tickets.issue(launch);
    expect(tickets.redeem(a.ticket)).toEqual(launch);
    expect(tickets.redeem(a.ticket)).toBeUndefined();
    const b = tickets.issue(launch);
    b.revoke();
    expect(tickets.redeem(b.ticket)).toBeUndefined();
    expect(tickets.redeem("forged")).toBeUndefined();
  });
});
