import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pushBranch } from "./git-push.ts";

const TOKEN = "ghp_push-token-value-123";

describe("push_branch plumbing (ADR-0067 level 5)", () => {
  let root: string;
  let agentRepo: string;
  let remote: string;
  let tmpRoot: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), file);
    git(cwd, "add", file);
    git(cwd, "commit", "-q", "-m", file);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "achords-push-"));
    agentRepo = join(root, "work");
    remote = join(root, "remote.git");
    tmpRoot = join(root, "gateway-run");
    mkdirSync(agentRepo);
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    git(agentRepo, "init", "-q", "-b", "main");
    commit(agentRepo, "a.txt");
    git(agentRepo, "push", "-q", remote, "main");
    git(agentRepo, "checkout", "-q", "-b", "feature/x");
    commit(agentRepo, "b.txt");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const push = (branch: string, url = `file://${remote}`, extra = {}) =>
    pushBranch({ folder: agentRepo, branch, url, token: TOKEN, tmpRoot, ...extra });

  it("pushes the branch fast-forward and leaves no temporary repository", async () => {
    const out = await push("feature/x");
    expect(out).toEqual({ ok: true, text: "Pushed feature/x to the project's repository." });
    expect(git(remote, "rev-parse", "feature/x")).toBe(git(agentRepo, "rev-parse", "feature/x"));
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect((await push("feature/x")).text).toMatch(/already up to date/);
  });

  it("a non-fast-forward is rejected by the remote, which stays as it was", async () => {
    // Someone else moved main on the remote.
    const other = join(root, "other");
    git(root, "clone", "-q", remote, other);
    commit(other, "c.txt");
    git(other, "push", "-q", "origin", "main");
    const before = git(remote, "rev-parse", "main");
    commit(agentRepo, "d.txt");
    git(agentRepo, "checkout", "-q", "main");
    commit(agentRepo, "e.txt");
    expect(await push("main")).toEqual({
      ok: false,
      text: "rejected: the remote has changes you don't have; fetch and rebase",
    });
    expect(git(remote, "rev-parse", "main")).toBe(before);
  });

  it("a branch the folder does not have is a failure, never a deletion", async () => {
    git(agentRepo, "push", "-q", remote, "feature/x");
    const out = await push("gone");
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/no branch gone/);
    expect(git(remote, "branch", "--list", "feature/x")).toContain("feature/x");
  });

  it("the agent repo's hooks, url rewrites and mirror setting never run or apply", async () => {
    const decoy = join(root, "decoy.git");
    git(root, "init", "-q", "--bare", decoy);
    const marker = join(root, "hook-ran");
    const hook = `#!/bin/sh\ntouch ${marker}\n`;
    const hooks = join(root, "evil-hooks");
    mkdirSync(hooks);
    for (const name of ["pre-push", "post-checkout", "reference-transaction", "post-update"]) {
      writeFileSync(join(hooks, name), hook, { mode: 0o755 });
      writeFileSync(join(agentRepo, ".git", "hooks", name), hook, { mode: 0o755 });
    }
    git(agentRepo, "config", "core.hooksPath", hooks);
    git(agentRepo, "config", "core.fsmonitor", join(hooks, "pre-push"));
    git(agentRepo, "config", "uploadpack.packObjectsHook", join(hooks, "pre-push"));
    git(agentRepo, "config", `url.file://${decoy}.insteadOf`, `file://${remote}`);
    git(agentRepo, "config", "remote.origin.url", `file://${remote}`);
    git(agentRepo, "config", "remote.origin.mirror", "true");
    git(agentRepo, "config", "credential.helper", `!${join(hooks, "pre-push")}`);
    expect((await push("feature/x")).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(git(remote, "rev-parse", "feature/x")).toBe(git(agentRepo, "rev-parse", "feature/x"));
    expect(git(decoy, "for-each-ref")).toBe("");
    // Mirror would have deleted the remote's main when absent locally; it is untouched.
    expect(git(remote, "branch", "--list", "main")).toContain("main");
  });

  it("over HTTP the token reaches only the remote: not in argv, env, files or the answer", async () => {
    const auth: string[] = [];
    const server = createServer((req, res) => {
      auth.push(req.headers.authorization ?? "");
      res.writeHead(req.headers.authorization ? 403 : 401, {
        "www-authenticate": 'Basic realm="x"',
      });
      res.end(`denied for ${req.headers.authorization ?? "nobody"}`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    // A git wrapper that records each call's argv and environment.
    const log = join(root, "git-calls.log");
    const wrapper = join(root, "git-wrapper.sh");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nprintf '%s\\n' "ARGV $*" >> ${log}\nenv >> ${log}\nexec git "$@"\n`,
      { mode: 0o755 },
    );
    try {
      const out = await push("feature/x", `http://127.0.0.1:${port}/acme/site.git`, {
        git: wrapper,
      });
      expect(out.ok).toBe(false);
      expect(out.text).not.toContain(TOKEN);
      const basic = auth.find((a) => a.startsWith("Basic "));
      expect(Buffer.from(basic?.slice(6) ?? "", "base64").toString()).toBe(
        `x-access-token:${TOKEN}`,
      );
      const calls = readFileSync(log, "utf8");
      expect(calls).toMatch(/ARGV .*push --porcelain --no-verify/);
      expect(calls).not.toContain(TOKEN);
      expect(calls).not.toMatch(/--force|\+refs/);
      expect(readdirSync(tmpRoot)).toEqual([]);
    } finally {
      server.close();
    }
  });
});
