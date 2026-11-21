import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  ModelProvider,
  RunProgress,
  RunRequest,
  RunResult,
  Usage,
  UsageWindow,
} from "./types.ts";

export interface CliClaudeOptions {
  /** Executable and leading args. Default: the official `claude` binary on PATH. */
  command?: [string, ...string[]];
  /** Extra environment for every run (tests). */
  env?: Record<string, string>;
  /** Raw stream-json events, for tracing. */
  onEvent?: (event: Record<string, unknown>) => void;
}

const KILL_GRACE_MS = 3000;
const STDERR_LIMIT = 4000;

/**
 * Runs the official `claude` CLI in print mode (ADR-0004). It never reads, copies or proxies the
 * CLI's credentials: authentication stays entirely inside the binary.
 */
export function cliClaude(opts: CliClaudeOptions = {}): ModelProvider {
  const [bin, ...lead] = opts.command ?? ["claude"];
  return {
    id: "cli-claude",
    run: (req) => runOnce(bin, [...lead, ...buildArgs(req)], req, opts),
  };
}

export function buildArgs(req: RunRequest): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--model",
    req.model,
    "--tools",
    req.tools.join(","),
  ];
  if (req.allowedTools.length) args.push("--allowedTools", req.allowedTools.join(","));
  // Deny by default: no MCP servers (this also hides the user's claude.ai connectors) and no
  // user/project settings, so personal hooks and permissions do not leak into agent runs.
  args.push(
    "--strict-mcp-config",
    "--mcp-config",
    req.mcpConfigPath ?? '{"mcpServers":{}}',
    "--setting-sources",
    "",
  );
  if (req.addDirs?.length) args.push("--add-dir", ...req.addDirs);
  if (req.jsonSchema) args.push("--json-schema", JSON.stringify(req.jsonSchema));
  if (req.appendSystemPrompt) args.push("--append-system-prompt", req.appendSystemPrompt);
  if (req.maxTurns !== undefined) args.push("--max-turns", String(req.maxTurns));
  if (req.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(req.maxBudgetUsd));
  return args;
}

function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
  };
}

/** Progress from Claude Code's TodoWrite tool call: the agent's own checklist. */
function parseTodos(event: Record<string, unknown>): RunProgress | undefined {
  const content = (event.message as { content?: unknown[] } | undefined)?.content ?? [];
  const call = [...content]
    .reverse()
    .find(
      (c): c is { name: string; input: { todos?: unknown } } =>
        typeof c === "object" && c !== null && (c as { name?: unknown }).name === "TodoWrite",
    );
  const todos = Array.isArray(call?.input.todos)
    ? (call.input.todos as { status?: string; content?: string; activeForm?: string }[])
    : undefined;
  if (!todos?.length) return undefined;
  const active = todos.find((t) => t.status === "in_progress");
  return {
    done: todos.filter((t) => t.status === "completed").length,
    total: todos.length,
    items: todos.map((t) => ({
      content: String(t.content ?? "").slice(0, 200),
      status: String(t.status ?? ""),
    })),
    ...(active ? { current: String(active.activeForm ?? active.content ?? "").slice(0, 200) } : {}),
  };
}

function parseWindows(info: unknown): UsageWindow[] {
  const windows = (info as { unifiedWindows?: Record<string, Record<string, unknown>> })
    ?.unifiedWindows;
  if (!windows) return [];
  return Object.entries(windows).map(([kind, w]) => ({
    kind,
    utilization: Number(w.utilization ?? 0),
    resetsAt: Number(w.resetsAt ?? 0) * 1000,
    status: String(w.status ?? "unknown"),
  }));
}

function runOnce(
  bin: string,
  args: string[],
  req: RunRequest,
  opts: CliClaudeOptions,
): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let result: Record<string, unknown> | undefined;
    let windows: UsageWindow[] = [];
    let stderr = "";
    let stop: RunResult["stopReason"] | undefined;
    let settled = false;

    const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env, ...req.env };
    // Subscription runs never pick up an API key that happens to be in the environment.
    if (req.billing !== "api") delete env.ANTHROPIC_API_KEY;
    const child = spawn(bin, args, {
      cwd: req.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group, so timeout/cancel/`achords kill` reach the CLI's subprocesses too.
      detached: true,
    });

    const finish = (r: Omit<RunResult, "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      resolve({ ...r, durationMs: Date.now() - started });
    };

    const killGroup = (reason: "timeout" | "cancelled") => {
      if (stop) return;
      stop = reason;
      const signalGroup = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {
          // already gone
        }
      };
      signalGroup("SIGTERM");
      setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const onAbort = () => killGroup("cancelled");
    const timer = setTimeout(() => killGroup("timeout"), req.timeoutMs);
    if (req.signal?.aborted) onAbort();
    req.signal?.addEventListener("abort", onAbort);

    child.on("spawn", () => {
      if (child.pid) req.onSpawn?.(child.pid);
    });
    child.on("error", (err) =>
      finish({
        ok: false,
        stopReason: "error",
        text: "",
        error: err.message,
        usage: emptyUsage(),
        windows,
      }),
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      if (stderr.length < STDERR_LIMIT) stderr += d.slice(0, STDERR_LIMIT - stderr.length);
    });

    createInterface({ input: child.stdout }).on("line", (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof event !== "object" || event === null) return;
      opts.onEvent?.(event);
      if (event.type === "rate_limit_event") windows = parseWindows(event.rate_limit_info);
      if (event.type === "assistant" && req.onProgress) {
        const progress = parseTodos(event);
        if (progress) req.onProgress(progress);
      }
      if (event.type === "result") result = event;
    });

    child.on("close", (code) => {
      // Kill any leftovers of the group (tool subprocesses) once the CLI itself is done.
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // group already empty
      }
      if (stop) {
        finish({
          ok: false,
          stopReason: stop,
          text: "",
          error: stop,
          usage: emptyUsage(),
          windows,
        });
        return;
      }
      if (!result) {
        const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
        finish({
          ok: false,
          stopReason: "error",
          text: "",
          error: `claude exited with exit code ${code} and no result${detail}`,
          usage: emptyUsage(),
          windows,
        });
        return;
      }
      const u = (result.usage ?? {}) as Record<string, number>;
      const usage: Usage = {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
      };
      const ok = result.is_error !== true && result.subtype === "success";
      finish({
        ok,
        stopReason: ok ? "completed" : "error",
        text: typeof result.result === "string" ? result.result : "",
        ...(ok ? {} : { error: `claude reported ${String(result.subtype)}` }),
        usage,
        windows,
        ...(typeof result.session_id === "string" ? { sessionId: result.session_id } : {}),
        ...(result.structured_output !== undefined ? { structured: result.structured_output } : {}),
      });
    });

    child.stdin.on("error", () => {
      // CLI exited before reading the prompt; reported via close.
    });
    child.stdin.end(req.prompt);
  });
}
