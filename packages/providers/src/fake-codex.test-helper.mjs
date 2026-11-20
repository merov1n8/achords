#!/usr/bin/env node
// Stand-in for the `codex` CLI in tests: `codex exec --json … -o <file> -`, events as JSONL.
// FAKE_CODEX_RECORD: file for {argv, stdin, cwd}. FAKE_CODEX_MODE: ok | json | limit | hang
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_CODEX_MODE ?? "ok";
const argv = process.argv.slice(2);
const out = argv[argv.indexOf("-o") + 1];
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  stdin += d;
});
process.stdin.on("end", () => {
  if (process.env.FAKE_CODEX_RECORD) {
    writeFileSync(
      process.env.FAKE_CODEX_RECORD,
      JSON.stringify({ argv, stdin, cwd: process.cwd() }),
    );
  }
  const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  emit({ type: "thread.started", thread_id: "t1" });
  emit({ type: "turn.started" });
  if (mode === "hang") return setInterval(() => {}, 1000);
  if (mode === "limit") {
    const message = "You've hit your usage limit. Try again at Nov 21st, 2026 1:46 AM.";
    emit({ type: "error", message });
    emit({ type: "turn.failed", error: { message } });
    process.exit(1);
  }
  writeFileSync(out, mode === "json" ? '{"action":"answer","message":"hi"}' : "Done: hello\n");
  emit({
    type: "turn.completed",
    usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 7 },
  });
  process.exit(0);
});
