// ADR-0067 level 5: the gateway pushes an agent's branch in its own process. The agent's repo is
// only ever read by a plain local fetch with no credential around: its config, hooks, url
// rewrites and mirror settings never apply while the token is present. The token reaches git on
// file descriptor 3 through an askpass script: never in argv, the environment, a file or a log.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PushInput {
  /** The agent's repository (absolute, already checked to be one of the run's folders). */
  folder: string;
  /** Already checked with `validBranch`. */
  branch: string;
  /** The project's repository address. */
  url: string;
  token: string;
  /** A gateway-private folder for the temporary bare repository. */
  tmpRoot: string;
  /** git executable (tests wrap it). */
  git?: string;
  timeoutMs?: number;
}

// Asked for a username, answers the token's; asked for the password, reads it from fd 3, which
// only the push's own process tree has.
const ASKPASS = `#!/bin/sh
case "$1" in
  Username*) echo x-access-token ;;
  *) cat <&3 ;;
esac
`;

const REJECTED = "rejected: the remote has changes you don't have; fetch and rebase";

function run(
  git: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
  secret?: string,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(git, args, {
      env,
      stdio: ["ignore", "pipe", "pipe", ...(secret === undefined ? [] : (["pipe"] as const))],
    });
    let out = "";
    const add = (b: Buffer) => {
      if (out.length < 20_000) out += b.toString("utf8");
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    if (secret !== undefined) {
      const pipe = child.stdio[3] as NodeJS.WritableStream;
      // git may exit before reading it (a refused fetch): ignore a closed pipe.
      (pipe as unknown as { on: (e: string, f: () => void) => void }).on("error", () => {});
      pipe.end(`${secret}\n`);
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

/** Push one branch, fast-forward only; returns text for the agent (the token redacted). */
export async function pushBranch(input: PushInput): Promise<{ ok: boolean; text: string }> {
  const git = input.git ?? "git";
  const timeout = input.timeoutMs ?? 100_000;
  const redact = (s: string) =>
    (input.token ? s.split(input.token).join("***") : s).trim().slice(0, 2000);
  mkdirSync(input.tmpRoot, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(input.tmpRoot, "push-"));
  try {
    chmodSync(dir, 0o700);
    const repo = join(dir, "repo.git");
    const askpass = join(dir, "askpass.sh");
    writeFileSync(askpass, ASKPASS, { mode: 0o700 });
    // Nothing from the gateway's environment but PATH: no GIT_* variable, no system or global
    // config, no credential helper, no prompt.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/usr/bin/false",
      SSH_ASKPASS: "/usr/bin/false",
    };
    const safe = ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper="];
    const init = await run(git, [...safe, "init", "--bare", "-q", repo], env, timeout);
    if (init.code !== 0) return { ok: false, text: `push failed: ${redact(init.out)}` };
    const ref = `refs/heads/${input.branch}`;
    // The agent's repo is a plain source here; no credential exists in this process yet.
    const fetched = await run(
      git,
      [
        ...safe,
        "-c",
        "protocol.file.allow=always",
        "-C",
        repo,
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--",
        input.folder,
        `${ref}:${ref}`,
      ],
      env,
      timeout,
    );
    if (fetched.code !== 0) {
      return {
        ok: false,
        text: `push failed: no branch ${input.branch} in ${input.folder} (${redact(fetched.out).split("\n")[0]})`,
      };
    }
    // No force flag and no `+`: the remote itself refuses anything but a fast-forward, and a
    // refspec with a source can never delete.
    const pushed = await run(
      git,
      [
        ...safe,
        "-c",
        "http.followRedirects=false",
        "-c",
        "push.recurseSubmodules=no",
        "-C",
        repo,
        "push",
        "--porcelain",
        "--no-verify",
        "--",
        input.url,
        `${ref}:${ref}`,
      ],
      { ...env, GIT_ASKPASS: askpass },
      timeout,
      input.token,
    );
    if (pushed.code === 0) {
      const same = /\[up to date\]/.test(pushed.out);
      return {
        ok: true,
        text: same
          ? `${input.branch} is already up to date on the remote.`
          : `Pushed ${input.branch} to the project's repository.`,
      };
    }
    if (/\[rejected\]|non-fast-forward|fetch first/.test(pushed.out)) {
      return { ok: false, text: REJECTED };
    }
    return { ok: false, text: `push failed: ${redact(pushed.out)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
