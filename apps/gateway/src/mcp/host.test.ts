import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpHost, type McpHost } from "./host.ts";

const RELAY = new URL("./relay.ts", import.meta.url).pathname;
// Stands in for the launcher: echoes each line and says whether it got the secret.
const ECHO = `require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "bye") process.exit(0);
  console.log(JSON.stringify({ id: m.id, result: { echo: m.method, secret: process.env.API_KEY ?? null } }));
});
console.log(JSON.stringify({ method: "notifications/hello" }));`;

describe("integration servers on the gateway's side (ADR-0055)", () => {
  let server: Server;
  let url: string;
  let host: McpHost;
  let started: number;
  let released: number;
  const relays: ChildProcess[] = [];

  beforeEach(async () => {
    started = 0;
    released = 0;
    host = createMcpHost({
      processFor: (launch: { key: string }) => {
        started++;
        return {
          spec: { command: process.execPath, args: ["-e", ECHO], env: { API_KEY: launch.key } },
          release: () => released++,
        };
      },
    });
    // The relevant part of the agent API (api.ts routes the same way).
    server = createServer(async (req, res) => {
      const id = (req.url ?? "").split("/").pop() ?? "";
      const token = (req.headers.authorization ?? "").slice(7);
      if (req.method === "GET") {
        if (!host.stream(token, id, res)) res.writeHead(401).end();
        return;
      }
      let body = "";
      for await (const c of req) body += c;
      res.writeHead(host.write(token, id, body.trim()) ? 202 : 401).end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    for (const r of relays) r.kill();
    relays.length = 0;
    server.close();
  });

  const relay = (token: string, id = "fal") => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", RELAY], {
      env: {
        PATH: process.env.PATH,
        ACHORDS_HUB_URL: url,
        ACHORDS_MCP_ID: id,
        ACHORDS_MCP_TOKEN: token,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    relays.push(child);
    const lines: string[] = [];
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (l) =>
      lines.push(l),
    );
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    const until = async (n: number) => {
      for (let i = 0; i < 100 && lines.length < n; i++) await new Promise((r) => setTimeout(r, 30));
      return lines;
    };
    return { child, lines, until, exited };
  };

  it("the run's relay reaches a server that holds the secret; the relay never has it", async () => {
    const { token, revoke } = host.register("fal", { key: "sk-live-123" });
    const r = relay(token);
    r.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    r.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    const lines = await r.until(3);
    // The server's own message (sent before the first request was answered) comes through too.
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { method: "notifications/hello" },
      { id: 1, result: { echo: "initialize", secret: "sk-live-123" } },
      { id: 2, result: { echo: "tools/list", secret: "sk-live-123" } },
    ]);
    expect(started).toBe(1);
    // The run's end stops the server and ends the relay.
    revoke();
    expect(await r.exited).toBe(0);
    expect(released).toBeGreaterThan(0);
  });

  it("refuses an unknown token or another integration's id; nothing is started", async () => {
    const { token } = host.register("fal", { key: "k" });
    expect(await relay("forged").exited).toBe(1);
    expect(await relay(token, "elevenlabs").exited).toBe(1);
    expect(started).toBe(0);
  });

  it("a server that exits ends the relay; a revoked token is dead", async () => {
    const { token, revoke } = host.register("fal", { key: "k" });
    const r = relay(token);
    await r.until(1);
    r.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "bye" })}\n`);
    expect(await r.exited).toBe(0);
    revoke();
    expect(await relay(token).exited).toBe(1);
  });
});
