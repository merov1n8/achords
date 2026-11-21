// Auto-update from the public main branch (owner decision 2026-11-21): no signing ceremony.
// A newer origin/main that is a fast-forward and green on GitHub CI is pulled at the next idle
// moment, installed, built and self-tested; the gateway then exits so launchd starts the new
// code. Anything failing before that rolls back to the previous commit.

import type { Db } from "@achords/core";
import { getSetting, setSetting } from "@achords/core";

export const AUTO_KEY = "update.auto"; // "0" = off; default on
export const LAST_KEY = "update.last"; // JSON {at, ok, text}
export const PENDING_KEY = "update.pending"; // JSON {prev, next, summary}: restart in progress
export const READY_KEY = "update.ready"; // JSON {sha, summary}: found, waiting for idle
export const FAILED_KEY = "update.failed"; // sha whose update failed: not retried by itself
export const CHECK_EVERY_MS = 60 * 60_000;
/** Exit code that asks launchd for a restart (KeepAlive respawns non-zero exits only). */
export const UPDATE_EXIT = 75;

export type Exec = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<{ code: number; out: string }>;

export interface UpdaterDeps {
  db: Db;
  repo: string;
  exec: Exec;
  pnpm: string;
  node: string;
  fetchJson: (url: string) => Promise<unknown>;
  isIdle: () => boolean;
  notify: (text: string) => void;
  exit: (code: number) => void;
  now?: () => number;
  /** Commit the running gateway was started from (the checkout may have moved since). */
  running?: string | undefined;
  /** Gateway log (diagnosis only; never sent to the owner). */
  log?: (line: string) => void;
}

export type CheckResult =
  | { status: "current"; sha: string }
  | { status: "available"; sha: string; summary: string }
  | { status: "waiting"; reason: string }
  | { status: "blocked"; reason: string };

export const autoUpdate = (db: Db) => getSetting(db, AUTO_KEY) !== "0";

function record(deps: UpdaterDeps, ok: boolean, text: string) {
  setSetting(deps.db, LAST_KEY, JSON.stringify({ at: deps.now?.() ?? Date.now(), ok, text }));
}

const git = async (deps: UpdaterDeps, ...args: string[]) => {
  const r = await deps.exec("git", ["-C", deps.repo, ...args]);
  return { ...r, out: r.out.trim() };
};

/** "owner/repo" of a GitHub remote, or undefined. */
export function githubRepo(remote: string): string | undefined {
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote.trim())?.[1];
}

export async function checkForUpdate(deps: UpdaterDeps): Promise<CheckResult> {
  const branch = await git(deps, "symbolic-ref", "--short", "HEAD");
  if (branch.code !== 0 || branch.out !== "main") {
    return {
      status: "blocked",
      reason: `the checkout is on ${branch.out || "a detached commit"}, not main`,
    };
  }
  const dirty = await git(deps, "status", "--porcelain", "--untracked-files=no");
  if (dirty.out) return { status: "blocked", reason: "the checkout has local changes" };
  const fetched = await git(deps, "fetch", "--quiet", "origin", "main");
  if (fetched.code !== 0) return { status: "waiting", reason: "git fetch failed (offline?)" };
  const head = (await git(deps, "rev-parse", "HEAD")).out;
  const remote = (await git(deps, "rev-parse", "origin/main")).out;
  if (head === remote) {
    // Pulled by hand (or by an earlier update that did not restart): run what is checked out.
    if (deps.running && deps.running !== head) {
      const summary = (await git(deps, "log", "--format=%s", "-n", "5", `${deps.running}..HEAD`))
        .out;
      return { status: "available", sha: head, summary };
    }
    return { status: "current", sha: head };
  }
  const ff = await git(deps, "merge-base", "--is-ancestor", "HEAD", "origin/main");
  if (ff.code !== 0)
    return { status: "blocked", reason: "origin/main is not a fast-forward of this checkout" };
  // Only commits that passed CI: GitHub shows check runs of public repos without a token.
  const slug = githubRepo((await git(deps, "remote", "get-url", "origin")).out);
  if (!slug) return { status: "blocked", reason: "origin is not a GitHub repository" };
  let runs: { status?: string; conclusion?: string | null }[];
  try {
    const body = (await deps.fetchJson(
      `https://api.github.com/repos/${slug}/commits/${remote}/check-runs?per_page=100`,
    )) as { check_runs?: { status?: string; conclusion?: string | null }[] };
    runs = body.check_runs ?? [];
  } catch {
    return { status: "waiting", reason: "GitHub could not be reached" };
  }
  if (!runs.length || runs.some((r) => r.status !== "completed")) {
    return { status: "waiting", reason: "CI has not finished for the new commit" };
  }
  if (runs.some((r) => !["success", "skipped", "neutral"].includes(String(r.conclusion)))) {
    return { status: "blocked", reason: "CI failed for the new commit" };
  }
  const summary = (await git(deps, "log", "--format=%s", "-n", "5", "HEAD..origin/main")).out;
  return { status: "available", sha: remote, summary };
}

/** Pull, install, build, self-test; on success exit for a restart, else roll back. */
export async function applyUpdate(
  deps: UpdaterDeps,
  sha: string,
  summary: string,
): Promise<{ ok: boolean; text: string }> {
  // Roll back to what was running, not to an untested checkout state.
  const prev = deps.running ?? (await git(deps, "rev-parse", "HEAD")).out;
  const steps: [string, string[], number][] = [
    ["git", ["-C", deps.repo, "merge", "--ff-only", "--quiet", sha], 60_000],
    [deps.pnpm, ["--dir", deps.repo, "install", "--frozen-lockfile"], 600_000],
    [deps.pnpm, ["--dir", deps.repo, "build"], 600_000],
    // Loads the new gateway code without starting it: import errors show up here, not in a loop.
    [
      deps.node,
      [
        "--disable-warning=ExperimentalWarning",
        `${deps.repo}/apps/gateway/src/main.ts`,
        "--self-test",
      ],
      60_000,
    ],
  ];
  for (const [cmd, args, timeoutMs] of steps) {
    const r = await deps.exec(cmd, args, { timeoutMs });
    if (r.code !== 0) {
      const step =
        `${cmd.split("/").at(-1)} ${args.find((a) => !a.startsWith("-") && a !== deps.repo) ?? ""}`.trim();
      deps.log?.(`update: ${step} failed (exit ${r.code}):\n${r.out.trim().split("\n").slice(-20).join("\n")}`);
      // Once per commit: idle ticks come every few seconds, and the same commit would fail again.
      setSetting(deps.db, READY_KEY, "");
      setSetting(deps.db, FAILED_KEY, sha);
      await rollback(deps, prev);
      const text = `update to ${sha.slice(0, 7)} failed at "${step}"; stayed on ${prev.slice(0, 7)}`;
      record(deps, false, text);
      deps.notify(`⚠️ achords ${text}.`);
      return { ok: false, text };
    }
  }
  setSetting(deps.db, PENDING_KEY, JSON.stringify({ prev, next: sha, summary }));
  setSetting(deps.db, READY_KEY, "");
  setSetting(deps.db, FAILED_KEY, "");
  deps.exit(UPDATE_EXIT);
  return { ok: true, text: `updated to ${sha.slice(0, 7)}` };
}

export async function rollback(deps: Pick<UpdaterDeps, "exec" | "repo" | "pnpm">, prev: string) {
  await deps.exec("git", ["-C", deps.repo, "reset", "--hard", "--quiet", prev]);
  await deps.exec(deps.pnpm, ["--dir", deps.repo, "install", "--frozen-lockfile"], {
    timeoutMs: 600_000,
  });
  await deps.exec(deps.pnpm, ["--dir", deps.repo, "build"], { timeoutMs: 600_000 });
}

/** After a restart: tell the owner what changed (the new code is running). */
export function reportAfterRestart(deps: Pick<UpdaterDeps, "db" | "notify" | "now">) {
  const raw = getSetting(deps.db, PENDING_KEY);
  if (!raw) return;
  setSetting(deps.db, PENDING_KEY, "");
  const p = JSON.parse(raw) as { next: string; summary: string };
  const lines = p.summary.split("\n").filter(Boolean).slice(0, 5);
  const text = `updated to ${p.next.slice(0, 7)}`;
  setSetting(deps.db, LAST_KEY, JSON.stringify({ at: deps.now?.() ?? Date.now(), ok: true, text }));
  deps.notify(`✅ achords ${text}:\n${lines.map((l) => `- ${l}`).join("\n")}`);
}

/**
 * One tick: check at most hourly (or when asked), and apply a ready update once idle.
 * Returns the last check result when a check ran.
 */
export async function updateTick(
  deps: UpdaterDeps,
  force = false,
): Promise<CheckResult | undefined> {
  const now = deps.now?.() ?? Date.now();
  let result: CheckResult | undefined;
  const due = Number(getSetting(deps.db, "update.next_check") ?? 0) <= now;
  if (force || (autoUpdate(deps.db) && due)) {
    setSetting(deps.db, "update.next_check", String(now + CHECK_EVERY_MS));
    result = await checkForUpdate(deps);
    setSetting(deps.db, "update.check", JSON.stringify({ at: now, ...result }));
    // A commit that already failed is retried only on "Check now" (or when a newer one lands).
    if (result.status === "available" && (force || getSetting(deps.db, FAILED_KEY) !== result.sha)) {
      setSetting(deps.db, READY_KEY, JSON.stringify({ sha: result.sha, summary: result.summary }));
    }
  }
  const ready = getSetting(deps.db, READY_KEY);
  if (ready && autoUpdate(deps.db) && deps.isIdle()) {
    const r = JSON.parse(ready) as { sha: string; summary: string };
    await applyUpdate(deps, r.sha, r.summary);
  }
  return result;
}
