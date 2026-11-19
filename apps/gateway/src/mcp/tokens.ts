import { createHash, randomBytes } from "node:crypto";

export interface RunIdentity {
  taskId: string;
  agentId: string;
}

export interface RunTokens {
  issue(taskId: string, agentId: string): { token: string; revoke: () => void };
  resolve(token: string): RunIdentity | undefined;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Capability tokens for agent runs (ADR-0029): the only way the hub MCP server proves who is
 * calling. In memory (hashed), valid for one run; a gateway restart invalidates all of them.
 */
export function createRunTokens(): RunTokens {
  const live = new Map<string, RunIdentity>();
  return {
    issue(taskId, agentId) {
      const token = randomBytes(32).toString("base64url");
      const key = sha256(token);
      live.set(key, { taskId, agentId });
      return { token, revoke: () => live.delete(key) };
    },
    resolve: (token) => live.get(sha256(token)),
  };
}
