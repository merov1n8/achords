import { createHash, randomBytes } from "node:crypto";
import type { CallScope, LiveGuard } from "@achords/policy";

export interface RunIdentity {
  taskId: string;
  agentId: string;
  /** Hub tools this run may call (enforced by the MCP server and again by the gateway). */
  tools: string[];
}

export interface RunTokens {
  issue(taskId: string, agentId: string, tools: string[]): { token: string; revoke: () => void };
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
    issue(taskId, agentId, tools) {
      const token = randomBytes(32).toString("base64url");
      const key = sha256(token);
      live.set(key, { taskId, agentId, tools: [...tools] });
      return { token, revoke: () => live.delete(key) };
    },
    resolve: (token) => live.get(sha256(token)),
  };
}

/** What the launcher starts: the integration's MCP server with its resolved environment. */
export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Env var → JSON fields of a private credentials file the launcher writes (path in the var). */
  files: Record<string, Record<string, string>>;
  /** Project scope (ADR-0036): the launcher refuses calls outside the client's own values. */
  scope?: CallScope;
  /** ADR-0067: on a secured project the launcher refuses writes to live targets, for any caller. */
  live?: LiveGuard;
  /**
   * Publishing (ADR-0037): write tools of this integration. In `review` mode the launcher turns
   * a call into a publish request for the owner; in `auto` it runs it and reports it. The token
   * is a run token granting `publish:<integration>`.
   */
  publish?: {
    integration: string;
    mode: "review" | "auto";
    tools: string[];
    // ADR-0067: tools that always ask the owner, whatever the mode (live and spend below level 5).
    review?: string[];
    token: string;
  };
  /** ADR-0038: results carry third-party content; the launcher marks them as data. */
  untrusted?: string;
  /** Working folder of the server process (the run's folder). */
  cwd?: string;
  /** ADR-0050: a remote server over Streamable HTTP instead of `command` (headers resolved). */
  remote?: { url: string; headers: Record<string, string> };
}

export interface McpTickets {
  issue(launch: McpLaunch): { ticket: string; revoke: () => void };
  /** Single use: the launch (with secrets) is handed out once, then the ticket is dead. */
  redeem(ticket: string): McpLaunch | undefined;
}

/**
 * One-time tickets for integration MCP servers (ADR-0034). The per-run config file only carries a
 * ticket; the launcher trades it for the environment once, so the file never holds secrets and a
 * ticket read from it later is useless. In memory only.
 */
export function createMcpTickets(): McpTickets {
  const live = new Map<string, McpLaunch>();
  return {
    issue(launch) {
      const ticket = randomBytes(32).toString("base64url");
      const key = sha256(ticket);
      live.set(key, launch);
      return { ticket, revoke: () => live.delete(key) };
    },
    redeem(ticket) {
      const key = sha256(ticket);
      const launch = live.get(key);
      live.delete(key);
      return launch;
    },
  };
}
