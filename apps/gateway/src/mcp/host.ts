// ADR-0055: integration servers that carry secrets run on the gateway's side. The gateway starts
// the integration launcher itself (secrets, proxy rules and all), so no secret enters the agent
// run's process tree, config, environment or mounts. The run only gets a relay (relay.ts) that
// carries its stdio over the agent API: POST for each line it sends, one stream for the lines
// the server sends back (answers, notifications and the server's own requests).
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { createInterface } from "node:readline";

export interface HostedProcess {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpHost {
  /**
   * One server for one run and integration, started on the relay's first contact. Revoking
   * (at the run's end) stops it and ends its stream.
   */
  register<L>(id: string, launch: L): { token: string; revoke: () => void };
  /** A line from the run for the server; false for an unknown token or integration. */
  write(token: string, id: string, line: string): boolean;
  /** The server's lines for the run as newline-delimited JSON; the newest stream wins. */
  stream(token: string, id: string, res: ServerResponse): boolean;
}

interface Hosted {
  id: string;
  launch: unknown;
  child?: ChildProcess;
  release?: (() => void) | undefined;
  exited: boolean;
  /** Lines the server sent before the relay's stream was open. */
  pending: string[];
  res?: ServerResponse | undefined;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
// Never more than this waits for a stream that does not come.
const MAX_PENDING = 1000;

export function createMcpHost(opts: {
  /** The process for a launch (the launcher with a fresh ticket in production). */
  processFor: (launch: never) => { spec: HostedProcess; release?: () => void };
  log?: (line: string) => void;
}): McpHost {
  const live = new Map<string, Hosted>();
  const find = (token: string, id: string) => {
    const h = live.get(sha256(token));
    return h && h.id === id ? h : undefined;
  };
  const deliver = (h: Hosted, line: string) => {
    if (h.res) h.res.write(`${line}\n`);
    else if (h.pending.length < MAX_PENDING) h.pending.push(line);
  };
  const start = (h: Hosted) => {
    if (h.child || h.exited) return;
    const { spec, release } = opts.processFor(h.launch as never);
    h.release = release;
    const child = spawn(spec.command, spec.args, {
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    h.child = child;
    // A server that dies early must not crash the gateway with EPIPE.
    child.stdin?.on("error", () => {});
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) =>
      deliver(h, line),
    );
    // The launcher's own messages say why a server could not start; never the server's output.
    createInterface({ input: child.stderr as NodeJS.ReadableStream }).on("line", (line) => {
      if (line.startsWith("achords:")) opts.log?.(`mcp ${h.id}: ${line}`);
    });
    const ended = () => {
      if (h.exited) return;
      h.exited = true;
      h.release?.();
      h.res?.end();
    };
    child.on("error", ended);
    child.on("exit", ended);
  };
  return {
    register(id, launch) {
      const token = randomBytes(32).toString("base64url");
      const key = sha256(token);
      const h: Hosted = { id, launch, exited: false, pending: [] };
      live.set(key, h);
      return {
        token,
        revoke: () => {
          live.delete(key);
          h.child?.kill("SIGTERM");
          h.release?.();
          h.res?.end();
        },
      };
    },
    write(token, id, line) {
      const h = find(token, id);
      if (!h) return false;
      start(h);
      if (!h.exited) h.child?.stdin?.write(`${line}\n`);
      return true;
    },
    stream(token, id, res) {
      const h = find(token, id);
      if (!h) return false;
      start(h);
      h.res?.end();
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
      res.flushHeaders();
      h.res = res;
      for (const line of h.pending.splice(0)) res.write(`${line}\n`);
      if (h.exited) res.end();
      res.on("close", () => {
        if (h.res === res) h.res = undefined;
      });
      return true;
    },
  };
}
