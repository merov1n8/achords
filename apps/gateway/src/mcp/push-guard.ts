// ADR-0067: the PreToolUse hook on Bash of a level 5 run. Force push and history rewrite are
// refused; a push that deletes on the remote runs only as approved (base64url JSON argument).
import { pushRefusal } from "@achords/policy";

let approved: string[] = [];
try {
  approved = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8") || "[]");
} catch {
  // A broken argument approves nothing.
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
let command = "";
try {
  command = String(JSON.parse(input)?.tool_input?.command ?? "");
} catch {
  process.stderr.write("achords: unreadable tool call\n");
  process.exit(2);
}
const why = pushRefusal(command, Array.isArray(approved) ? approved.map(String) : []);
if (why) {
  process.stderr.write(`${why}\n`);
  process.exit(2);
}
