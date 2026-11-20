// One MCP tool call outside an agent run (owner-approved publishing, ADR-0037): starts the
// process (the launcher with a fresh ticket in production), initializes, calls, stops it.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface ProcessSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function callTool(
  spec: ProcessSpec,
  tool: string,
  args: unknown,
  timeoutMs = 120_000,
): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    // A server that dies early must not crash the gateway with EPIPE.
    child.stdin.on("error", () => {});
    let settled = false;
    const done = (r: { ok: boolean; text: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, text: "timed out" }), timeoutMs);
    const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
    createInterface({ input: child.stdout }).on("line", (line) => {
      let m: {
        id?: number;
        error?: { message?: string };
        result?: { content?: { type: string; text?: string }[]; isError?: boolean };
      };
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.id === 1) {
        if (m.error) return done({ ok: false, text: m.error.message ?? "initialize failed" });
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: tool, arguments: args },
        });
      } else if (m.id === 2) {
        if (m.error) return done({ ok: false, text: m.error.message ?? "call failed" });
        const text = (m.result?.content ?? [])
          .map((c) => c.text ?? "")
          .join("\n")
          .trim();
        done({ ok: !m.result?.isError, text });
      }
    });
    child.on("error", (err) => done({ ok: false, text: err.message }));
    child.on("exit", (code) => done({ ok: false, text: `server exited (${code})` }));
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "achords", version: "0.1.0" },
      },
    });
  });
}
