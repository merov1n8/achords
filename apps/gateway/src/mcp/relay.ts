// ADR-0055: what an agent run starts for an integration with secrets. The server itself runs on
// the gateway's side (host.ts); this relay only carries stdio over the agent API with a token
// that is good for this one run and integration. It holds no secret.
import { createInterface } from "node:readline";

const HUB = process.env.ACHORDS_HUB_URL ?? "";
const ID = process.env.ACHORDS_MCP_ID ?? "";
// Under codex the token arrives under another name, given in ACHORDS_MCP_TOKEN_VAR (ADR-0040).
const TOKEN =
  process.env.ACHORDS_MCP_TOKEN ?? process.env[process.env.ACHORDS_MCP_TOKEN_VAR ?? ""] ?? "";
const URL_ = `${HUB}/api/agent/mcp/${encodeURIComponent(ID)}`;
const headers = { authorization: `Bearer ${TOKEN}` };

const fail = (why: string) => {
  process.stderr.write(`achords: integration ${ID} not reachable (${why})\n`);
  process.exit(1);
};

// The server's lines. In a container run (ADR-0051) the hub's listener on the container network
// may come up a moment after the VM: retry while nothing answers.
let res: Response | undefined;
for (let i = 0; i < 20 && !res; i++) {
  if (i) await new Promise((r) => setTimeout(r, 250));
  res = await fetch(URL_, { headers }).catch(() => undefined);
}
if (!res?.ok || !res.body) fail(res ? `HTTP ${res.status}` : "hub unreachable");

// Lines to the server leave one after another, in order.
let queue: Promise<unknown> = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  queue = queue.then(() =>
    fetch(URL_, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: line,
    }).then(
      (r) => {
        if (!r.ok) fail(`HTTP ${r.status}`);
      },
      () => fail("hub unreachable"),
    ),
  );
});

const decoder = new TextDecoder();
let buf = "";
for await (const chunk of (res as Response).body as ReadableStream<Uint8Array>) {
  buf += decoder.decode(chunk, { stream: true });
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    process.stdout.write(`${buf.slice(0, i)}\n`);
    buf = buf.slice(i + 1);
  }
}
// The server ended (or the run's token was revoked).
process.exit(0);
