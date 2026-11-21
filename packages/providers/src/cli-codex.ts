import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ModelProvider, RunRequest, RunResult, Usage } from "./types.ts";

// OpenAI models through the official `codex` CLI (ADR-0004, ADR-0040). Like cli-claude it never
// touches the CLI's login. Codex has no per-file or per-host rules: what a run may do is set by
// its sandbox (read-only or writing to its own folders) and network on/off.

export interface CliCodexOptions {
  command?: [string, ...string[]];
  env?: Record<string, string>;
  /** Host layout for the sandbox profile (tests); defaults from this machine. */
  host?: CodexHost;
}

export interface CodexHost {
  home: string;
  /** The codex CLI's own install (it re-runs itself inside the sandbox). */
  codexPackages: string;
  /** PATH folders: tools like ffmpeg that live under home stay runnable. */
  path: string[];
}

const defaultHost = (): CodexHost => ({
  home: homedir(),
  codexPackages: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "packages"),
  path: (process.env.PATH ?? "").split(":").filter(Boolean),
});

// Values that must never appear on the command line: they reach the MCP server through the
// codex process environment (`env_vars`), and the agent's shell does not inherit them.
const SECRET_ENV = /TOKEN|TICKET|SECRET|PASSWORD|KEY/;
const toml = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(toml).join(", ")}]`
    : typeof v === "object" && v !== null
      ? `{ ${Object.entries(v)
          .map(([k, x]) => `${JSON.stringify(k)} = ${toml(x)}`)
          .join(", ")} }`
      : JSON.stringify(v);

/** Folders from the run's scoped CLI rules (ADR-0010): Read(//dir/**) and Edit(//dir/**). */
function scopedDirs(allowedTools: string[]): { read: string[]; write: string[] } {
  const pick = (tool: string) =>
    allowedTools
      .map((r) => new RegExp(`^${tool}\\(/(/.+)/\\*\\*\\)$`).exec(r)?.[1])
      .filter((d): d is string => d !== undefined);
  return { read: pick("Read"), write: pick("Edit") };
}

/**
 * Filesystem profile (ADR-0040 stage 2): the system readable, the user's home denied except the
 * run's own folders, PATH tools and codex itself; network only with the open web.
 */
export function codexProfile(req: RunRequest, host: CodexHost) {
  const writes = req.tools.some((t) => WRITERS.has(t));
  const dirs = scopedDirs(req.allowedTools);
  const fs: Record<string, "read" | "write" | "deny"> = { "/": "read", [host.home]: "deny" };
  for (const d of host.path) if (d.startsWith(`${host.home}/`)) fs[d] = "read";
  fs[host.codexPackages] = "read";
  for (const d of [req.cwd, ...dirs.read]) fs[d] = "read";
  if (writes) for (const d of [req.cwd, ...dirs.write]) fs[d] = "write";
  return { fs, network: req.allowedTools.includes("WebFetch") };
}

/** The per-run MCP servers (Claude config file shape) as codex config, secrets kept off argv. */
export function codexMcp(req: RunRequest): { args: string[]; env: Record<string, string> } {
  if (!req.mcpConfigPath) return { args: [], env: {} };
  const servers =
    (
      JSON.parse(readFileSync(req.mcpConfigPath, "utf8")) as {
        mcpServers?: Record<
          string,
          { command: string; args?: string[]; env?: Record<string, string> }
        >;
      }
    ).mcpServers ?? {};
  const args: string[] = [];
  const env: Record<string, string> = {};
  for (const [id, server] of Object.entries(servers)) {
    const inline: Record<string, string> = {};
    const forward: string[] = [];
    for (const [k, v] of Object.entries(server.env ?? {})) {
      if (!SECRET_ENV.test(k)) {
        inline[k] = v;
        continue;
      }
      // One name per server: several launchers each need their own ticket.
      const name = `${k}_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
      env[name] = v;
      inline[`${k}_VAR`] = name;
      forward.push(name);
    }
    // Only the tools this run was granted, without a prompt (the gateway decides).
    const prefix = `mcp__${id}__`;
    const tools = req.allowedTools
      .filter((r) => r.startsWith(prefix))
      .map((r) => r.slice(prefix.length));
    args.push(
      "-c",
      `mcp_servers.${id}=${toml({
        command: server.command,
        args: server.args ?? [],
        env: inline,
        env_vars: forward,
        enabled_tools: tools,
        default_tools_approval_mode: "approve",
      })}`,
    );
  }
  return { args, env };
}

const KILL_GRACE_MS = 3000;
/** API mode: the variable our provider entry reads (ACHORDS_*: hidden from the agent's shell). */
export const CODEX_API_KEY_ENV = "ACHORDS_OPENAI_API_KEY";
const STDERR_LIMIT = 4000;
const WRITERS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);

export function cliCodex(opts: CliCodexOptions = {}): ModelProvider {
  const [bin, ...lead] = opts.command ?? ["codex"];
  return { id: "cli-codex", run: (req) => runCodex(bin, lead, req, opts) };
}

/** Command line: a permissions profile instead of `-s` (which would override it). */
export function codexArgs(
  req: RunRequest,
  files: { last: string; schema?: string },
  host: CodexHost = defaultHost(),
  mcp: { args: string[]; env: Record<string, string> } = { args: [], env: {} },
): string[] {
  const profile = codexProfile(req, host);
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
    "-c",
    'approval_policy="never"',
    // Codex knows low/medium/high; the claude-only xhigh and max map to its highest.
    ...(req.effort
      ? [
          "-c",
          `model_reasoning_effort="${req.effort === "low" || req.effort === "medium" ? req.effort : "high"}"`,
        ]
      : []),
    // API mode: our own provider entry reads the key from the run's environment; the ChatGPT
    // login of the codex CLI is not touched (Phase 4).
    ...(req.billing === "api"
      ? [
          "-c",
          'model_provider="achords-openai"',
          "-c",
          `model_providers.achords-openai=${toml({
            name: "OpenAI API (achords)",
            base_url: "https://api.openai.com/v1",
            env_key: CODEX_API_KEY_ENV,
            wire_api: "responses",
          })}`,
        ]
      : []),
    "-c",
    'default_permissions="achords"',
    "-c",
    `permissions.achords.filesystem=${toml(profile.fs)}`,
    "-c",
    `permissions.achords.network.enabled=${profile.network}`,
    // The agent's shell never sees achords tokens or tickets, whatever their name.
    "-c",
    `shell_environment_policy.exclude=${toml(["ACHORDS_*", ...Object.keys(mcp.env)])}`,
    ...mcp.args,
    "-o",
    files.last,
  ];
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
    let mcp: { args: string[]; env: Record<string, string> };
    try {
      mcp = codexMcp(req);
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      resolve({
        ok: false,
        stopReason: "error",
        text: "",
        error: `MCP config: ${(err as Error).message}`,
        usage: empty(),
        windows: [],
        durationMs: Date.now() - started,
      });
      return;
    }
    const child = spawn(bin, [...lead, ...codexArgs(req, files, opts.host ?? defaultHost(), mcp)], {
      cwd: req.cwd,
      env: { ...process.env, ...opts.env, ...req.env, ...mcp.env },
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
