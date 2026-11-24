import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ModelProvider, RunRequest, RunResult, Usage } from "./types.ts";

// Google Gemini through the official `gemini` CLI (ADR-0004, ADR-0045, stage 1). Not run live yet
// (no Gemini account available): built from the CLI's --help and its headless documentation, and
// tested against a fake CLI. Like codex stage 1: no achords MCP tools; edits allowed only where the
// run may write, never shell commands; macOS seatbelt sandbox, network closed unless the owner
// granted the open web.

export interface CliGeminiOptions {
  command?: [string, ...string[]];
  env?: Record<string, string>;
}

const KILL_GRACE_MS = 3000;
const STDERR_LIMIT = 4000;
const WRITERS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function cliGemini(opts: CliGeminiOptions = {}): ModelProvider {
  const [bin, ...lead] = opts.command ?? ["gemini"];
  return { id: "cli-gemini", run: (req) => runGemini(bin, lead, req, opts) };
}

export function geminiArgs(req: RunRequest): string[] {
  const writes = req.tools.some((t) => WRITERS.has(t));
  const args = [
    "-m",
    req.model,
    "-o",
    "json",
    // Edit tools auto-approved where the run may write; shell commands are never approved
    // headless, so they do not run. Read-only runs use plan mode.
    "--approval-mode",
    writes ? "auto_edit" : "plan",
    "--sandbox",
    "--skip-trust",
  ];
  for (const dir of req.addDirs ?? []) args.push("--include-directories", dir);
  // The full prompt comes on stdin; -p only switches to headless mode.
  args.push("-p", "Follow the instructions above.");
  return args;
}

const empty = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: null,
});

/** Token counts from either stats layout (flat, or per model under stats.models). */
export function geminiUsage(stats: unknown): Usage {
  const u = empty();
  const s = (stats ?? {}) as Record<string, unknown>;
  const add = (t: Record<string, unknown>) => {
    u.inputTokens += Number(t.prompt ?? t.inputTokens ?? 0) || 0;
    u.outputTokens += Number(t.candidates ?? t.outputTokens ?? 0) || 0;
    u.cacheReadTokens += Number(t.cached ?? 0) || 0;
  };
  const models = s.models as Record<string, { tokens?: Record<string, unknown> }> | undefined;
  if (models) for (const m of Object.values(models)) add(m.tokens ?? {});
  else add(s);
  return u;
}

/** First JSON object in a model answer (Gemini has no schema flag). */
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the answer");
  return JSON.parse(text.slice(start, end + 1));
}

function runGemini(
  bin: string,
  lead: string[],
  req: RunRequest,
  opts: CliGeminiOptions,
): Promise<RunResult> {
  const started = Date.now();
  const network = req.allowedTools.includes("WebFetch");
  const schema = req.jsonSchema
    ? `\n\nAnswer with one JSON object only, no other text, matching this JSON Schema:\n${JSON.stringify(req.jsonSchema)}`
    : "";
  const prompt = `${req.appendSystemPrompt ? `${req.appendSystemPrompt}\n\n---\n\n` : ""}${req.prompt}${schema}`;
  return new Promise((resolve) => {
    let out = "";
    let stderr = "";
    let stop: RunResult["stopReason"] | undefined;
    let settled = false;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...opts.env,
      ...req.env,
      // Built-in macOS profile: writes only in the project folders; network per run.
      SEATBELT_PROFILE: network ? "restrictive-open" : "restrictive-closed",
    };
    // Subscription runs never pick up a stray API key.
    if (req.billing !== "api") delete env.GEMINI_API_KEY;
    const child = spawn(bin, [...lead, ...geminiArgs(req)], {
      cwd: req.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const finish = (r: Omit<RunResult, "durationMs" | "windows">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
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
      finish({ ok: false, stopReason: "error", text: "", error: err.message, usage: empty() }),
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      if (stderr.length < STDERR_LIMIT) stderr += d.slice(0, STDERR_LIMIT - stderr.length);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      out += `${line}\n`;
      req.onActivity?.();
    });
    child.on("close", (code) => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {}
      if (stop) {
        finish({ ok: false, stopReason: stop, text: "", error: stop, usage: empty() });
        return;
      }
      let body: { response?: unknown; stats?: unknown; error?: { message?: string } | string };
      try {
        body = JSON.parse(out.slice(out.indexOf("{")));
      } catch {
        const error = `gemini exited with exit code ${code} and no JSON${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
        const limit = /quota|rate limit|resource.?exhausted|429/i.test(error);
        finish({
          ok: false,
          stopReason: limit ? "unavailable" : "error",
          text: "",
          error,
          usage: empty(),
        });
        return;
      }
      const usage = geminiUsage(body.stats);
      const err = typeof body.error === "string" ? body.error : body.error?.message;
      const text = typeof body.response === "string" ? body.response.trim() : "";
      if (err || code !== 0 || !text) {
        const error = err ?? `gemini exited with exit code ${code} and no answer`;
        const limit = /quota|rate limit|resource.?exhausted|429/i.test(error);
        finish({ ok: false, stopReason: limit ? "unavailable" : "error", text, error, usage });
        return;
      }
      if (req.jsonSchema) {
        try {
          finish({ ok: true, stopReason: "completed", text, usage, structured: extractJson(text) });
        } catch (e) {
          finish({ ok: false, stopReason: "error", text, error: (e as Error).message, usage });
        }
        return;
      }
      finish({ ok: true, stopReason: "completed", text, usage });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}
