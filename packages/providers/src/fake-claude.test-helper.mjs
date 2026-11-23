#!/usr/bin/env node
// Stand-in for the `claude` CLI in tests. Emits stream-json in the shape of claude 2.1.x
// (recorded from a real `claude -p --output-format stream-json --verbose` run, ids replaced).
// FAKE_CLAUDE_RECORD: file to write {argv, stdin, cwd, env subset} into.
// FAKE_CLAUDE_MODE: ok | structured | error | limit | crash | hang | hang-child
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
      }),
    );
  }
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const session_id = "00000000-0000-0000-0000-000000000001";

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
    permission_denials: [],
    ...(mode === "structured" ? { structured_output: { action: "delegate" } } : {}),
    terminal_reason: mode === "error" ? "max_turns" : "completed",
  });
});
