// ADR-0067, level 5 push: git asks a credential helper, the helper asks the gateway, and the
// gateway answers from the vault (ADR-0055's use without read). Tokens are per project; nothing
// is written to a git config file and the host's own git login is never used.
import { fitId } from "./catalog.ts";
import { historyRewrite, pushDeletes } from "./check.ts";
import type { RunMode } from "./compile.ts";
import { isSecured } from "./live.ts";
import type { AccountEntry, ProjectClass } from "./projects.ts";

/** A repository address as the project form accepts it: https, or ssh `git@host:owner/repo`. */
export const GIT_REPO =
  /^(https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w.-]+){2,}\/?|git@[a-z0-9.-]+:[\w.-]+(\/[\w.-]+)+)$/i;

/** Vault id of a project's push token (`own`: the owner's own work). */
export const gitTokenId = (project: string) => fitId(`git-token-${project}`);

/** What git hands its credential helper (`get`), with credential.useHttpPath set. */
export interface GitCredentialRequest {
  protocol?: string | undefined;
  host?: string | undefined;
  path?: string | undefined;
}

const repoPath = (p: string) =>
  p
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");

/** `host/path` of an https repository entry, or undefined (ssh and anything else). */
function httpsRepo(value: string): { host: string; path: string } | undefined {
  const v = value.trim();
  if (!GIT_REPO.test(v) || !v.startsWith("https://")) return undefined;
  const u = new URL(v);
  return { host: u.host.toLowerCase(), path: repoPath(u.pathname) };
}

/**
 * Whether the gateway answers a run's credential request: level 5, work mode, an https
 * repository of the run's project that is not `live` on a secured project. The caller then
 * resolves `vaultId` (audited with `purpose`); a missing token answers nothing either.
 */
export function gitCredentialTarget(
  run: { level: number; mode?: RunMode | undefined },
  project: {
    slug: string;
    class?: ProjectClass | undefined;
    integrationEntries: Record<string, AccountEntry[]>;
  },
  req: GitCredentialRequest,
): { ok: true; vaultId: string; purpose: string } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (run.level < 5) return no(`push needs level 5 (this run has ${run.level})`);
  if (run.mode !== "accounts") return no("push only in work mode");
  if (req.protocol !== "https") return no("only https remotes get a token");
  const host = (req.host ?? "").toLowerCase();
  const path = repoPath(req.path ?? "");
  if (!host || !path) return no("no repository named");
  const entry = (project.integrationEntries.repository ?? []).find((e) => {
    const r = httpsRepo(e.value);
    return r?.host === host && r.path === path;
  });
  if (!entry) return no(`${host}/${path} is not a repository of ${project.slug}`);
  if (entry.env === "live" && isSecured(project)) {
    return no(`${host}/${path} is live on the secured project ${project.slug}: read-only`);
  }
  return {
    ok: true,
    vaultId: gitTokenId(project.slug),
    purpose: `git:${project.slug}:${host}/${path}`,
  };
}

/**
 * The push guard of a level 5 run (a PreToolUse hook on Bash): force push and history rewrite
 * are refused; a push that deletes on the remote runs only exactly as the owner approved it.
 */
export function pushRefusal(command: string, approved: string[]): string | undefined {
  const rewrite = historyRewrite(command);
  if (rewrite) return rewrite;
  const exact = command.trim().replace(/\s+/g, " ");
  if (pushDeletes(command) && !approved.includes(exact)) {
    return "deleting on the remote asks the owner first: use request_permission with kind command and the exact command";
  }
  return undefined;
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const NODE_FLAGS = "--disable-warning=ExperimentalWarning";

/** The PreToolUse hook running the push guard (`entry`) on the run's Node. */
export function pushGuardHook(input: { node: string; entry: string; approved: string[] }) {
  const arg = Buffer.from(JSON.stringify(input.approved)).toString("base64url");
  return {
    matcher: "Bash",
    hooks: [
      {
        type: "command",
        command: `${quote(input.node)} ${NODE_FLAGS} ${quote(input.entry)} ${arg}`,
      },
    ],
  };
}

/**
 * Environment of a level 5 work-mode run: git's configuration through GIT_CONFIG_COUNT only (no
 * config file is written). The first entry empties the helper list, so a helper of the host's
 * own git configuration (a keychain login) is never asked.
 */
export function gitPushEnv(input: {
  node: string;
  helper: string;
  hubUrl: string;
  token: string;
}): Record<string, string> {
  const config: [string, string][] = [
    ["credential.helper", ""],
    ["credential.helper", `!${quote(input.node)} ${NODE_FLAGS} ${quote(input.helper)} `],
    ["credential.useHttpPath", "true"],
  ];
  return {
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(
      config.flatMap(([k, v], i) => [
        [`GIT_CONFIG_KEY_${i}`, k],
        [`GIT_CONFIG_VALUE_${i}`, v],
      ]),
    ),
    // Without an answer git fails instead of waiting for a password at a prompt.
    GIT_TERMINAL_PROMPT: "0",
    ACHORDS_HUB_URL: input.hubUrl,
    ACHORDS_GIT_TOKEN: input.token,
  };
}
