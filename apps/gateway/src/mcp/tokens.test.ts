import { describe, expect, it } from "vitest";
import { createRunTokens } from "./tokens.ts";

describe("run tokens", () => {
  it("identify the task and agent of a live run and stop working when revoked", () => {
    const tokens = createRunTokens();
    const a = tokens.issue("task-1", "web-dev");
    const b = tokens.issue("task-2", "writer");
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens.resolve(a.token)).toEqual({ taskId: "task-1", agentId: "web-dev" });
    expect(tokens.resolve(b.token)?.agentId).toBe("writer");
    expect(tokens.resolve("forged")).toBeUndefined();
    a.revoke();
    expect(tokens.resolve(a.token)).toBeUndefined();
    expect(tokens.resolve(b.token)).toBeDefined();
  });
});
