#!/usr/bin/env node
// Stand-in for ffmpeg / whisper-cli in tests. FAKE_TOOL_LOG: file to append argv lines to.
import { appendFileSync, copyFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_TOOL_LOG)
  appendFileSync(process.env.FAKE_TOOL_LOG, `${JSON.stringify(args)}\n`);
if (args.includes("-i")) {
  // ffmpeg: copy input to the last argument (output)
  copyFileSync(args[args.indexOf("-i") + 1], args.at(-1));
} else {
  // whisper-cli: write "<-of>.txt"
  if (process.env.FAKE_WHISPER_FAIL) process.exit(2);
  const of = args[args.indexOf("-of") + 1];
  writeFileSync(`${of}.txt`, process.env.FAKE_WHISPER_TEXT ?? "  Szia, csinálj egy TODO listát.\n");
}
