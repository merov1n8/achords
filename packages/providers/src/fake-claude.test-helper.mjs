#!/usr/bin/env node
// Stand-in for the `claude` CLI in tests. Emits stream-json in the shape of claude 2.1.x
// (recorded from a real `claude -p --output-format stream-json --verbose` run, ids replaced).
// FAKE_CLAUDE_RECORD: file to write {argv, stdin, cwd, env subset} into.
// FAKE_CLAUDE_MODE: ok | structured | error | limit | crash | hang | hang-child | todo | denied
// FAKE_CLAUDE_KNOWN: session ids `--resume` accepts (comma-separated); others are rejected the
// way the real CLI does it.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  stdin += d;
});
process.stdin.on("end", () => {
  if (process.env.FAKE_CLAUDE_RECORD) {
    writeFileSync(
      process.env.FAKE_CLAUDE_RECORD,
      JSON.stringify({
        argv: process.argv.slice(2),
        stdin,
        cwd: process.cwd(),
        injected: process.env.ACHORDS_TEST_SECRET ?? null,
        anthropicKey: process.env.ANTHROPIC_API_KEY ?? null,
        configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
        scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB ?? null,
      }),
    );
  }
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const session_id = "00000000-0000-0000-0000-000000000001";

  const resume = process.argv.indexOf("--resume");
  const resumed = resume >= 0 ? process.argv[resume + 1] : undefined;
  if (resumed && !(process.env.FAKE_CLAUDE_KNOWN ?? "").split(",").includes(resumed)) {
    process.stderr.write(`No conversation found with session ID: ${resumed}\n`);
    process.exit(1);
  }
  if (mode === "crash") {
    process.stderr.write("fatal: something broke\n");
    process.exit(3);
  }
  out({ type: "system", subtype: "init", session_id, model: "claude-haiku-5-5", tools: [] });
  if (mode === "hang" || mode === "hang-child") {
    if (mode === "hang-child") {
      const child = spawn("sleep", ["60"], { stdio: "ignore" });
      out({ type: "test", childPid: child.pid });
    }
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "todo") {
    // The agent's own checklist, as Claude Code's TodoWrite tool call (recorded shape).
    const todo = (statuses) => ({
      type: "assistant",
      session_id,
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "TodoWrite",
            input: {
              todos: statuses.map((status, i) => ({
                content: `Step ${i + 1}`,
                activeForm: `Doing step ${i + 1}`,
                status,
              })),
            },
          },
        ],
      },
    });
    out(todo(["in_progress", "pending", "pending", "pending"]));
    out(todo(["completed", "completed", "in_progress", "pending"]));
  }
  if (mode === "denied") {
    // A sandboxed Bash call refused, one that asked to leave the sandbox, and a tool that just
    // failed (not a refusal). Shapes as claude 2.1.x prints them.
    const call = (id, name, input) => ({
      type: "assistant",
      session_id,
      message: { content: [{ type: "tool_use", id, name, input }] },
    });
    const fail = (tool_use_id, content) => ({
      type: "user",
      session_id,
      message: { content: [{ type: "tool_result", tool_use_id, is_error: true, content }] },
    });
    out(call("toolu_a", "Bash", { command: "curl https://example.com", description: "fetch" }));
    out(fail("toolu_a", "curl: (6) Could not resolve host: Operation not permitted"));
    out(
      call("toolu_b", "Bash", {
        command: "rm -rf build TOKEN=abcdefgh12345678", // gitleaks:allow (fake test fixture)
        dangerouslyDisableSandbox: true,
      }),
    );
    out(
      fail("toolu_b", [
        {
          type: "text",
          text: "This command requires approval because it runs outside the sandbox",
        },
      ]),
    );
    out(call("toolu_c", "Read", { file_path: "/nope" }));
    out(fail("toolu_c", "File does not exist."));
    out(call("toolu_d", "WebFetch", { url: "https://example.org" }));
    out(
      fail(
        "toolu_d",
        "Claude requested permissions to use WebFetch, but you haven't granted it yet.",
      ),
    );
  }
  out({
    type: "assistant",
    session_id,
    message: { content: [{ type: "text", text: "ok" }] },
  });
  out({
    type: "rate_limit_event",
    session_id,
    rate_limit_info: {
      status: "allowed",
      rateLimitType: "five_hour",
      unifiedWindows: {
        five_hour: { utilization: 0.1, resetsAt: 1795113000, status: "allowed" },
        seven_day: { utilization: 0.06, resetsAt: 1795428000, status: "allowed" },
      },
    },
  });
  out("not json is ignored");
  out({
    type: "result",
    subtype: mode === "error" ? "error_max_turns" : "success",
    is_error: mode === "error" || mode === "limit",
    result:
      mode === "error"
        ? ""
        : mode === "limit"
          ? "You've hit your limit · resets 5pm"
          : `echo:${stdin.trim()}`,
    session_id,
    duration_ms: 2082,
    num_turns: 1,
    total_cost_usd: 0.0181738,
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 90858,
      cache_read_input_tokens: 0,
      output_tokens: 4,
    },
    permission_denials:
      mode === "denied"
        ? [
            {
              tool_name: "WebFetch",
              tool_use_id: "toolu_d",
              tool_input: { url: "https://example.org" },
            },
            {
              tool_name: "Write",
              tool_use_id: "toolu_e",
              tool_input: { file_path: "/etc/x", content: "y" },
            },
          ]
        : [],
    ...(mode === "structured" ? { structured_output: { action: "delegate" } } : {}),
    terminal_reason: mode === "error" ? "max_turns" : "completed",
  });
});
