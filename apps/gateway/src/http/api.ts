import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  AuthError,
  createSchedule,
  createSession,
  createThread,
  type Db,
  deleteSchedule,
  getRoom,
  getSchedule,
  getThread,
  listAgents,
  listMessages,
  listRooms,
  listSchedules,
  listSessions,
  listTasks,
  listThreads,
  listUsageWindows,
  liveProgress,
  occurrences,
  redeemPairingCode,
  revokeSession,
  type ScheduleInput,
  setThreadProject,
  spendSince,
  updateSchedule,
  validateSession,
} from "@achords/core";
import { t } from "@achords/i18n";
import {
  createAgentFiles,
  createProject,
  loadManifest,
  loadProjects,
  updateManifestModels,
  updateManifestName,
  updateProject,
} from "@achords/policy";
import type { Vault } from "@achords/secrets";
import type { RunTokens } from "../mcp/tokens.ts";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import type { Transcriber } from "../voice/transcribe.ts";
import { serveStatic } from "./static.ts";

// Browsers share cookies across all ports of a host, so the name carries the port this gateway
// listens on: another gateway on 127.0.0.1 (a test, a second instance) cannot overwrite it.
const cookieName = (req: IncomingMessage) => `achords_session_${req.socket.localPort}`;
const COOKIE_MAX_AGE_S = 90 * 24 * 3600;
const BODY_LIMIT = 64 * 1024;
// About 10 minutes of Opus audio, like the Telegram voice limit.
const AUDIO_LIMIT = 10 * 1024 * 1024;
// Tools the claude CLI knows; an agent gets none unless the owner ticks it.
const AGENT_TOOL_NAMES = ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebFetch", "WebSearch"];
const CLAUDE_ALIASES = [
  "cli-claude/opus",
  "cli-claude/sonnet",
  "cli-claude/haiku",
  "cli-claude/fable",
];

export interface ApiDeps {
  db: Db;
  orchestrator: Pick<
    Orchestrator,
    | "handleMessage"
    | "delegate"
    | "askOwner"
    | "spawnWorker"
    | "proposeAgent"
    | "decideProposal"
    | "moveTask"
    | "ownerMove"
    | "runAction"
    | "workflow"
    | "syncAgents"
    | "openRoom"
  >;
  /** Agent-run capability tokens for /api/agent/* (the hub MCP server, ADR-0029). */
  runTokens?: RunTokens;
  /** Opened lazily: the master key is only fetched when the vault is actually used. */
  vault?: () => Vault;
  /** Exact Host header values accepted (DNS-rebinding protection). */
  allowedHosts: string[];
  /** Local speech to text for web voice notes (ADR-0014) and its scratch folder. */
  transcriber?: Transcriber;
  runDir?: string;
  /** Projects ($ACHORDS_HOME/projects, ADR-0031). */
  projectsDir?: string;
  /** Agent manifests ($ACHORDS_HOME/agents) for the model settings. */
  agentsDir?: string;
  /** Chat models pulled in the local model server (suggestions only). */
  localModels?: () => Promise<string[]>;
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

function sessionCookie(req: IncomingMessage, token: string, maxAge: number): string {
  return `${cookieName(req)}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function readCookie(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === cookieName(req)) return v.join("=");
  }
  return undefined;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(req.headers["content-length"] ?? 0) > limit)
    throw new HttpError(413, "body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new HttpError(415, "expected application/json");
  }
  const raw = await readBody(req, BODY_LIMIT);
  try {
    const parsed = JSON.parse(raw.toString("utf8") || "{}");
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
      ({ req, res, session }) => {
        revokeSession(db, session.id);
        send(res, 200, { ok: true }, { "set-cookie": sessionCookie(req, "", 0) });
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
    // Scheduler (ADR-0033): what runs when; the gateway tick starts them.
    ["GET", /^\/api\/schedules$/, () => listSchedules(db)],
    [
      "GET",
      /^\/api\/schedules\/upcoming$/,
      ({ req }) => {
        const days = Math.min(
          31,
          Math.max(1, Number(new URL(req.url ?? "/", "http://x").searchParams.get("days") ?? 7)),
        );
        const from = new Date();
        from.setHours(0, 0, 0, 0);
        const to = new Date(from);
        to.setDate(to.getDate() + days);
        return listSchedules(db)
          .filter((s) => s.enabled)
          .flatMap((s) =>
            occurrences(s.cron, from.getTime(), to.getTime(), 200).map((at) => ({
              scheduleId: s.id,
              name: s.name,
              agentId: s.agentId,
              at,
            })),
          )
          .sort((a, b) => a.at - b.at);
      },
    ],
    [
      "POST",
      /^\/api\/schedules$/,
      async ({ res, body }) => {
        const input = scheduleInput(await body(), true) as ScheduleInput;
        send(
          res,
          201,
          attempt(() => createSchedule(db, input)),
        );
      },
    ],
    [
      "PUT",
      /^\/api\/schedules\/([\w-]{1,64})$/,
      async ({ params, body }) => {
        const id = params[0] as string;
        if (!getSchedule(db, id)) throw new HttpError(404, "no such schedule");
        const patch = scheduleInput(await body(), false);
        return attempt(() => updateSchedule(db, id, patch));
      },
    ],
    [
      "DELETE",
      /^\/api\/schedules\/([\w-]{1,64})$/,
      ({ params }) => {
        if (!getSchedule(db, params[0] as string)) throw new HttpError(404, "no such schedule");
        deleteSchedule(db, params[0] as string);
        return { ok: true };
      },
    ],
    // Usage meters (step 6): quota windows as the CLI reported them, and today's cost.
    [
      "GET",
      /^\/api\/usage$/,
      () => {
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        return { windows: listUsageWindows(db), spentTodayUsd: spendSince(db, midnight.getTime()) };
      },
    ],
    // Live run progress (step 5b), polled by the web's bottom bar.
    ["GET", /^\/api\/runs\/live$/, () => liveProgress(db)],
    // Agent rooms (ADR-0032): hidden from chats; the owner can read them here.
    ["GET", /^\/api\/rooms$/, () => listRooms(db)],
    [
      "GET",
      /^\/api\/rooms\/([\w-]+)\/messages$/,
      ({ params }) => {
        const id = params[0] as string;
        if (!getRoom(db, id)) throw new HttpError(404, "no such room");
        return listMessages(db, id);
      },
    ],
    // Projects (ADR-0031): files are managed in Finder; the API lists, creates and assigns.
    [
      "GET",
      /^\/api\/projects$/,
      () =>
        [...loadProjects(projectsDirOrThrow()).values()].map(
          ({ slug, name, workspace, dir, filesDir }) => ({
            slug,
            name,
            workspace,
            dir,
            filesDir,
          }),
        ),
    ],
    [
      "POST",
      /^\/api\/projects$/,
      async ({ res, body }) => {
        const b = await body();
        try {
          const p = createProject(projectsDirOrThrow(), {
            slug: str(b.slug, "slug", 64),
            name: str(b.name, "name", 100),
            workspace: str(b.workspace, "workspace", 64),
          });
          log(`project created in the web UI: ${p.slug}`);
          send(res, 201, { slug: p.slug, dir: p.dir, filesDir: p.filesDir });
        } catch (err) {
          if (err instanceof HttpError) throw err;
          const msg = (err as Error).message;
          throw new HttpError(/already exists/.test(msg) ? 409 : 400, msg);
        }
      },
    ],
    [
      "GET",
      /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,63})$/,
      ({ params }) => {
        const p = loadProjects(projectsDirOrThrow()).get(params[0] as string);
        if (!p) throw new HttpError(404, "no such project");
        return {
          slug: p.slug,
          name: p.name,
          workspace: p.workspace,
          dir: p.dir,
          filesDir: p.filesDir,
          doc: p.doc,
        };
      },
    ],
    [
      "PUT",
      /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,63})$/,
      async ({ params, body }) => {
        const slug = params[0] as string;
        if (!loadProjects(projectsDirOrThrow()).has(slug))
          throw new HttpError(404, "no such project");
        const b = await body();
        const p = attempt(() =>
          updateProject(projectsDirOrThrow(), slug, {
            ...(b.name !== undefined ? { name: str(b.name, "name", 100) } : {}),
            ...(b.workspace !== undefined ? { workspace: str(b.workspace, "workspace", 64) } : {}),
            ...(b.doc !== undefined
              ? { doc: typeof b.doc === "string" ? b.doc.slice(0, 50_000) : "" }
              : {}),
          }),
        );
        return { slug: p.slug, name: p.name, workspace: p.workspace };
      },
    ],
    [
      "PUT",
      /^\/api\/threads\/([\w-]+)\/project$/,
      async ({ params, body }) => {
        const id = params[0] as string;
        if (!getThread(db, id)) throw new HttpError(404, "no such thread");
        const raw = (await body()).project;
        const project = raw === null ? null : str(raw, "project", 64);
        if (project && !loadProjects(projectsDirOrThrow()).has(project)) {
          throw new HttpError(404, `no project ${project}`);
        }
        setThreadProject(db, id, project);
        return { ok: true, project };
      },
    ],
    // Kanban (ADR-0030): the owner moves cards; `from` is the column the browser showed.
    [
      "POST",
      /^\/api\/tasks\/([\w-]{1,64})\/move$/,
      async ({ params, body }) => {
        const b = await body();
        const out = deps.orchestrator.ownerMove(
          params[0] as string,
          str(b.from, "from", 32),
          str(b.to, "to", 32),
        );
        if (!out.ok) throw new HttpError(409, out.reason);
        if (out.override)
          log(`kanban: owner override on task ${params[0]}: ${String(b.from)} → ${String(b.to)}`);
        return out;
      },
    ],
    [
      "GET",
      /^\/api\/workflow\/([\w-]{1,64})$/,
      ({ params }) => deps.orchestrator.workflow(params[0] as string),
    ],
    // Web voice note → text on this machine; the browser puts it in the composer to review.
    [
      "POST",
      /^\/api\/transcribe$/,
      async ({ req }) => {
        if (!/^audio\/[\w.+-]+/.test(req.headers["content-type"] ?? "")) {
          throw new HttpError(415, "expected audio");
        }
        const stt = deps.transcriber;
        if (!stt?.available().ok || !deps.runDir)
          throw new HttpError(503, t("telegram.voiceNoWhisper"));
        const audio = await readBody(req, AUDIO_LIMIT);
        mkdirSync(deps.runDir, { recursive: true, mode: 0o700 });
        const path = join(deps.runDir, `voice-${randomUUID()}.audio`);
        writeFileSync(path, audio, { mode: 0o600 });
        try {
          const out = await stt.transcribe(path);
          if (!out.ok) throw new HttpError(422, t("telegram.voiceFailed", { reason: out.reason }));
          return { text: out.text };
        } finally {
          rmSync(path, { force: true });
        }
      },
    ],
    // Message actions (buttons) from the web; same meaning as on Telegram.
    [
      "POST",
      /^\/api\/actions$/,
      async ({ body }) => {
        const data = str((await body()).data, "data", 64);
        if (!/^(proposal|move):(approve|reject):[\w-]{1,36}$/.test(data)) {
          throw new HttpError(400, "unknown action");
        }
        const out = deps.orchestrator.runAction(data);
        if (!out.ok) throw new HttpError(409, out.message);
        return out;
      },
    ],
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
    [
      "GET",
      /^\/api\/agents\/([a-z0-9][a-z0-9-]{0,63})$/,
      async ({ params }) => {
        const m = loadManifest(manifestPath(params[0] as string));
        const local = (await deps.localModels?.().catch(() => [])) ?? [];
        return {
          id: m.id,
          name: m.name,
          role: m.role,
          workspace: m.workspace,
          models: m.models,
          // Aliases always run the newest model of a family; local models as pulled.
          suggestions: [...CLAUDE_ALIASES, ...local.map((x) => `local/${x}`)],
        };
      },
    ],
    [
      "GET",
      /^\/api\/agent-options$/,
      async () => {
        const local = (await deps.localModels?.().catch(() => [])) ?? [];
        return {
          tools: AGENT_TOOL_NAMES,
          models: [...CLAUDE_ALIASES, ...local.map((x) => `local/${x}`)],
        };
      },
    ],
    [
      "POST",
      /^\/api\/agents$/,
      async ({ res, body }) => {
        if (!deps.agentsDir) throw new HttpError(404, "no agents folder");
        const b = await body();
        const list = (v: unknown, field: string) => (v === undefined ? [] : strList(v, field));
        const obj = (v: unknown) =>
          v && typeof v === "object" ? (v as Record<string, unknown>) : {};
        const models = obj(b.models);
        const fs = obj(b.fs);
        const perRun = Number(obj(b.budget).per_run_usd ?? 0);
        try {
          const made = createAgentFiles(deps.agentsDir, {
            id: str(b.id, "id", 64),
            name: str(b.name, "name", 100),
            role: str(b.role, "role", 100),
            workspace: str(b.workspace, "workspace", 64),
            roles: list(b.roles, "roles"),
            models: {
              default: str(models.default, "models.default", 200),
              allowed: list(models.allowed, "models.allowed"),
            },
            tools: list(b.tools, "tools"),
            fs: { read: list(fs.read, "fs.read"), write: list(fs.write, "fs.write") },
            ...(b.shell !== undefined
              ? { shell: { allow: list(obj(b.shell).allow, "shell.allow") } }
              : {}),
            network: { allow: list(obj(b.network).allow, "network.allow") },
            delegation: {
              can_delegate_to: list(
                obj(b.delegation).can_delegate_to,
                "delegation.can_delegate_to",
              ),
              accepts_from: list(obj(b.delegation).accepts_from, "delegation.accepts_from"),
            },
            ...(perRun > 0 ? { budget: { per_run_usd: perRun } } : {}),
            description: str(b.description, "description", 5000),
          });
          deps.orchestrator.syncAgents(); // mirror into the DB, seed a new workspace's workflow
          log(`agent created in the web UI: ${made.id}`);
          send(res, 201, made);
        } catch (err) {
          if (err instanceof HttpError) throw err;
          const msg = (err as Error).message;
          throw new HttpError(/already exists/.test(msg) ? 409 : 400, msg);
        }
      },
    ],
    [
      "PUT",
      /^\/api\/agents\/([a-z0-9][a-z0-9-]{0,63})\/name$/,
      async ({ params, body }) => {
        const path = manifestPath(params[0] as string);
        try {
          updateManifestName(path, str((await body()).name, "name", 100));
        } catch (err) {
          if (err instanceof HttpError) throw err;
          throw new HttpError(400, (err as Error).message);
        }
        deps.orchestrator.syncAgents(); // the agent list is read from the DB mirror
        return { ok: true, name: loadManifest(path).name };
      },
    ],
    [
      "PUT",
      /^\/api\/agents\/([a-z0-9][a-z0-9-]{0,63})\/models$/,
      async ({ params, body }) => {
        const path = manifestPath(params[0] as string);
        const b = await body();
        try {
          updateManifestModels(path, {
            default: str(b.default, "default", 200),
            allowed: strList(b.allowed, "allowed"),
          });
        } catch (err) {
          if (err instanceof HttpError) throw err;
          throw new HttpError(400, (err as Error).message);
        }
        return { ok: true, models: loadManifest(path).models };
      },
    ],
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

  /** Validation errors from core (e.g. a bad cron expression) become 400s with the reason. */
  const attempt = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, (err as Error).message);
    }
  };
  const scheduleInput = (b: Record<string, unknown>, full: boolean): Partial<ScheduleInput> => {
    const out: Partial<ScheduleInput> = {};
    const text = (key: keyof ScheduleInput, max: number) => {
      if (b[key] !== undefined || full)
        (out as Record<string, unknown>)[key] = str(b[key], key, max);
    };
    text("name", 100);
    text("cron", 100);
    text("agentId", 64);
    text("title", 200);
    text("instructions", 20_000);
    if (b.enabled !== undefined) out.enabled = b.enabled === true;
    if (b.project !== undefined)
      out.project = b.project === null || b.project === "" ? null : str(b.project, "project", 64);
    if (out.agentId && !listAgents(db).some((a) => a.id === out.agentId)) {
      throw new HttpError(400, `no agent ${out.agentId}`);
    }
    if (out.project && deps.projectsDir && !loadProjects(deps.projectsDir).has(out.project)) {
      throw new HttpError(400, `no project ${out.project}`);
    }
    return out;
  };

  const projectsDirOrThrow = () => {
    if (!deps.projectsDir) throw new HttpError(404, "projects are not configured");
    return deps.projectsDir;
  };

  const manifestPath = (id: string) => {
    const path = join(deps.agentsDir ?? "", id, "agent.yaml");
    if (!deps.agentsDir || !existsSync(path)) throw new HttpError(404, "no such agent");
    return path;
  };

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
        const AGENT_TOOLS = [
          "delegate",
          "ask_owner",
          "spawn_worker",
          "propose_agent",
          "move_task",
          "open_room",
        ];
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
              : tool === "open_room"
                ? o.openRoom(from, {
                    topic: str(b.topic, "topic", 200),
                    question: str(b.question, "question", 5000),
                    participants: strList(b.participants, "participants"),
                    rounds: Number(b.rounds),
                  })
                : tool === "move_task"
                  ? o.moveTask(from, {
                      taskId: str(b.task_id, "task_id", 64),
                      to: str(b.to, "to", 32),
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
          { "set-cookie": sessionCookie(req, s.token, COOKIE_MAX_AGE_S) },
        );
        return;
      }

      const token = readCookie(req);
      const session = token ? validateSession(db, token) : undefined;
      if (!session) {
        // Says which case it is (browser sent nothing vs. a dead session), never the token.
        log(
          `web: not paired: ${token ? "unknown, revoked or expired session" : "no session cookie"} (${method} ${path}, ${req.headers["user-agent"]?.slice(0, 60) ?? "no user agent"})`,
        );
        throw new HttpError(401, "not paired");
      }
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
