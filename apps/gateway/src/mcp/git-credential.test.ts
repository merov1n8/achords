import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitPushEnv } from "@achords/policy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HELPER = new URL("./git-credential.ts", import.meta.url).pathname;
const GUARD = new URL("./push-guard.ts", import.meta.url).pathname;
const FLAGS = ["--disable-warning=ExperimentalWarning"];

/** Runs a script on this Node with stdin; resolves with its exit code and output. */
const run = (args: string[], input: string, env: Record<string, string> = {}) =>
  new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const p = spawn(process.execPath, [...FLAGS, ...args], { env: { ...process.env, ...env } });
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => {
      out += c;
    });
    p.stderr.on("data", (c) => {
      err += c;
    });
    p.on("close", (code) => done({ code, out, err }));
    p.stdin.end(input);
  });

// ADR-0067 level 5: git's credential helper asks a (fake) gateway; nothing is pushed anywhere.
describe("git credential helper", () => {
  let hub: Server;
  let url: string;
  let asked: { auth: string | undefined; body: Record<string, string> }[];

  beforeEach(async () => {
    asked = [];
    hub = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const b = JSON.parse(body);
        asked.push({ auth: req.headers.authorization, body: b });
        const ok = req.url === "/api/agent/git-credential" && b.host === "github.com";
        res.writeHead(ok ? 200 : 403, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            ok
              ? { ok: true, username: "x-access-token", password: "ghp_value" }
              : { ok: false, reason: "no" },
          ),
        );
      });
    });
    await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  });
  afterEach(() => hub.close());

  const env = () => ({ ACHORDS_HUB_URL: url, ACHORDS_GIT_TOKEN: "run-push-token" });

  it("answers git's get with the gateway's credential, on stdout only", async () => {
    const r = await run(
      [HELPER, "get"],
      "protocol=https\nhost=github.com\npath=acme/site.git\n\n",
      env(),
    );
    expect(r.out).toBe("username=x-access-token\npassword=ghp_value\n");
    expect(r.err).toBe("");
    expect(asked).toEqual([
      {
        auth: "Bearer run-push-token",
        body: { protocol: "https", host: "github.com", path: "acme/site.git" },
      },
    ]);
  });

  it("prints nothing when the gateway refuses, and ignores store and erase", async () => {
    const refused = await run([HELPER, "get"], "protocol=https\nhost=gitlab.com\n\n", env());
    expect(refused.out).toBe("");
    for (const op of ["store", "erase"]) {
      const r = await run([HELPER, op], "protocol=https\nhost=github.com\npassword=x\n\n", env());
      expect(r.out).toBe("");
    }
    expect(asked).toHaveLength(1);
  });

  it("works through git itself with the configuration from the environment only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "achords-git-"));
    try {
      const out = await new Promise<string>((done, fail) => {
        const p = execFile(
          "git",
          ["credential", "fill"],
          {
            cwd: dir,
            env: {
              ...process.env,
              // An empty home: no global configuration of this machine's git login.
              HOME: dir,
              ...gitPushEnv({
                node: process.execPath,
                helper: HELPER,
                hubUrl: url,
                token: "run-push-token",
              }),
            },
          },
          (err, stdout) => (err ? fail(err) : done(stdout)),
        );
        p.stdin?.end("protocol=https\nhost=github.com\npath=acme/site.git\n\n");
      });
      expect(out).toContain("username=x-access-token\npassword=ghp_value\n");
      expect(asked[0]?.body.path).toBe("acme/site.git");
      // Nothing written: no git configuration file appeared.
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("push guard hook", () => {
  const arg = (approved: string[]) => Buffer.from(JSON.stringify(approved)).toString("base64url");
  const call = (command: string, approved: string[] = []) =>
    run([GUARD, arg(approved)], JSON.stringify({ tool_input: { command } }));

  it("lets plain pushes and other commands through", async () => {
    expect((await call("git push origin main")).code).toBe(0);
    expect((await call("pnpm test")).code).toBe(0);
  });

  it("blocks force, mirror and unapproved deletions; an approved deletion runs", async () => {
    for (const cmd of [
      "git push --force origin main",
      "git push -f",
      "git push --force-with-lease",
      "git push --mirror backup",
      "git push origin +main",
    ]) {
      const r = await call(cmd, [cmd]);
      expect(r.code, cmd).toBe(2);
      expect(r.err).toMatch(/force push/);
    }
    for (const cmd of ["git push origin --delete old", "git push origin :old"]) {
      const r = await call(cmd);
      expect(r.code, cmd).toBe(2);
      expect(r.err).toMatch(/asks the owner/);
    }
    expect(
      (await call("git push origin --delete old", ["git push origin --delete old"])).code,
    ).toBe(0);
  });
});
