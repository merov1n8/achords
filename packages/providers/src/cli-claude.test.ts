import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAlive } from "@achords/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliClaude } from "./cli-claude.ts";
import type { RunRequest } from "./types.ts";

const FAKE = new URL("./fake-claude.test-helper.mjs", import.meta.url).pathname;

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

  it("passes an empty tool list as no tools at all", async () => {
    await provider().run(req({ tools: [], allowedTools: [] }));
    const { argv } = JSON.parse(readFileSync(record, "utf8"));
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv).not.toContain("--allowedTools");
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

  it("injects broker env only into the child process", async () => {
    await provider().run(req({ env: { ACHORDS_TEST_SECRET: "s3cret-value" } }));
    expect(JSON.parse(readFileSync(record, "utf8")).injected).toBe("s3cret-value");
    expect(process.env.ACHORDS_TEST_SECRET).toBeUndefined();
  });

  it("maps CLI-reported errors and crashes to failed results", async () => {
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
