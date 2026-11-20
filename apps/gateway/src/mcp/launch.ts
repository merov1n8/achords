// Launcher for integration MCP servers (ADR-0034), started by the agent CLI from the per-run
// config. It trades its one-time ticket for the server's command and environment (secrets
// included), then runs the server on this process's stdio. The config file never holds secrets.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type CallScope, scopeRefusal } from "@achords/policy";

const HUB = process.env.ACHORDS_HUB_URL ?? "";
const TICKET = process.env.ACHORDS_MCP_TICKET ?? "";

const res = await fetch(`${HUB}/api/agent/mcp-env`, {
  method: "POST",
  headers: { authorization: `Bearer ${TICKET}` },
  signal: AbortSignal.timeout(10_000),
}).catch(() => undefined);
if (!res?.ok) {
  process.stderr.write(
    `achords: integration launch refused (${res?.status ?? "hub unreachable"})\n`,
  );
  process.exit(1);
}
const launch = (await res.json()) as {
  command: string;
  args: string[];
  env: Record<string, string>;
  files?: Record<string, Record<string, string>>;
  scope?: CallScope;
  publish?: { integration: string; mode: "review" | "auto"; tools: string[]; token: string };
};

// Credentials files for servers that only read files: private folder, removed on exit. Agents
// cannot read it: their file tools are limited to their own folders.
const fileEnv: Record<string, string> = {};
const entries = Object.entries(launch.files ?? {});
const dir = entries.length ? mkdtempSync(join(tmpdir(), "achords-mcp-")) : undefined;
for (const [key, fields] of entries) {
  const path = join(dir as string, `${key.toLowerCase()}.json`);
  writeFileSync(path, JSON.stringify(fields), { mode: 0o600 });
  fileEnv[key] = path;
}
const cleanup = () => {
  if (dir) rmSync(dir, { recursive: true, force: true });
};

const { ACHORDS_MCP_TICKET: _t, ACHORDS_HUB_URL: _h, ...inherited } = process.env;
const { scope, publish } = launch;
const child = spawn(launch.command, launch.args, {
  // With a project scope the launcher sits between the CLI and the server (ADR-0036).
  stdio: scope || publish ? ["pipe", "pipe", "inherit"] : "inherit",
  env: { ...inherited, ...launch.env, ...fileEnv },
});
/** Publishing (ADR-0037): the gateway decides; the agent never holds the outcome. */
const toHub = async (path: string, body: unknown): Promise<string> => {
  try {
    const res = await fetch(`${HUB}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${publish?.token ?? ""}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const out = (await res.json()) as { text?: string; reason?: string; error?: string };
    return out.text ?? `Refused: ${out.reason ?? out.error ?? `HTTP ${res.status}`}`;
  } catch (err) {
    return `Refused: hub not reachable (${(err as Error).name})`;
  }
};
const toolReply = (id: unknown, text: string, isError = false) =>
  `${JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result: { content: [{ type: "text", text }], ...(isError ? { isError } : {}) } })}\n`;

if ((scope || publish) && child.stdin && child.stdout) {
  const toServer = child.stdin;
  // auto mode: calls sent to the server, reported once their answer comes back.
  const autoCalls = new Map<unknown, { tool: string; args: unknown }>();
  // Whole lines only, so a refusal never lands inside a server message.
  createInterface({ input: child.stdout }).on("line", (line) => {
    process.stdout.write(`${line}\n`);
    if (!autoCalls.size) return;
    try {
      const m = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown };
      const call = autoCalls.get(m.id);
      if (!call) return;
      autoCalls.delete(m.id);
      void toHub("/api/agent/publish_log", {
        integration: publish?.integration,
        tool: call.tool,
        arguments: call.args,
        result: JSON.stringify(m.result ?? m.error ?? null).slice(0, 2000),
      });
    } catch {}
  });
  createInterface({ input: process.stdin })
    .on("line", (line) => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        toServer.write(`${line}\n`);
        return;
      }
      // No batches: a call inside one could not be checked.
      if (Array.isArray(msg)) {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batches are not accepted" } })}\n`,
        );
        return;
      }
      const m = msg as {
        id?: unknown;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      const tool = String(m.params?.name ?? "");
      const refusal =
        m.method === "tools/call" && scope
          ? scopeRefusal(scope, tool, m.params?.arguments)
          : undefined;
      if (refusal !== undefined) {
        process.stdout.write(toolReply(m.id, `Refused: ${refusal}`, true));
        return;
      }
      if (m.method === "tools/call" && publish?.tools.includes(tool)) {
        if (publish.mode === "review") {
          // The server never sees it; the owner approves exactly these arguments.
          void toHub("/api/agent/publish", {
            integration: publish.integration,
            tool,
            arguments: m.params?.arguments ?? {},
          }).then((text) =>
            process.stdout.write(toolReply(m.id, text, text.startsWith("Refused"))),
          );
          return;
        }
        autoCalls.set(m.id, { tool, args: m.params?.arguments ?? {} });
      }
      toServer.write(`${line}\n`);
    })
    .on("close", () => toServer.end());
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => child.kill(sig));
}
child.on("error", (err) => {
  cleanup();
  process.stderr.write(`achords: integration failed to start: ${err.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  cleanup();
  process.exit(code ?? (signal ? 1 : 0));
});
