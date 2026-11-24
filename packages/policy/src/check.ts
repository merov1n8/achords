import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Manifest } from "./manifest.ts";

export interface Decision {
  allowed: boolean;
  reason: string;
}

const allow = (reason: string): Decision => ({ allowed: true, reason });
const deny = (reason: string): Decision => ({ allowed: false, reason });

export function checkTool(m: Manifest, tool: string): Decision {
  return m.tools.includes(tool)
    ? allow(`tool ${tool} allowed`)
    : deny(`tool ${tool} not in allow-list`);
}

export function checkMcp(m: Manifest, server: string): Decision {
  return m.mcp.includes(server)
    ? allow(`mcp ${server} allowed`)
    : deny(`mcp ${server} not in allow-list`);
}

export const isLocalModel = (model: string) => /^local(-[a-z0-9-]+)?\//.test(model);

/**
 * ADR-0051: an Apple container has only the claude CLI and its token; codex and gemini cannot
 * sign in there yet. Local models get no tools, so they never use the container.
 */
export function containerModelProblem(m: Manifest): string | undefined {
  const model = m.models.default;
  if (!m.container || model.startsWith("cli-claude/") || isLocalModel(model)) return undefined;
  const maker = model.startsWith("cli-codex/")
    ? "OpenAI"
    : model.startsWith("cli-gemini/")
      ? "Gemini"
      : model;
  return `${m.id} runs in an Apple container, where only Claude models work for now (${maker} cannot sign in there yet). Choose a Claude model as its default model, or switch its container off.`;
}

/**
 * Model choice. `local-only` (on the agent or on the data) restricts to local models and never
 * falls back to a frontier model (ADR-0007): the caller waits instead.
 */
export function checkModel(
  m: Manifest,
  model: string,
  ctx: { dataSensitivity?: "normal" | "local-only" } = {},
): Decision {
  if (!m.models.allowed.includes(model)) return deny(`model ${model} not in allow-list`);
  if (m.sensitivity === "local-only" && !isLocalModel(model)) {
    return deny(`agent is local-only; ${model} is not a local model`);
  }
  if (ctx.dataSensitivity === "local-only" && !isLocalModel(model)) {
    return deny(`data is local-only; ${model} is not a local model`);
  }
  return allow(`model ${model} allowed`);
}

export function checkNetwork(m: Manifest, host: string): Decision {
  const h = host.toLowerCase();
  const ok = m.network.allow.some(
    (d) => h === d.toLowerCase() || h.endsWith(`.${d.toLowerCase()}`),
  );
  return ok ? allow(`host ${host} allowed`) : deny(`host ${host} not in allow-list`);
}

export function publishMode(m: Manifest, channel: string): "review" | "auto" {
  return m.publish_mode.channels[channel] ?? m.publish_mode.default;
}

export type ShellDecision = { decision: "allow" | "approval" | "deny"; reason: string };

// Anything that could chain, substitute, redirect or span lines disqualifies auto-allow.
const SHELL_META = /[;&|`$<>(){}\n\r\\*?[\]!~]/;

const tokens = (cmd: string) => cmd.trim().split(/\s+/).filter(Boolean);

const FORCE_FLAG = /^(-f|--force|--force-with-lease(=.*)?|--mirror)$/;

/**
 * ADR-0067: force push and history rewrite are refused at every level, under every approval.
 * Returns the reason, or undefined.
 */
export function historyRewrite(command: string): string | undefined {
  const argv = tokens(command);
  const git = argv.indexOf("git");
  if (git < 0) return undefined;
  const sub = argv[git + 1];
  if (sub === "filter-branch" || sub === "filter-repo") return `git ${sub} rewrites history`;
  if (sub === "push" && argv.slice(git + 2).some((a) => FORCE_FLAG.test(a)))
    return "force push is refused at every level";
  return undefined;
}

/** Allow-listed commands run directly (extra arguments allowed); everything else needs approval. */
export function checkShell(m: Manifest, command: string): ShellDecision {
  if (!m.shell) return { decision: "deny", reason: "agent has no shell access" };
  const rewrite = historyRewrite(command);
  if (rewrite) return { decision: "deny", reason: rewrite };
  if (SHELL_META.test(command)) {
    return { decision: "approval", reason: "shell metacharacters need approval" };
  }
  const argv = tokens(command);
  const hit = m.shell.allow.find((entry) => {
    const prefix = tokens(entry);
    return prefix.length > 0 && prefix.every((t, i) => argv[i] === t);
  });
  return hit
    ? { decision: "allow", reason: `matches allow-list entry "${hit}"` }
    : { decision: "approval", reason: "not in shell allow-list" };
}

const expandHome = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/**
 * Resolves symlinks in the longest existing prefix, so a link inside an allowed root cannot point
 * outside it. Non-existent tails (files about to be created) are appended unresolved.
 */
function canonical(p: string): string {
  let head = resolve(expandHome(p));
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(basename(head));
    head = parent;
  }
  return join(realpathSync(head), ...tail);
}

const within = (path: string, root: string) => path === root || path.startsWith(root + sep);

/** Write access implies read access. */
export function checkFs(m: Manifest, path: string, mode: "read" | "write"): Decision {
  if (!isAbsolute(path)) return deny(`relative path ${path}`);
  const target = canonical(path);
  const roots = mode === "write" ? m.fs.write : [...m.fs.read, ...m.fs.write];
  const root = roots.find((r) => within(target, canonical(r)));
  return root ? allow(`${mode} inside ${root}`) : deny(`${mode} outside allowed paths: ${path}`);
}
