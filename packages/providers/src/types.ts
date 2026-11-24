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
  /** Extra CLI settings as JSON (claude --settings), e.g. the WebFetch path hook (ADR-0057). */
  settings?: string;
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
  /**
   * ADR-0051: run the CLI inside an Apple container (Linux VM) instead of on the host. The CLI's
   * arguments stay identical; only the listed folders exist inside, at the same paths.
   */
  container?: ContainerSpec;
  /**
   * ADR-0066: keep the CLI session (the config folder comes in `env` as CLAUDE_CONFIG_DIR) and
   * continue `resume` when set. Without it the run leaves no session behind.
   */
  session?: { resume?: string };
  /** Called with the child PID (= its process group id) so it can be recorded for `achords kill`. */
  onSpawn?: (pid: number) => void;
  /** The agent's own checklist changed (done of total, the step in progress). */
  onProgress?: (p: RunProgress) => void;
  /** ADR-0066: the run sent a stream event (the stall watcher's sign of life). */
  onActivity?: () => void;
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
  /** The CLI did not find the session to resume (ADR-0066): run again with a fresh prompt. */
  resumeRejected?: boolean;
  structured?: unknown;
  durationMs: number;
}

export interface ModelProvider {
  readonly id: string;
  run(req: RunRequest): Promise<RunResult>;
}

/** One run's Apple container (ADR-0051). */
export interface ContainerSpec {
  /** The `container` binary. */
  bin: string;
  /** Unique per run; `container kill <name>` stops it. */
  name: string;
  image: string;
  /** Host folders shared at the same path inside; nothing else of the host is visible. */
  mounts: { path: string; readonly: boolean }[];
  cpus?: number;
  /** e.g. "4G". */
  memory?: string;
}
