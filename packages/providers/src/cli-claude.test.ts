import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAlive } from "@achords/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliClaude } from "./cli-claude.ts";
import type { ContainerSpec, RunRequest } from "./types.ts";

const FAKE = new URL("./fake-claude.test-helper.mjs", import.meta.url).pathname;
const FAKE_CONTAINER = new URL("./fake-container.test-helper.mjs", import.meta.url).pathname;

describe("cli-claude adapter", () => {
  let dir: string;
  let record: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "achords-claude-"));
    record = join(dir, "record.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const provider = (mode = "ok") =>
    cliClaude({
      command: [process.execPath, FAKE],
      env: { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_RECORD: record },
    });

  const req = (over: Partial<RunRequest> = {}): RunRequest => ({
    prompt: "do the thing",
    model: "sonnet",
    cwd: dir,
    tools: ["Read", "Grep"],
    allowedTools: ["Read", "Grep"],
    timeoutMs: 10_000,
    ...over,
  });

  it("runs the CLI with a locked-down, deny-by-default argument set", async () => {
    const res = await provider().run(
      req({ appendSystemPrompt: "be brief", maxTurns: 3, maxBudgetUsd: 0.5 }),
    );
    expect(res).toMatchObject({ ok: true, stopReason: "completed", text: "echo:do the thing" });

    const seen = JSON.parse(readFileSync(record, "utf8"));
    // macOS tmpdir is a symlink (/var -> /private/var); the child reports the resolved cwd.
    expect(seen.cwd).toBe(realpathSync(dir));
    // Prompt goes through stdin, never argv (argv is visible to every local user via ps).
    expect(seen.stdin).toBe("do the thing");
    expect(seen.argv.join(" ")).not.toContain("do the thing");
    expect(seen.argv).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--model",
      "sonnet",
      // Only the listed built-in tools exist for the run...
      "--tools",
      "Read,Grep",
      "--allowedTools",
      "Read,Grep",
      // ...no MCP servers (this also hides the user's claude.ai connectors)...
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      // ...and no user/project settings or hooks.
      "--setting-sources",
      "",
      "--append-system-prompt",
      "be brief",
      "--max-turns",
      "3",
      "--max-budget-usd",
      "0.5",
    ]);
  });

  it("passes the agent's effort level", async () => {
    await provider().run(req({ effort: "xhigh" }));
    const seen = JSON.parse(readFileSync(record, "utf8"));
    expect(seen.argv.join(" ")).toContain("--effort xhigh");
  });

  it("passes extra settings (the WebFetch path hook) when given", async () => {
    await provider().run(req({ settings: '{"hooks":{}}' }));
    const seen = JSON.parse(readFileSync(record, "utf8"));
    expect(seen.argv).toEqual(expect.arrayContaining(["--settings", '{"hooks":{}}']));
  });

  it("adds extra directories and a JSON schema, and returns the structured output", async () => {
    const schema = { type: "object", properties: { action: { type: "string" } } };
    const res = await provider("structured").run(
      req({ addDirs: ["/a", "/b"], jsonSchema: schema }),
    );
    const { argv } = JSON.parse(readFileSync(record, "utf8"));
    expect(argv.slice(argv.indexOf("--add-dir"), argv.indexOf("--add-dir") + 3)).toEqual([
      "--add-dir",
      "/a",
      "/b",
    ]);
    expect(argv[argv.indexOf("--json-schema") + 1]).toBe(JSON.stringify(schema));
    expect(res.structured).toEqual({ action: "delegate" });
  });

  it("uses an MCP config file (never inline JSON with secrets on argv) when given", async () => {
    await provider().run(req({ mcpConfigPath: "/tmp/run-x/mcp.json" }));
    const { argv } = JSON.parse(readFileSync(record, "utf8"));
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe("/tmp/run-x/mcp.json");
    expect(argv).toContain("--strict-mcp-config");
  });

  it("passes an empty tool list as no tools at all", async () => {
    await provider().run(req({ tools: [], allowedTools: [] }));
    const { argv } = JSON.parse(readFileSync(record, "utf8"));
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv).not.toContain("--allowedTools");
  });

  it("reports progress from the agent's TodoWrite checklist", async () => {
    const seen: unknown[] = [];
    const res = await provider("todo").run(req({ onProgress: (p) => seen.push(p) }));
    expect(res.ok).toBe(true);
    expect(seen).toEqual([
      expect.objectContaining({ done: 0, total: 4, current: "Doing step 1" }),
      {
        done: 2,
        total: 4,
        current: "Doing step 3",
        items: [
          { content: "Step 1", status: "completed" },
          { content: "Step 2", status: "completed" },
          { content: "Step 3", status: "in_progress" },
          { content: "Step 4", status: "pending" },
        ],
      },
    ]);
  });

  it("reports refused tool calls with the call that caused them, at most once each", async () => {
    const res = await provider("denied").run(req());
    expect(res.ok).toBe(true);
    expect(res.denials).toEqual([
      {
        tool: "Bash",
        input: "curl https://example.com",
        reason: "curl: (6) Could not resolve host: Operation not permitted",
        unsandboxed: false,
      },
      {
        tool: "Bash",
        // Raw here: the orchestrator redacts before storing or logging.
        input: "rm -rf build TOKEN=abcdefgh12345678", // gitleaks:allow (fake test fixture)
        reason: "This command requires approval because it runs outside the sandbox",
        unsandboxed: true,
      },
      // A tool that merely failed ("File does not exist.") is not a refusal.
      {
        tool: "WebFetch",
        input: '{"url":"https://example.org"}',
        reason: "Claude requested permissions to use WebFetch, but you haven't granted it yet.",
      },
      // Only in the result's permission_denials.
      {
        tool: "Write",
        input: '{"file_path":"/etc/x","content":"y"}',
        reason: "permission not granted",
      },
    ]);
    expect((await provider().run(req())).denials).toBeUndefined();
  });

  it("signals every stream event (ADR-0066 stall watcher)", async () => {
    let events = 0;
    await provider("todo").run(req({ onActivity: () => events++ }));
    expect(events).toBeGreaterThan(2);
  });

  it("reports usage, cost, session and subscription windows", async () => {
    const res = await provider().run(req());
    expect(res.usage).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 90858,
      costUsd: 0.0181738,
    });
    expect(res.sessionId).toBe("00000000-0000-0000-0000-000000000001");
    expect(res.windows).toEqual([
      { kind: "five_hour", utilization: 0.1, resetsAt: 1795113000_000, status: "allowed" },
      { kind: "seven_day", utilization: 0.06, resetsAt: 1795428000_000, status: "allowed" },
    ]);
  });

  it("keeps the session and resumes it only when asked (ADR-0066)", async () => {
    const id = "00000000-0000-0000-0000-000000000001";
    await provider().run(req());
    expect(JSON.parse(readFileSync(record, "utf8")).argv).toContain("--no-session-persistence");
    await provider().run(req({ session: {} }));
    const fresh = JSON.parse(readFileSync(record, "utf8")).argv as string[];
    expect(fresh).not.toContain("--no-session-persistence");
    expect(fresh).not.toContain("--resume");
    const ok = await cliClaude({
      command: [process.execPath, FAKE],
      env: { FAKE_CLAUDE_RECORD: record, FAKE_CLAUDE_KNOWN: id },
    }).run(req({ session: { resume: id } }));
    expect(ok).toMatchObject({ ok: true, sessionId: id });
    expect(JSON.parse(readFileSync(record, "utf8")).argv).toEqual(
      expect.arrayContaining(["--resume", id]),
    );
  });

  it("reports a resume the CLI rejects, so the caller can start afresh (ADR-0066)", async () => {
    const res = await provider().run(req({ session: { resume: "gone" } }));
    expect(res).toMatchObject({ ok: false, stopReason: "error", resumeRejected: true });
    expect((await provider("crash").run(req())).resumeRejected).toBeUndefined();
  });

  it("injects broker env only into the child process", async () => {
    await provider().run(req({ env: { ACHORDS_TEST_SECRET: "s3cret-value" } }));
    expect(JSON.parse(readFileSync(record, "utf8")).injected).toBe("s3cret-value");
    expect(process.env.ACHORDS_TEST_SECRET).toBeUndefined();
  });

  it("keeps the CLI's token and API key out of its Bash, hooks and MCP servers", async () => {
    await provider().run(req({ env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }));
    expect(JSON.parse(readFileSync(record, "utf8")).scrub).toBe("1");
    // Not even a run's own setting turns it off.
    await provider().run(req({ env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "0" } }));
    expect(JSON.parse(readFileSync(record, "utf8")).scrub).toBe("1");
  });

  it("uses an API key only in API mode, never a stray one on a subscription (Phase 4)", async () => {
    const key = { ANTHROPIC_API_KEY: "sk-ant-test" };
    await cliClaude({
      command: [process.execPath, FAKE],
      env: { ...key, FAKE_CLAUDE_RECORD: record },
    }).run(req());
    expect(JSON.parse(readFileSync(record, "utf8")).anthropicKey).toBeNull();
    await provider().run(req({ billing: "api", env: key }));
    expect(JSON.parse(readFileSync(record, "utf8")).anthropicKey).toBe("sk-ant-test");
  });

  it("maps CLI-reported errors and crashes to failed results", async () => {
    // A subscription at its usage limit: the gateway may continue on another model (ADR-0058).
    const limit = await provider("limit").run(req());
    expect(limit).toMatchObject({ ok: false, stopReason: "unavailable" });
    expect(limit.error).toMatch(/hit your limit/);
    const err = await provider("error").run(req());
    expect(err).toMatchObject({ ok: false, stopReason: "error" });
    expect(err.error).toMatch(/error_max_turns/);

    const crash = await provider("crash").run(req());
    expect(crash).toMatchObject({ ok: false, stopReason: "error" });
    expect(crash.error).toMatch(/exit code 3.*something broke/s);
  });

  it("times out and kills the whole process group", async () => {
    let childPid: number | undefined;
    const p = cliClaude({
      command: [process.execPath, FAKE],
      env: { FAKE_CLAUDE_MODE: "hang-child" },
      onEvent: (e) => {
        if (e.type === "test") childPid = e.childPid as number;
      },
    });
    let spawned: number | undefined;
    const res = await p.run(req({ timeoutMs: 1000, onSpawn: (pid) => (spawned = pid) }));
    expect(res).toMatchObject({ ok: false, stopReason: "timeout" });
    expect(spawned).toBeTypeOf("number");
    expect(childPid).toBeTypeOf("number");
    // The grandchild (an agent tool subprocess) must not outlive the run.
    await waitFor(() => !isAlive(childPid as number));
  });

  it("can be cancelled", async () => {
    const ctl = new AbortController();
    const running = provider("hang").run(req({ signal: ctl.signal }));
    setTimeout(() => ctl.abort(), 300);
    expect(await running).toMatchObject({ ok: false, stopReason: "cancelled" });
  });

  describe("inside an Apple container (ADR-0051)", () => {
    const box = (over: Partial<ContainerSpec> = {}): ContainerSpec => ({
      bin: FAKE_CONTAINER,
      name: "achords-run-test",
      image: "achords-agent:abc",
      mounts: [
        { path: dir, readonly: false },
        { path: "/srv/docs", readonly: true },
      ],
      ...over,
    });
    const boxed = (mode = "ok") =>
      cliClaude({
        command: [process.execPath, FAKE],
        env: {
          FAKE_CLAUDE_MODE: mode,
          FAKE_CLAUDE_RECORD: record,
          FAKE_CONTAINER_RECORD: calls(),
        },
      });
    const calls = () => join(dir, "container.jsonl");
    // Nothing recorded yet (the fake has not started) reads as an empty list, so waitFor waits.
    const recorded = () =>
      existsSync(calls())
        ? readFileSync(calls(), "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l).argv as string[])
        : [];

    it("wraps the unchanged CLI command; secrets go in by name, never on argv", async () => {
      const res = await boxed().run(
        req({
          billing: "api",
          env: { ANTHROPIC_API_KEY: "sk-ant-secret-value" },
          container: box(),
        }),
      );
      expect(res).toMatchObject({ ok: true, text: "echo:do the thing" });
      const [argv] = recorded();
      const image = argv?.indexOf("achords-agent:abc") ?? -1;
      expect(argv?.slice(0, image)).toEqual([
        "run",
        "--rm",
        "-i",
        "--init",
        "--progress",
        "none",
        "--name",
        "achords-run-test",
        "--cpus",
        "4",
        "--memory",
        "4G",
        "--mount",
        `type=bind,source=${dir},target=${dir}`,
        "--mount",
        "type=bind,source=/srv/docs,target=/srv/docs,readonly",
        "-e",
        "ANTHROPIC_API_KEY",
        "-e",
        "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
        "-w",
        dir,
      ]);
      // After the image: exactly the command a host run would have used.
      const seen = JSON.parse(readFileSync(record, "utf8"));
      expect(argv?.slice(image + 1)).toEqual([process.execPath, FAKE, ...seen.argv]);
      expect(JSON.stringify(argv)).not.toContain("sk-ant-secret-value");
      // The VM still gets the value (copied from the client's environment).
      expect(seen.anthropicKey).toBe("sk-ant-secret-value");
      expect(seen.stdin).toBe("do the thing");
    });

    it("passes nothing of the host environment but the run's own variables", async () => {
      process.env.ACHORDS_TEST_HOST_ONLY = "host";
      try {
        await boxed().run(req({ env: { ACHORDS_TEST_SECRET: "tok" }, container: box() }));
      } finally {
        delete process.env.ACHORDS_TEST_HOST_ONLY;
      }
      const [argv] = recorded();
      expect(argv?.filter((_, i) => argv[i - 1] === "-e")).toEqual([
        "ACHORDS_TEST_SECRET",
        "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
      ]);
      expect(JSON.parse(readFileSync(record, "utf8"))).toMatchObject({
        injected: "tok",
        scrub: "1",
      });
    });

    it("stops the container by name on cancel", async () => {
      // `container kill` runs with the gateway's own environment.
      process.env.FAKE_CONTAINER_RECORD = calls();
      try {
        const ctl = new AbortController();
        const running = boxed("hang").run(req({ signal: ctl.signal, container: box() }));
        setTimeout(() => ctl.abort(), 500);
        expect(await running).toMatchObject({ ok: false, stopReason: "cancelled" });
        await waitFor(() => recorded().some((a) => a[0] === "kill"));
        expect(recorded().find((a) => a[0] === "kill")).toEqual(["kill", "achords-run-test"]);
      } finally {
        delete process.env.FAKE_CONTAINER_RECORD;
      }
    });

    it("stops the container when its client is killed from outside (per-chat Stop)", async () => {
      process.env.FAKE_CONTAINER_RECORD = calls();
      try {
        let pid = 0;
        const running = boxed("hang").run(req({ container: box(), onSpawn: (p) => (pid = p) }));
        // Signal only once the fake client has started (and recorded its run), as in real use;
        // a signal during Node's start-up made this flaky on slow CI runners.
        await waitFor(() => pid > 0 && recorded().some((a) => a[0] === "run"));
        // What stopThread does: signal the run's process group, not the provider.
        process.kill(-pid, "SIGKILL");
        await running;
        await waitFor(() => recorded().some((a) => a[0] === "kill"));
        expect(recorded().find((a) => a[0] === "kill")).toEqual(["kill", "achords-run-test"]);
      } finally {
        delete process.env.FAKE_CONTAINER_RECORD;
      }
    }, 20_000);

    it("refuses a folder the mount syntax cannot carry", async () => {
      const res = await boxed().run(
        req({ container: box({ mounts: [{ path: "/a,b", readonly: false }] }) }),
      );
      expect(res).toMatchObject({ ok: false, stopReason: "error" });
      expect(res.error).toMatch(/cannot share the folder \/a,b/);
    });
  });

  it("fails cleanly when the binary is missing", async () => {
    const res = await cliClaude({ command: ["/nonexistent/claude"] }).run(req());
    expect(res).toMatchObject({ ok: false, stopReason: "error" });
    expect(res.error).toMatch(/ENOENT/);
  });
});

// Talks to the real `claude` CLI (uses a little subscription quota); opt-in.
describe.runIf(process.env.ACHORDS_TEST_CLAUDE === "1")("cli-claude (real CLI)", () => {
  it("answers with no tools and no MCP servers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "achords-claude-real-"));
    try {
      const res = await cliClaude().run({
        prompt: "Reply with exactly: ok",
        model: "haiku",
        cwd: dir,
        tools: [],
        allowedTools: [],
        maxTurns: 1,
        timeoutMs: 120_000,
      });
      expect(res).toMatchObject({ ok: true, stopReason: "completed" });
      expect(res.text.trim().toLowerCase()).toContain("ok");
      expect(res.windows.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);
});

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
