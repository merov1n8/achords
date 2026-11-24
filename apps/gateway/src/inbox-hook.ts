// ADR-0069: PostToolUse and Stop hook of claude and codex runs: `inbox-hook.ts <dir> post|stop`.
// Runs unsandboxed with the owner's rights, so it only touches the one folder it is given.
import { hookOutput, takeNotes } from "./inbox.ts";

const [dir, mode] = process.argv.slice(2);
// The CLI writes the hook input to stdin; read it to the end so it never meets a closed pipe.
let done = false;
const run = () => {
  if (done || !dir || (mode !== "post" && mode !== "stop")) return;
  done = true;
  process.stdout.write(hookOutput(mode, takeNotes(dir)));
};
process.stdin.on("data", () => {});
process.stdin.on("end", run);
process.stdin.on("error", run);
setTimeout(run, 2000).unref();
