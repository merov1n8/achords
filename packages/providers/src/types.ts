/** One agent turn-loop executed by a model backend (CLI subprocess, API loop or local model). */
export interface RunRequest {
  prompt: string;
  /** Provider-specific model name, e.g. "sonnet". */
  model: string;
  cwd: string;
  /** Built-in tools that exist for this run. Empty = none. */
  tools: string[];
  /** Tool rules that run without asking, e.g. "Read" or "Bash(git status:*)". */
  allowedTools: string[];
  appendSystemPrompt?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Extra environment for the child only (broker-injected credentials). */
  env?: Record<string, string>;
  /** Called with the child PID (= its process group id) so it can be recorded for `achords kill`. */
  onSpawn?: (pid: number) => void;
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
  stopReason: "completed" | "error" | "timeout" | "cancelled";
  text: string;
  error?: string;
  usage: Usage;
  windows: UsageWindow[];
  sessionId?: string;
  durationMs: number;
}

export interface ModelProvider {
  readonly id: string;
  run(req: RunRequest): Promise<RunResult>;
}
