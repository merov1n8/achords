import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ModelProvider, RunRequest, RunResult, Usage } from "./types.ts";

// OpenAI models through the official `codex` CLI (ADR-0004, ADR-0040). Like cli-claude it never
// touches the CLI's login. Codex has no per-file or per-host rules: what a run may do is set by
// its sandbox (read-only or writing to its own folders) and network on/off.

export interface CliCodexOptions {
  command?: [string, ...string[]];
  env?: Record<string, string>;
}

const KILL_GRACE_MS = 3000;
const STDERR_LIMIT = 4000;
const WRITERS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);

export function cliCodex(opts: CliCodexOptions = {}): ModelProvider {
  const [bin, ...lead] = opts.command ?? ["codex"];
  return { id: "cli-codex", run: (req) => runCodex(bin, lead, req, opts) };
}

/** Sandbox from the run's tools: writing tools → its own folders writable, else read-only. */
export function codexArgs(req: RunRequest, files: { last: string; schema?: string }): string[] {
  const writes = req.tools.some((t) => WRITERS.has(t));
  // The open web only where the owner granted it (bare WebFetch rule, ADR-0035).
  const network = req.allowedTools.includes("WebFetch");
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    // No personal config, MCP servers or command rules leak into agent runs.
    "--ignore-user-config",
    "--ignore-rules",
    "-m",
    req.model,
    "-C",
    req.cwd,
    "-s",
    writes ? "workspace-write" : "read-only",
    "-c",
    'approval_policy="never"',
    "-c",
    `sandbox_workspace_write.network_access=${network}`,
    "-o",
    files.last,
  ];
  if (writes) for (const dir of req.addDirs ?? []) args.push("--add-dir", dir);
  if (files.schema) args.push("--output-schema", files.schema);
  args.push("-");
  return args;
}

const empty = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: null,
});

function runCodex(
  bin: string,
  lead: string[],
  req: RunRequest,
  opts: CliCodexOptions,
): Promise<RunResult> {
  const started = Date.now();
  // Final message and output schema as private files, never on argv.
  const dir = mkdtempSync(join(tmpdir(), "achords-codex-"));
  const files = {
    last: join(dir, "last.txt"),
    ...(req.jsonSchema ? { schema: join(dir, "schema.json") } : {}),
  };
  if (files.schema) writeFileSync(files.schema, JSON.stringify(req.jsonSchema), { mode: 0o600 });
  // Codex has no system-prompt flag: the role and rules lead the prompt.
  const prompt = req.appendSystemPrompt
    ? `${req.appendSystemPrompt}\n\n---\n\n${req.prompt}`
    : req.prompt;

  return new Promise((resolve) => {
    let usage = empty();
    let failure: string | undefined;
    let stderr = "";
    let stop: RunResult["stopReason"] | undefined;
    let settled = false;
    const child = spawn(bin, [...lead, ...codexArgs(req, files)], {
      cwd: req.cwd,
      env: { ...process.env, ...opts.env, ...req.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const finish = (r: Omit<RunResult, "durationMs" | "windows">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      rmSync(dir, { recursive: true, force: true });
      resolve({ ...r, windows: [], durationMs: Date.now() - started });
    };
    const killGroup = (reason: "timeout" | "cancelled") => {
      if (stop) return;
      stop = reason;
      const sig = (s: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, s);
        } catch {}
      };
      sig("SIGTERM");
      setTimeout(() => sig("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const onAbort = () => killGroup("cancelled");
    const timer = setTimeout(() => killGroup("timeout"), req.timeoutMs);
    if (req.signal?.aborted) onAbort();
    req.signal?.addEventListener("abort", onAbort);

    child.on("spawn", () => {
      if (child.pid) req.onSpawn?.(child.pid);
    });
    child.on("error", (err) =>
      finish({ ok: false, stopReason: "error", text: "", error: err.message, usage }),
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      if (stderr.length < STDERR_LIMIT) stderr += d.slice(0, STDERR_LIMIT - stderr.length);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (e.type === "turn.completed") {
        const u = (e.usage ?? {}) as Record<string, number>;
        usage = {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cached_input_tokens ?? 0,
          cacheWriteTokens: 0,
          costUsd: null,
        };
      }
      if (e.type === "turn.failed" || e.type === "error") {
        const msg =
          (e.error as { message?: string } | undefined)?.message ??
          (typeof e.message === "string" ? e.message : "codex error");
        failure ??= msg;
      }
    });

    child.on("close", (code) => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {}
      if (stop) {
        finish({ ok: false, stopReason: stop, text: "", error: stop, usage });
        return;
      }
      let text = "";
      try {
        text = readFileSync(files.last, "utf8").trim();
      } catch {}
      if (failure || code !== 0 || !text) {
        const error =
          failure ??
          `codex exited with exit code ${code} and no answer${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
        // Subscription limit: like a model server that is down, try again later.
        const limit = /usage limit|rate limit|try again at/i.test(error);
        finish({ ok: false, stopReason: limit ? "unavailable" : "error", text: "", error, usage });
        return;
      }
      let structured: unknown;
      if (req.jsonSchema) {
        try {
          structured = JSON.parse(text);
        } catch {
          finish({ ok: false, stopReason: "error", text, error: "answer is not JSON", usage });
          return;
        }
      }
      finish({
        ok: true,
        stopReason: "completed",
        text,
        usage,
        ...(structured !== undefined ? { structured } : {}),
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}
