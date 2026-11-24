import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_SHELL_ENV, hookedGitEnv } from "@achords/policy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The wrapper that codex and gemini runs get as core.hooksPath, with real git.
const HOOKS = fileURLToPath(new URL("../git-hooks", import.meta.url));

describe("achords' git hooks for codex and gemini runs", () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: repo,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        ...GIT_SHELL_ENV,
        ...hookedGitEnv(HOOKS),
        GIT_AUTHOR_NAME: "Owner",
        GIT_AUTHOR_EMAIL: "owner@example.com",
        GIT_COMMITTER_NAME: "Owner",
        GIT_COMMITTER_EMAIL: "owner@example.com",
      },
    });
  const hook = (dir: string, name: string, body: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  const commit = () => {
    writeFileSync(join(repo, "x.txt"), String(Math.random()));
    git("add", "x.txt");
    git(
      "commit",
      "-q",
      "-m",
      "Fix it",
      "-m",
      "Co-authored-by: Bot <bot@example.com>\nCO-AUTHORED-BY: X <x@y>",
    );
    return git("log", "-1", "--format=%B");
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "hooks-"));
    git("init", "-q");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("drops the trailer, then runs the repository's own commit-msg hook", () => {
    hook(join(repo, ".git", "hooks"), "commit-msg", 'echo "Marker: own hook" >> "$1"');
    const msg = commit();
    expect(msg).not.toMatch(/co-authored-by/i);
    expect(msg).toMatch(/^Fix it\n/);
    expect(msg).toContain("Marker: own hook");
  });

  it("follows the repository's own core.hooksPath and keeps its exit code", () => {
    git("config", "core.hooksPath", ".githooks");
    hook(join(repo, ".githooks"), "commit-msg", 'echo "Marker: custom path" >> "$1"');
    expect(commit()).toContain("Marker: custom path");
    hook(join(repo, ".githooks"), "pre-commit", "echo no >&2; exit 3");
    expect(commit).toThrow(/no/);
  });

  it("commits without a hook of the repository", () => {
    expect(commit().trim()).toBe("Fix it");
  });
});
