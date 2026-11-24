// ADR-0067, level 5 push: the agent calls the hub tool push_branch and the gateway pushes in its
// own process, with the project's token from the vault (ADR-0055's use without read). The run's
// shell never holds a push credential, and git in every shell is kept from the host's.
import { fitId } from "./catalog.ts";
import type { RunMode } from "./compile.ts";
import { isSecured } from "./live.ts";
import type { AccountEntry, ProjectClass } from "./projects.ts";

/** A repository address as the project form accepts it: https, or ssh `git@host:owner/repo`. */
export const GIT_REPO =
  /^(https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w.-]+){2,}\/?|git@[a-z0-9.-]+:[\w.-]+(\/[\w.-]+)+)$/i;

/** Vault id of a project's push token (`own`: the owner's own work). */
export const gitTokenId = (project: string) => fitId(`git-token-${project}`);

const repoPath = (p: string) =>
  p
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");

/** `host/path` of an https repository address, or undefined (ssh and anything else). */
function httpsRepo(value: string): { host: string; path: string } | undefined {
  const v = value.trim();
  if (!GIT_REPO.test(v) || !v.startsWith("https://")) return undefined;
  const u = new URL(v);
  return { host: u.host.toLowerCase(), path: repoPath(u.pathname) };
}

/**
 * A branch push_branch accepts: plain path segments of letters, digits, `.`, `_` and `-`, none
 * starting with `.` or `-`; no `+`, `:`, spaces, `..`, `@{`, or a `.lock`/`.` ending.
 */
export function validBranch(name: string): boolean {
  return (
    name.length <= 200 &&
    /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/.test(name) &&
    !name.includes("..") &&
    !/(\.lock|\.)$/.test(name) &&
    name !== "HEAD"
  );
}

/**
 * Where push_branch pushes for a run: level 5 in work mode, an https `repository` entry of the
 * run's project (with several, `remoteUrl` names one), not `live` on a secured project. The
 * caller resolves `vaultId` (audited with `purpose`); a missing token refuses as well.
 */
export function pushTarget(
  run: { level: number; mode?: RunMode | undefined },
  project: {
    slug: string;
    class?: ProjectClass | undefined;
    integrationEntries: Record<string, AccountEntry[]>;
  },
  branch: string,
  remoteUrl?: string,
): { ok: true; url: string; vaultId: string; purpose: string } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (run.level < 5) return no(`push needs level 5 (this run has ${run.level})`);
  if (run.mode !== "accounts") return no("push only in work mode");
  if (!validBranch(branch)) return no(`${JSON.stringify(branch)} is not a branch name I push`);
  const repos = (project.integrationEntries.repository ?? []).flatMap((e) => {
    const r = httpsRepo(e.value);
    return r ? [{ ...r, env: e.env, url: e.value.trim().replace(/\/+$/, "") }] : [];
  });
  if (!repos.length) return no(`${project.slug} lists no https repository`);
  let repo = repos[0];
  if (remoteUrl !== undefined) {
    const want = httpsRepo(remoteUrl);
    repo = want && repos.find((r) => r.host === want.host && r.path === want.path);
    if (!repo) return no(`${remoteUrl} is not an https repository of ${project.slug}`);
  } else if (repos.length > 1) {
    return no(
      `${project.slug} has several repositories; name one as remote_url: ${repos.map((r) => `https://${r.host}/${r.path}`).join(", ")}`,
    );
  }
  if (!repo) return no(`${project.slug} lists no https repository`);
  const where = `${repo.host}/${repo.path}`;
  if (repo.env === "live" && isSecured(project)) {
    return no(`${where} is live on the secured project ${project.slug}: read-only`);
  }
  return {
    ok: true,
    url: repo.url,
    vaultId: gitTokenId(project.slug),
    purpose: `git-push:${project.slug}:${where}:${branch}`,
  };
}

/**
 * Environment for every agent run (any level, any shell): git in the shell never asks the host's
 * credential helpers (a keychain login) or a stored credential, never prompts, and an ssh-agent
 * of the host is out of reach. The `git push` deny rules stay as defence in depth. The claude
 * CLI's scrub drops GIT_ASKPASS, SSH_ASKPASS and SSH_AUTH_SOCK before its Bash (claude 2.1.331,
 * the host's own socket with them); they stay for the other providers.
 */
export const GIT_SHELL_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/usr/bin/false",
  SSH_ASKPASS: "/usr/bin/false",
  GCM_INTERACTIVE: "never",
  SSH_AUTH_SOCK: "/dev/null",
};
