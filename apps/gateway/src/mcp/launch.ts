// Launcher for integration MCP servers (ADR-0034), started by the agent CLI from the per-run
// config. It trades its one-time ticket for the server's command and environment (secrets
// included), then runs the server on this process's stdio. The config file never holds secrets.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const child = spawn(launch.command, launch.args, {
  stdio: "inherit",
  env: { ...inherited, ...launch.env, ...fileEnv },
});
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
