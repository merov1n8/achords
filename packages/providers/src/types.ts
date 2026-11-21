/** One agent turn-loop executed by a model backend (CLI subprocess, API loop or local model). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface RunRequest {
  prompt: string;
  /** Provider-specific model name, e.g. "sonnet". */
  model: string;
  cwd: string;
  /** Built-in tools that exist for this run. Empty = none. */
  tools: string[];
  /** Tool rules that run without asking, e.g. "Read" or "Bash(git status:*)". */
  allowedTools: string[];
  /** Directories beyond cwd the tools may access (from the manifest's fs roots). */
  addDirs?: string[];
  /**
   * MCP config file for this run (the hub's own server only, ADR-0029). A file, not inline JSON:
   * it carries the run token, and argv is visible to every local user.
   */
  mcpConfigPath?: string;
  /** JSON Schema the final answer must match; the parsed value is returned as `structured`. */
  jsonSchema?: object;
  appendSystemPrompt?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** How hard the model thinks (claude --effort; codex reasoning effort, capped at high). */
  effort?: Effort;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Extra environment for the child only (broker-injected credentials). */
  env?: Record<string, string>;
  /**
   * Phase 4: who pays. "api" runs on the API key in `env` (the CLI's own login stays untouched);
   * default "subscription" runs on the CLI's login and never on a stray key.
   */
  billing?: "subscription" | "api";
  /** Called with the child PID (= its process group id) so it can be recorded for `achords kill`. */
  onSpawn?: (pid: number) => void;
  /** The agent's own checklist changed (done of total, the step in progress). */
  onProgress?: (p: RunProgress) => void;
}

export interface RunProgress {
  done: number;
  total: number;
  current?: string;
  /** The whole checklist, for a continuation note after a planned stop. */
  items?: { content: string; status: string }[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}

/** A rolling subscription window as reported by the CLI (resetsAt in epoch ms). */
export interface UsageWindow {
  kind: string;
  utilization: number;
  resetsAt: number;
  status: string;
}

export interface RunResult {
  ok: boolean;
  /** "unavailable": the backend could not be reached (e.g. local model server down); retry later. */
  stopReason: "completed" | "error" | "timeout" | "cancelled" | "unavailable";
  text: string;
  error?: string;
  usage: Usage;
  windows: UsageWindow[];
  sessionId?: string;
  structured?: unknown;
  durationMs: number;
}

export interface ModelProvider {
  readonly id: string;
  run(req: RunRequest): Promise<RunResult>;
}
