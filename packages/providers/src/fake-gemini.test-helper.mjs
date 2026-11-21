#!/usr/bin/env node
// Stand-in for `gemini -o json -p …` in tests. FAKE_GEMINI_RECORD: file for {argv, stdin, env}.
// FAKE_GEMINI_MODE: ok | json | quota | hang
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_GEMINI_MODE ?? "ok";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  stdin += d;
});
process.stdin.on("end", () => {
  if (process.env.FAKE_GEMINI_RECORD) {
    writeFileSync(
      process.env.FAKE_GEMINI_RECORD,
      JSON.stringify({
        argv: process.argv.slice(2),
        stdin,
        seatbelt: process.env.SEATBELT_PROFILE ?? null,
        apiKey: process.env.GEMINI_API_KEY ?? null,
      }),
    );
  }
  if (mode === "hang") return setInterval(() => {}, 1000);
  const stats = {
    models: { "gemini-x": { tokens: { prompt: 100, candidates: 9, cached: 40, total: 149 } } },
  };
  if (mode === "quota") {
    process.stdout.write(JSON.stringify({ error: { message: "Quota exceeded (429)" }, stats }));
    process.exit(1);
  }
  const response = mode === "json" ? 'Sure:\n{"action":"answer","message":"hi"}' : "Done: hello";
  process.stdout.write(JSON.stringify({ response, stats }));
  process.exit(0);
});
