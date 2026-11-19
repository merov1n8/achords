import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AuthError,
  createSession,
  createThread,
  type Db,
  getThread,
  listAgents,
  listMessages,
  listSessions,
  listTasks,
  listThreads,
  redeemPairingCode,
  revokeSession,
  validateSession,
} from "@achords/core";
import type { Vault } from "@achords/secrets";
import type { RunTokens } from "../mcp/tokens.ts";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import { serveStatic } from "./static.ts";

const COOKIE = "achords_session";
const COOKIE_MAX_AGE_S = 90 * 24 * 3600;
const BODY_LIMIT = 64 * 1024;

export interface ApiDeps {
  db: Db;
  orchestrator: Pick<
    Orchestrator,
    "handleMessage" | "delegate" | "askOwner" | "spawnWorker" | "proposeAgent" | "decideProposal"
  >;
  /** Agent-run capability tokens for /api/agent/* (the hub MCP server, ADR-0029). */
  runTokens?: RunTokens;
  /** Opened lazily: the master key is only fetched when the vault is actually used. */
  vault?: () => Vault;
  /** Exact Host header values accepted (DNS-rebinding protection). */
  allowedHosts: string[];
  /** Built web UI (apps/web/dist). Non-API GETs are served from here. */
  staticDir?: string;
  log?: (msg: string) => void;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Session {
  id: string;
  csrf: string;
  deviceName: string;
}

type Handler = (ctx: {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
  session: Session;
  body: () => Promise<Record<string, unknown>>;
}) => Promise<unknown> | unknown;

const securityHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { ...securityHeaders, "content-type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function sessionCookie(token: string, maxAge: number): string {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function readCookie(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return undefined;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new HttpError(415, "expected application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

const str = (v: unknown, field: string, max = 10_000): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > max) {
    throw new HttpError(400, `${field} must be a non-empty string`);
  }
  return v;
};

const strList = (v: unknown, field: string): string[] => {
  if (
    !Array.isArray(v) ||
    v.length > 50 ||
    !v.every((x) => typeof x === "string" && x.length < 1000)
  ) {
    throw new HttpError(400, `${field} must be a list of strings`);
  }
  return v as string[];
};

export function createApiHandler(deps: ApiDeps) {
  const { db } = deps;
  const log = deps.log ?? (() => {});
  const vault = () => {
    if (!deps.vault) throw new HttpError(503, "vault not available");
    return deps.vault();
  };

  const routes: [string, RegExp, Handler][] = [
    [
      "GET",
      /^\/api\/session$/,
      ({ session }) => ({ device: deviceOf(session), csrf: session.csrf }),
    ],
    [
      "POST",
      /^\/api\/logout$/,
      ({ res, session }) => {
        revokeSession(db, session.id);
        send(res, 200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
      },
    ],
    [
      "GET",
      /^\/api\/devices$/,
      ({ session }) => listSessions(db).map((d) => ({ ...d, current: d.id === session.id })),
    ],
    [
      "DELETE",
      /^\/api\/devices\/([\w-]+)$/,
      ({ params }) => {
        if (!revokeSession(db, params[0] as string)) throw new HttpError(404, "no such device");
        return { ok: true };
      },
    ],
    ["GET", /^\/api\/threads$/, () => listThreads(db)],
    [
      "POST",
      /^\/api\/threads$/,
      async ({ res, body }) => {
        const b = await body();
        if (
          b.sensitivity !== undefined &&
          b.sensitivity !== "normal" &&
          b.sensitivity !== "local-only"
        ) {
          throw new HttpError(400, "sensitivity must be normal or local-only");
        }
        const thread = createThread(db, {
          ...(b.title ? { title: str(b.title, "title", 200) } : {}),
          ...(b.sensitivity === "local-only" ? { sensitivity: "local-only" as const } : {}),
        });
        send(res, 201, thread);
      },
    ],
    [
      "GET",
      /^\/api\/threads\/([\w-]+)\/messages$/,
      ({ req, params }) => {
        const id = params[0] as string;
        if (!getThread(db, id)) throw new HttpError(404, "no such thread");
        const traces = new URL(req.url ?? "/", "http://x").searchParams.get("traces") === "1";
        return listMessages(db, id, { includeTraces: traces });
      },
    ],
    [
      "POST",
      /^\/api\/threads\/([\w-]+)\/messages$/,
      async ({ res, params, body }) => {
        const id = params[0] as string;
        if (!getThread(db, id)) throw new HttpError(404, "no such thread");
        const text = str((await body()).text, "text");
        // The boss may take a while; the reply appears in the thread when ready.
        deps.orchestrator
          .handleMessage(id, text, "web")
          .catch((err) => log(`handleMessage failed: ${(err as Error).message}`));
        send(res, 202, { accepted: true });
      },
    ],
    ["GET", /^\/api\/tasks$/, () => listTasks(db)],
    // Agent proposals: owner-only (session + CSRF); agents can only file them.
    [
      "GET",
      /^\/api\/proposals$/,
      () =>
        db
          .prepare(
            "SELECT id, proposed_by, agent_id, yaml, reason, created_at FROM agent_proposals WHERE status = 'pending' ORDER BY created_at",
          )
          .all(),
    ],
    [
      "POST",
      /^\/api\/proposals\/([\w-]{1,32})\/(approve|reject)$/,
      ({ params }) => {
        const out = deps.orchestrator.decideProposal(params[0] as string, params[1] === "approve");
        if (!out.ok) throw new HttpError(409, out.reason);
        return out;
      },
    ],
    ["GET", /^\/api\/agents$/, () => listAgents(db)],
    ["GET", /^\/api\/vault$/, () => vault().list()],
    [
      "PUT",
      /^\/api\/vault\/([^/]+)$/,
      async ({ params, session, body }) => {
        const id = decodeURIComponent(params[0] as string);
        const value = str((await body()).value, "value", 16_384);
        try {
          vault().set(id, value, `web:${session.deviceName}`);
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
        return vault().status(id);
      },
    ],
    [
      "DELETE",
      /^\/api\/vault\/([^/]+)$/,
      ({ params, session }) => {
        const id = decodeURIComponent(params[0] as string);
        if (!vault().delete(id, `web:${session.deviceName}`)) throw new HttpError(404, "not set");
        return { ok: true };
      },
    ],
  ];

  const deviceOf = (s: Session) => ({ id: s.id, deviceName: s.deviceName });

  // Same-origin check for state-changing requests: the Origin must name this very host.
  const sameOrigin = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    if (!origin) return false;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!deps.allowedHosts.includes(req.headers.host ?? "")) {
        throw new HttpError(421, "unknown host");
      }
      const method = req.method ?? "GET";
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const mutating = method !== "GET" && method !== "HEAD";
      if (!path.startsWith("/api/")) {
        if (mutating || !deps.staticDir) throw new HttpError(404, "not found");
        serveStatic(deps.staticDir, path, res);
        return;
      }
      // Agent runs (not browsers): authenticated by their run token only; no cookie, no CSRF.
      if (path.startsWith("/api/agent/")) {
        const auth = req.headers.authorization ?? "";
        const caller = auth.startsWith("Bearer ")
          ? deps.runTokens?.resolve(auth.slice(7))
          : undefined;
        if (!caller) throw new HttpError(401, "invalid run token");
        const tool = path.slice("/api/agent/".length);
        const AGENT_TOOLS = ["delegate", "ask_owner", "spawn_worker", "propose_agent"];
        if (method !== "POST" || !AGENT_TOOLS.includes(tool)) throw new HttpError(404, "not found");
        if (!caller.tools.includes(tool)) {
          throw new HttpError(403, `tool ${tool} not granted to this run`);
        }
        const b = await readJson(req);
        // The calling task comes from the token, never from the body.
        const from = { from: "task" as const, taskId: caller.taskId };
        const o = deps.orchestrator;
        const out =
          tool === "delegate"
            ? o.delegate(from, {
                agent: str(b.agent, "agent", 64),
                title: str(b.title, "title", 200),
                instructions: str(b.instructions, "instructions", 20_000),
              })
            : tool === "spawn_worker"
              ? o.spawnWorker(from, {
                  instructions: str(b.instructions, "instructions", 20_000),
                  tools: strList(b.tools, "tools"),
                  paths: strList(b.paths, "paths"),
                })
              : tool === "propose_agent"
                ? o.proposeAgent(from, {
                    yaml: str(b.manifest_yaml, "manifest_yaml", 20_000),
                    reason: str(b.reason, "reason", 2000),
                  })
                : o.askOwner(from, str(b.question, "question", 2000));
        send(res, 200, out);
        return;
      }
      if (mutating && !sameOrigin(req)) throw new HttpError(403, "cross-origin request");

      if (method === "POST" && path === "/api/pair") {
        const b = await readJson(req);
        try {
          redeemPairingCode(db, "web", str(b.code, "code", 20));
        } catch (err) {
          if (!(err instanceof AuthError)) throw err;
          throw new HttpError(err.message.startsWith("too many") ? 429 : 401, err.message);
        }
        const s = createSession(db, typeof b.deviceName === "string" ? b.deviceName : "browser");
        log(`paired device ${s.id}`);
        send(
          res,
          200,
          { device: { id: s.id }, csrf: s.csrf },
          { "set-cookie": sessionCookie(s.token, COOKIE_MAX_AGE_S) },
        );
        return;
      }

      const token = readCookie(req);
      const session = token ? validateSession(db, token) : undefined;
      if (!session) throw new HttpError(401, "not paired");
      if (mutating && req.headers["x-achords-csrf"] !== session.csrf) {
        throw new HttpError(403, "missing or wrong CSRF token");
      }

      for (const [m, pattern, handler] of routes) {
        const match = m === method ? pattern.exec(path) : null;
        if (!match) continue;
        const out = await handler({
          req,
          res,
          params: match.slice(1),
          session,
          body: () => readJson(req),
        });
        if (!res.headersSent) send(res, 200, out);
        return;
      }
      throw new HttpError(404, "not found");
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.message });
      } else {
        log(`internal error: ${(err as Error).message}`);
        send(res, 500, { error: "internal error" });
      }
    }
  };
}
