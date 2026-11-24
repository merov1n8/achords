import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import {
  AuthError,
  addChecklistItem,
  addComment,
  attachmentsDir,
  cardKey,
  chatCards,
  createMonitor,
  createPairingCode,
  createSchedule,
  createSession,
  createThread,
  type Db,
  deleteCard,
  deleteComment,
  deleteMonitor,
  deleteSchedule,
  deleteThread,
  endCardSessions,
  getMonitor,
  getRoom,
  getSchedule,
  getSetting,
  getTask,
  getThread,
  IMAGE_KEEP_KEY,
  IMAGE_NAME,
  IMAGE_TYPES,
  imageKeepDays,
  listAgents,
  listChecklist,
  listComments,
  listMessages,
  listMonitors,
  listRooms,
  listSchedules,
  listSessions,
  listTasks,
  listThreads,
  listUsageWindows,
  liveProgress,
  MAX_IMAGE_BYTES,
  type MonitorInput,
  occurrences,
  redeemPairingCode,
  removeChecklistItem,
  revokeSession,
  type ScheduleInput,
  STALL_MINUTES_KEY,
  STALL_PERCENT_KEY,
  saveImage,
  setSetting,
  setThreadProject,
  spendBy,
  spendSince,
  stallSettings,
  stopThread,
  type Task,
  threadSummary,
  updateChecklistItem,
  updateMonitor,
  updateSchedule,
  updateTask,
  updateThread,
  validateSession,
  withCardTitles,
  withOwnerWaits,
} from "@achords/core";
import { t } from "@achords/i18n";
import {
  type AccountEntry,
  type AccountListsInput,
  AGENT_SKILLS,
  type AgentFields,
  agentSkillScope,
  type Catalog,
  type CatalogEntry,
  ceilingOf,
  compileLevel,
  createAgentFiles,
  createProject,
  deleteSkill,
  type Env,
  effectiveLevel,
  entryValues,
  GIT_REPO,
  gitTokenId,
  type IntegrationStatus,
  isLocalModel,
  isSkillName,
  isSkillScope,
  isSkillWorkspace,
  levelConflicts,
  listSkills,
  loadAgents,
  loadManifest,
  loadOverrides,
  loadOwnAccountEntries,
  loadProjects,
  MAX_LEVEL,
  OWN,
  ownerSecrets,
  type ProjectClass,
  parseSkillText,
  readSkill,
  removeProject,
  saveOverrides,
  saveOwnAccounts,
  secretRefs,
  setIntegrationAgents,
  setSkillEnabled,
  siteStatus,
  skillFiles,
  updateAgent,
  updateManifestModels,
  updateManifestName,
  updateProject,
  visibleSkills,
  writeSkill,
} from "@achords/policy";
import { createGoogleSignins, parseClientJson, type Vault } from "@achords/secrets";
import { GUIDE_LIMIT, readGuide, writeGuide } from "../guide.ts";
import type { McpHost } from "../mcp/host.ts";
import type { McpTickets, RunTokens } from "../mcp/tokens.ts";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import { fetchSkillSource } from "../orchestrator/skill-fetch.ts";
import { skillMode, skillModeKey, skillProposals } from "../orchestrator/skills.ts";
import type { Transcriber } from "../voice/transcribe.ts";
import { serveStatic } from "./static.ts";

// Browsers share cookies across all ports of a host, so the name carries the port this gateway
// listens on: another gateway on 127.0.0.1 (a test, a second instance) cannot overwrite it.
const cookieName = (req: IncomingMessage) => `achords_session_${req.socket.localPort}`;
const COOKIE_MAX_AGE_S = 90 * 24 * 3600;
/** The owner's remote address for the web UI (e.g. this Mac's Tailscale name). */
const REMOTE_HOST_KEY = "web.remote_host";
const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;
const BODY_LIMIT = 64 * 1024;
const MESSAGE_LIMIT = 1024 * 1024;
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
    | "handoff"
    | "askOwner"
    | "askParent"
    | "answerChild"
    | "recordRoomOutcome"
    | "spawnWorker"
    | "proposeAgent"
    | "decideProposal"
    | "moveTask"
    | "ownerMove"
    | "runAction"
    | "workflow"
    | "syncAgents"
    | "openRoom"
    | "requestAccess"
    | "requestCommand"
    | "requestPermission"
    | "reportChecks"
    | "requestPublish"
    | "testIntegration"
    | "logPublish"
    | "skillRead"
    | "skillFetch"
    | "skillPropose"
    | "createCard"
    | "startCard"
    | "pushBranch"
  >;
  /** Agent-run capability tokens for /api/agent/* (the hub MCP server, ADR-0029). */
  runTokens?: RunTokens;
  /** One-time tickets of integration MCP servers (ADR-0034), redeemed by the launcher. */
  mcpTickets?: McpTickets;
  /** ADR-0055: integration servers with secrets, run on the gateway's side for agent runs. */
  mcpHost?: Pick<McpHost, "write" | "stream">;
  /** Opened lazily: the master key is only fetched when the vault is actually used. */
  vault?: () => Vault;
  /** Exact Host header values accepted (DNS-rebinding protection). */
  allowedHosts: string[];
  /** This machine's Tailscale name, if Tailscale can tell (suggestion for the remote address). */
  tailscaleHost?: () => Promise<string | undefined>;
  /** Local speech to text for web voice notes (ADR-0014) and its scratch folder. */
  transcriber?: Transcriber;
  runDir?: string;
  /** Phase 4: subscription or API key per provider. */
  billing?: {
    list: () => {
      provider: string;
      label: string;
      mode: string;
      keyId: string;
      keySet: boolean;
      /** ADR-0051: Claude's sign-in for runs in a container (write-only like every secret). */
      containerTokenId?: string;
      containerTokenSet?: boolean;
    }[];
    setMode: (provider: string, mode: "subscription" | "api") => void;
    budgets: () => Record<
      string,
      { day: number; month: number; spentDay: number; spentMonth: number; fallback: boolean }
    >;
    setBudget: (provider: string, period: "day" | "month", usd: number) => void;
    /** ADR-0068: the subscription takes over when the API budget is used up. */
    setFallback: (provider: string, on: boolean) => void;
  };
  /** Auto-update from main (owner decision 2026-11-21). */
  update?: {
    status: () => Promise<Record<string, unknown>>;
    setAuto: (on: boolean) => void;
    checkNow: () => Promise<unknown>;
  };
  /** $ACHORDS_HOME (own accounts file, ADR-0042). */
  home?: string;
  /** Projects ($ACHORDS_HOME/projects, ADR-0031). */
  projectsDir?: string;
  /** Agent manifests ($ACHORDS_HOME/agents) for the model settings. */
  agentsDir?: string;
  /** Integration status for the web Integrations page (ADR-0034); never secret values. */
  integrations?: () => IntegrationStatus[];
  /** Integration catalog (ADR-0034), for the per-project site lists (ADR-0047). */
  catalog?: () => Catalog;
  /** Chat models pulled in the local model server (suggestions only). */
  localModels?: () => Promise<string[]>;
  /** OpenAI models the codex CLI offers (ADR-0040), as `cli-codex/<slug>`. */
  codexModels?: () => string[];
  /** Google endpoints (tests point them at a fake). */
  google?: { authUrl?: string; tokenUrl?: string };
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

async function readJson(
  req: IncomingMessage,
  limit = BODY_LIMIT,
): Promise<Record<string, unknown>> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new HttpError(415, "expected application/json");
  }
  const raw = await readBody(req, limit);
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

/** An optional text field: absent, null or "" all mean "not chosen". */
const optStr = (v: unknown, field: string, max: number): string | undefined =>
  v === undefined || v === null || v === "" ? undefined : str(v, field, max);

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

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Skills: <scope>/<name>; the scope may be agents/<agent-id> (ADR-0053).
const SKILL_ROUTE = /^\/api\/skills\/((?:agents\/)?[\w-]{1,64})\/([\w.-]{1,64})$/;

export function createApiHandler(deps: ApiDeps) {
  const { db } = deps;
  const log = deps.log ?? (() => {});
  const vault = () => {
    if (!deps.vault) throw new HttpError(503, "vault not available");
    return deps.vault();
  };
  // Web Google sign-in (ADR-0048): same OAuth flow as `achords connect google`.
  const google = createGoogleSignins({
    store: (id, value) => vault().set(id, value, "web:google-signin"),
    ...deps.google,
  });
  const GOOGLE_CALLBACK = "/api/oauth/google/callback";

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
      /^\/api\/remote-access$/,
      async () => ({
        host: getSetting(db, REMOTE_HOST_KEY) ?? "",
        // What this Mac's Tailscale reports, when it can be asked (a suggestion only).
        suggested: (await deps.tailscaleHost?.().catch(() => undefined)) ?? "",
      }),
    ],
    [
      "PUT",
      /^\/api\/remote-access$/,
      async ({ body }) => {
        const given = (await body()).host;
        const raw = (given === undefined || given === "" ? "" : str(given, "host", 300))
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .replace(/\/+$/, "");
        if (raw && !HOST_NAME.test(raw)) {
          throw new HttpError(400, "Enter the address only, e.g. mini.tail1234.ts.net");
        }
        setSetting(db, REMOTE_HOST_KEY, raw);
        log(raw ? `web: remote address set to ${raw}` : "web: remote address cleared");
        return { host: raw };
      },
    ],
    [
      "POST",
      /^\/api\/pair-codes$/,
      ({ session }) => {
        log(`web: pairing code made on ${session.deviceName}`);
        return { code: createPairingCode(db, "web") };
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
    [
      "GET",
      /^\/api\/threads$/,
      ({ req }) => {
        const q = new URL(req.url ?? "/", "http://x").searchParams;
        return listThreads(db, {
          archived: q.get("archived") === "1",
          limit: Math.min(500, Math.max(1, Number(q.get("limit") ?? 100) || 100)),
          ...(q.get("project") ? { project: (q.get("project") as string).slice(0, 64) } : {}),
          ...(q.get("q") ? { q: (q.get("q") as string).slice(0, 200) } : {}),
        });
      },
    ],
    [
      "PUT",
      /^\/api\/threads\/([\w-]{1,64})$/,
      async ({ params, body }) => {
        const b = await body();
        const patch = {
          ...(b.title !== undefined ? { title: str(b.title, "title", 200) } : {}),
          ...(b.pinned !== undefined ? { pinned: b.pinned === true } : {}),
          ...(b.archived !== undefined ? { archived: b.archived === true } : {}),
        };
        if (!updateThread(db, params[0] as string, patch)) {
          throw new HttpError(404, "no such chat");
        }
        // ADR-0066: an archived chat's cards keep no agent sessions.
        if (patch.archived && deps.home) {
          endCardSessions(db, deps.home, chatCards(db, params[0] as string));
        }
        return getThread(db, params[0] as string);
      },
    ],
    [
      "DELETE",
      /^\/api\/threads\/([\w-]{1,64})$/,
      ({ params }) => {
        const id = params[0] as string;
        const cards = chatCards(db, id);
        if (!deleteThread(db, id)) throw new HttpError(404, "no such chat");
        if (deps.home) endCardSessions(db, deps.home, cards);
        // Telegram wrote into this one: its next message starts a fresh chat.
        if (getSetting(db, "telegram.thread_id") === id) setSetting(db, "telegram.thread_id", "");
        log(`chat deleted in the web UI: ${id}`);
        return { ok: true };
      },
    ],
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
      async ({ req, res, params }) => {
        const id = params[0] as string;
        if (!getThread(db, id)) throw new HttpError(404, "no such thread");
        // The owner may paste a whole document; it reaches the agents in full.
        const text = str((await readJson(req, MESSAGE_LIMIT)).text, "text", MESSAGE_LIMIT);
        // The boss may take a while; the reply appears in the thread when ready.
        deps.orchestrator
          .handleMessage(id, text, "web")
          .catch((err) => log(`handleMessage failed: ${(err as Error).message}`));
        send(res, 202, { accepted: true });
      },
    ],
    // The chat page's run details column (and the phone's info sheet).
    [
      "GET",
      /^\/api\/threads\/([\w-]{1,64})\/summary$/,
      ({ params }) => {
        const id = params[0] as string;
        if (!getThread(db, id)) throw new HttpError(404, "no such chat");
        // API spending limits per provider (Phase 4), added up; subscriptions have none.
        const day = Object.values(deps.billing?.budgets() ?? {}).reduce((n, b) => n + b.day, 0);
        return { ...threadSummary(db, id), ...(day > 0 ? { budgetDayUsd: day } : {}) };
      },
    ],
    [
      "POST",
      /^\/api\/threads\/([\w-]{1,64})\/stop$/,
      ({ params }) => {
        const id = params[0] as string;
        if (!getThread(db, id)) throw new HttpError(404, "no such chat");
        const out = stopThread(db, id);
        log(
          `owner stopped chat ${id}: ${out.cancelled} task(s) cancelled, ${out.stopped} run(s) killed`,
        );
        return out;
      },
    ],
    ["GET", /^\/api\/tasks$/, () => withOwnerWaits(db, withCardTitles(db, listTasks(db)))],
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
    // Heartbeat monitors (ADR-0039).
    ["GET", /^\/api\/monitors$/, () => listMonitors(db)],
    // Before /:id, so "quiet" is not taken for a monitor id.
    [
      "GET",
      /^\/api\/monitors\/quiet$/,
      () => ({ hours: getSetting(db, "monitors.quiet_hours") ?? "" }),
    ],
    [
      "PUT",
      /^\/api\/monitors\/quiet$/,
      async ({ body }) => {
        const hours = String((await body()).hours ?? "").trim();
        if (hours && !/^\d{1,2}-\d{1,2}$/.test(hours)) {
          throw new HttpError(400, "quiet hours look like 22-7");
        }
        setSetting(db, "monitors.quiet_hours", hours);
        return { hours };
      },
    ],
    // Stall watcher thresholds (ADR-0066 part 1).
    ["GET", /^\/api\/monitors\/stalls$/, () => stallSettings(db)],
    [
      "PUT",
      /^\/api\/monitors\/stalls$/,
      async ({ body }) => {
        const b = await body();
        const minutes = Number(b.minutes);
        const percent = Number(b.percent);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
          throw new HttpError(400, "minutes: a whole number from 1 to 1440");
        }
        if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
          throw new HttpError(400, "percent: a whole number from 1 to 100");
        }
        setSetting(db, STALL_MINUTES_KEY, String(minutes));
        setSetting(db, STALL_PERCENT_KEY, String(percent));
        return { minutes, percent };
      },
    ],
    [
      "POST",
      /^\/api\/monitors$/,
      async ({ res, body }) => {
        const input = monitorInput(await body(), true) as MonitorInput;
        send(
          res,
          201,
          attempt(() => createMonitor(db, input)),
        );
      },
    ],
    [
      "PUT",
      /^\/api\/monitors\/([\w-]{1,64})$/,
      async ({ params, body }) => {
        const id = params[0] as string;
        if (!getMonitor(db, id)) throw new HttpError(404, "no such monitor");
        const patch = monitorInput(await body(), false);
        return attempt(() => updateMonitor(db, id, patch));
      },
    ],
    [
      "DELETE",
      /^\/api\/monitors\/([\w-]{1,64})$/,
      ({ params }) => {
        if (!getMonitor(db, params[0] as string)) throw new HttpError(404, "no such monitor");
        deleteMonitor(db, params[0] as string);
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
        const month = new Date(midnight);
        month.setDate(1);
        return {
          windows: listUsageWindows(db),
          spentTodayUsd: spendSince(db, midnight.getTime()),
          // Phase 4: per provider, agent and project; API money apart from subscription estimates.
          spend: {
            today: {
              provider: spendBy(db, midnight.getTime(), "provider"),
              agent: spendBy(db, midnight.getTime(), "agent"),
              project: spendBy(db, midnight.getTime(), "project"),
            },
            month: {
              provider: spendBy(db, month.getTime(), "provider"),
              agent: spendBy(db, month.getTime(), "agent"),
              project: spendBy(db, month.getTime(), "project"),
            },
          },
        };
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
            ...(b.class !== undefined ? { class: projectClass(b.class) } : {}),
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
          integrations: p.integrations,
          // ADR-0067: the same lists with each entry's live/staging tag, and the class (null =
          // not chosen yet, counts as secured) with its ceiling.
          entries: p.integrationEntries,
          class: p.class ?? null,
          ceiling: ceilingOf(p.class),
          spend_without_asking: p.spend_without_asking === true,
        };
      },
    ],
    [
      "DELETE",
      /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,63})$/,
      ({ params }) => {
        const slug = params[0] as string;
        const dir = projectsDirOrThrow();
        if (!loadProjects(dir).has(slug)) throw new HttpError(404, "no such project");
        const busy = db
          .prepare(
            "SELECT 1 FROM tasks WHERE project = ? AND status IN ('queued', 'claimed') LIMIT 1",
          )
          .get(slug);
        if (busy) {
          throw new HttpError(
            409,
            "Work for this project is still running or queued; stop it first.",
          );
        }
        // Nothing is deleted: the folder goes aside for the owner to check and remove by hand.
        const movedTo = removeProject(dir, slug, join(dirname(dir), "projects-removed"));
        log(`project ${slug} removed from Achords; its folder is now ${movedTo}`);
        return { ok: true, movedTo };
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
            ...(b.integrations !== undefined ? { integrations: accountLists(b.integrations) } : {}),
            ...(b.class !== undefined ? { class: projectClass(b.class) } : {}),
            ...(b.spend_without_asking !== undefined
              ? { spend_without_asking: b.spend_without_asking === true }
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
    // A card made by hand (owner): parked until started, or handed to its agent at once.
    [
      "POST",
      /^\/api\/tasks$/,
      async ({ req, res }) => {
        const b = await readJson(req, MESSAGE_LIMIT);
        if (b.start !== undefined && typeof b.start !== "boolean") {
          throw new HttpError(400, "start must be true or false");
        }
        const description = optStr(b.description, "description", MESSAGE_LIMIT);
        const agent = optStr(b.agent, "agent", 64);
        const project = optStr(b.project, "project", 64);
        const column = optStr(b.column, "column", 32);
        const out = deps.orchestrator.createCard({
          title: str(b.title, "title", 200),
          ...(description ? { description } : {}),
          ...(agent ? { agent } : {}),
          ...(project ? { project } : {}),
          ...(column ? { column } : {}),
          ...(b.start !== undefined ? { start: b.start as boolean } : {}),
        });
        if (!out.ok) throw new HttpError(400, out.reason);
        log(`kanban: owner created task ${out.taskId}${b.start ? " and started it" : ""}`);
        send(res, 201, withCardTitles(db, [getTask(db, out.taskId) as Task])[0]);
      },
    ],
    [
      "POST",
      /^\/api\/tasks\/([\w-]{1,64})\/start$/,
      async ({ params, body }) => {
        const id = params[0] as string;
        if (!getTask(db, id)) throw new HttpError(404, "no such task");
        const b = await body();
        const out = deps.orchestrator.startCard(id, optStr(b.agent, "agent", 64));
        if (!out.ok) throw new HttpError(/already/.test(out.reason) ? 409 : 400, out.reason);
        log(`kanban: owner started task ${id}`);
        return out;
      },
    ],
    // Card detail for the edit view; the board list above stays light.
    [
      "GET",
      /^\/api\/tasks\/([\w-]{1,64})$/,
      ({ params }) => {
        const id = params[0] as string;
        const task = getTask(db, id);
        if (!task) throw new HttpError(404, "no such task");
        return {
          ...withCardTitles(db, [task])[0],
          checklist: listChecklist(db, id),
          comments: listComments(db, id),
        };
      },
    ],
    [
      "PATCH",
      /^\/api\/tasks\/([\w-]{1,64})$/,
      async ({ req, params }) => {
        const b = await readJson(req, MESSAGE_LIMIT);
        const patch = {
          ...(b.title !== undefined ? { title: str(b.title, "title", 200) } : {}),
          ...(b.description !== undefined
            ? {
                description:
                  b.description === null || b.description === ""
                    ? null
                    : str(b.description, "description", MESSAGE_LIMIT),
              }
            : {}),
          // The owner's name for the card; the task's own title stays (agents' prompts use it).
          ...(b.cardTitle !== undefined
            ? {
                cardTitle:
                  b.cardTitle === null || (typeof b.cardTitle === "string" && !b.cardTitle.trim())
                    ? null
                    : str(b.cardTitle, "cardTitle", 200).trim(),
              }
            : {}),
        };
        const task = updateTask(db, params[0] as string, patch);
        if (!task) throw new HttpError(404, "no such task");
        log(`kanban: owner edited task ${task.id} (${Object.keys(patch).join(", ") || "nothing"})`);
        return withCardTitles(db, [task])[0];
      },
    ],
    [
      "DELETE",
      /^\/api\/tasks\/([\w-]{1,64})$/,
      ({ params }) => {
        const id = params[0] as string;
        // The session key is the card's root (ADR-0066); read it before the row goes.
        const held = getTask(db, id);
        const out = deleteCard(db, id);
        if (!out.ok) {
          if (out.reason === "no such task") throw new HttpError(404, "no such task");
          throw new HttpError(
            409,
            out.reason === "running"
              ? "It is running; stop it first or wait until it finishes."
              : "This is a step inside a card; delete the whole card instead.",
          );
        }
        if (deps.home && held) endCardSessions(db, deps.home, [cardKey(held)]);
        log(`kanban: owner deleted task ${id} (${out.deleted} task(s) with its steps)`);
        return out;
      },
    ],
    [
      "POST",
      /^\/api\/tasks\/([\w-]{1,64})\/checklist$/,
      async ({ params, body }) => {
        const id = params[0] as string;
        const item = addChecklistItem(db, id, str((await body()).text, "text", 500));
        if (!item) throw new HttpError(404, "no such task");
        log(`kanban: owner added checklist item ${item.id} to task ${id}`);
        return item;
      },
    ],
    [
      "PATCH",
      /^\/api\/tasks\/([\w-]{1,64})\/checklist\/(\d{1,15})$/,
      async ({ params, body }) => {
        const [id, itemId] = params as [string, string];
        const b = await body();
        const item = updateChecklistItem(db, id, Number(itemId), {
          ...(b.text !== undefined ? { text: str(b.text, "text", 500) } : {}),
          ...(b.done !== undefined ? { done: b.done === true } : {}),
        });
        if (!item) throw new HttpError(404, "no such checklist item");
        log(`kanban: owner changed checklist item ${itemId} of task ${id}`);
        return item;
      },
    ],
    [
      "DELETE",
      /^\/api\/tasks\/([\w-]{1,64})\/checklist\/(\d{1,15})$/,
      ({ params }) => {
        const [id, itemId] = params as [string, string];
        if (!removeChecklistItem(db, id, Number(itemId)))
          throw new HttpError(404, "no such checklist item");
        log(`kanban: owner removed checklist item ${itemId} of task ${id}`);
        return { ok: true };
      },
    ],
    [
      "POST",
      /^\/api\/tasks\/([\w-]{1,64})\/comments$/,
      async ({ params, body }) => {
        const id = params[0] as string;
        const comment = addComment(db, id, str((await body()).text, "text", 5000));
        if (!comment) throw new HttpError(404, "no such task");
        log(`kanban: owner commented on task ${id}`);
        return comment;
      },
    ],
    [
      "DELETE",
      /^\/api\/tasks\/([\w-]{1,64})\/comments\/(\d{1,15})$/,
      ({ params }) => {
        const [id, commentId] = params as [string, string];
        if (!deleteComment(db, id, Number(commentId))) throw new HttpError(404, "no such comment");
        log(`kanban: owner deleted comment ${commentId} of task ${id}`);
        return { ok: true };
      },
    ],
    [
      "GET",
      /^\/api\/workflow\/([\w-]{1,64})$/,
      ({ params }) => deps.orchestrator.workflow(params[0] as string),
    ],
    // Images dropped or pasted into a chat: stored for that chat, referenced in the message.
    [
      "POST",
      /^\/api\/threads\/([\w-]{1,64})\/images$/,
      async ({ req, params }) => {
        const id = params[0] as string;
        if (!getThread(db, id)) throw new HttpError(404, "no such chat");
        const type = req.headers["content-type"] ?? "";
        if (!IMAGE_TYPES[type.split(";")[0]?.trim().toLowerCase() ?? ""]) {
          throw new HttpError(415, "only PNG, JPEG, WebP or GIF images");
        }
        const bytes = await readBody(req, MAX_IMAGE_BYTES);
        const path = attempt(() => saveImage(homeOrThrow(), id, type, bytes));
        return { path, name: basename(path) };
      },
    ],
    [
      "GET",
      /^\/api\/threads\/([\w-]{1,64})\/images\/([\w.-]{1,64})$/,
      ({ res, params }) => {
        const name = params[1] as string;
        const path = join(attachmentsDir(homeOrThrow(), params[0] as string), name);
        if (!IMAGE_NAME.test(name) || !existsSync(path)) throw new HttpError(404, "no such image");
        const ext = name.split(".").pop() as string;
        const type = Object.entries(IMAGE_TYPES).find(([, e]) => e === ext)?.[0] as string;
        res.writeHead(200, {
          ...securityHeaders,
          "content-type": type,
          "cache-control": "private, max-age=86400",
        });
        res.end(readFileSync(path));
      },
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
        if (
          !/^((proposal|move|publish|skill):(approve|reject)|access:(once|approve|reject)|review:(continue|accept)|cmd:(once|task|always|reject)|perm:(once|card|always|reject)):[\w-]{1,36}$/.test(
            data,
          )
        ) {
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
    // Skills (ADR-0049): owner only; agents propose through the hub, never write here.
    [
      "GET",
      /^\/api\/skills$/,
      () => {
        const workspaces = [
          ...new Set(["shared", ...listAgents(db).map((a) => a.workspace)]),
        ].filter(isSkillWorkspace);
        return {
          // Folder skills can be large and are only viewed one at a time (GET below).
          skills: listSkills(skillsDir()).map((s) => (s.folder ? { ...s, body: "" } : s)),
          workspaces,
          agents: listAgents(db)
            .map((a) => a.id)
            .filter((id) => isSkillScope(agentSkillScope(id))),
          modes: Object.fromEntries(workspaces.map((ws) => [ws, skillMode(db, ws)])),
          proposals: skillProposals(db),
        };
      },
    ],
    [
      "POST",
      /^\/api\/skills$/,
      async ({ req }) => {
        const b = await readJson(req, 256 * 1024);
        const workspace = str(b.workspace, "workspace", 72);
        const name = str(b.name, "name", 64);
        // A workspace, shared, or an agent's own scope (ADR-0053).
        const agent = workspace.startsWith(`${AGENT_SKILLS}/`)
          ? workspace.slice(AGENT_SKILLS.length + 1)
          : undefined;
        if (
          !isSkillScope(workspace) ||
          (agent !== undefined && !listAgents(db).some((a) => a.id === agent))
        ) {
          throw new HttpError(400, "invalid workspace");
        }
        if (!isSkillName(name)) {
          throw new HttpError(
            400,
            "name: lowercase letters, digits and dashes (e.g. owner-report)",
          );
        }
        if (readSkill(skillsDir(), workspace, name)) {
          throw new HttpError(409, `a skill named ${name} already exists in ${workspace}`);
        }
        return writeSkill(skillsDir(), {
          workspace,
          name,
          ...skillFields(b),
          enabled: b.enabled !== false,
        });
      },
    ],
    [
      "GET",
      SKILL_ROUTE,
      ({ params }) => {
        const s = existingSkill(params[0] as string, params[1] as string);
        return { ...s, ...skillFiles(s) };
      },
    ],
    [
      "PUT",
      SKILL_ROUTE,
      async ({ req, params }) => {
        const old = existingSkill(params[0] as string, params[1] as string);
        const b = await readJson(req, 256 * 1024);
        // Folder skills (ADR-0053) are edited in their folder; here only switched on or off.
        if (old.folder) {
          if (b.body !== undefined || typeof b.enabled !== "boolean") {
            throw new HttpError(400, "a skill folder can only be switched on or off here");
          }
          setSkillEnabled(old.path, b.enabled);
          return { ...old, enabled: b.enabled, body: "" };
        }
        // The table's on/off switch sends only `enabled`; the edit form sends the text too.
        const { source: _source, ...rest } = old;
        const next = b.body === undefined ? old : { ...rest, ...skillFields(b) };
        return writeSkill(skillsDir(), {
          ...next,
          ...(b.enabled !== undefined ? { enabled: b.enabled === true } : {}),
        });
      },
    ],
    [
      "DELETE",
      SKILL_ROUTE,
      ({ params }) => {
        const s = existingSkill(params[0] as string, params[1] as string);
        if (s.folder) throw new HttpError(400, "a skill folder is removed in its folder");
        deleteSkill(skillsDir(), s.workspace, s.name);
        return { ok: true };
      },
    ],
    // Import from a link: the gateway fetches it and returns a draft the owner edits and saves.
    [
      "POST",
      /^\/api\/skills\/import$/,
      async ({ body }) => {
        const url = str((await body()).url, "url", 2000);
        let page: { url: string; text: string };
        try {
          page = await fetchSkillSource(url);
        } catch (err) {
          throw new HttpError(422, (err as Error).message);
        }
        let meta: Record<string, unknown> = {};
        let text = page.text;
        try {
          ({ meta, body: text } = parseSkillText(page.text));
        } catch {}
        const segments = new URL(page.url).pathname.split("/").filter(Boolean);
        const file = segments.at(-1)?.replace(/\.(md|markdown|txt|html?)$/i, "") ?? "";
        const guess =
          typeof meta.name === "string"
            ? meta.name
            : /^skill$/i.test(file)
              ? (segments.at(-2) ?? "")
              : file;
        const firstLine = text.split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "";
        return {
          name: guess
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 64),
          description: (typeof meta.description === "string" ? meta.description : firstLine)
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 300),
          body: text,
          source: url,
        };
      },
    ],
    [
      "PUT",
      /^\/api\/skills-mode\/([\w-]{1,64})$/,
      async ({ params, body }) => {
        const mode = (await body()).mode;
        if (mode !== "review" && mode !== "auto")
          throw new HttpError(400, "mode must be review or auto");
        setSetting(db, skillModeKey(params[0] as string), mode);
        return { ok: true };
      },
    ],
    ["GET", /^\/api\/agents$/, () => listAgents(db)],
    ["GET", /^\/api\/integrations$/, () => deps.integrations?.() ?? []],
    // Revoke a shared sign-in: its owner-wide vault ids (Google: shared by GA4 and Search Console).
    [
      "DELETE",
      /^\/api\/integrations\/([a-z0-9][a-z0-9-]{0,63})\/secrets$/,
      ({ params, session }) => {
        const ids = ownerSecrets(catalogEntry(params[0] as string));
        if (!ids.length) throw new HttpError(404, "this integration has no shared sign-in");
        const deleted = ids.filter((id) => vault().delete(id, `web:${session.deviceName}`));
        log(`integrations: owner revoked ${params[0]} (${deleted.length} secret(s) deleted)`);
        return { deleted };
      },
    ],
    // Apps on this computer: which agents may use one (their agent.yaml `mcp`).
    [
      "PUT",
      /^\/api\/integrations\/([a-z0-9][a-z0-9-]{0,63})\/agents$/,
      async ({ params, body }) => {
        const entry = catalogEntry(params[0] as string);
        // Only credential-free entries: those are safe next to a shell (ADR-0034).
        if (secretRefs(entry).length) {
          throw new HttpError(400, "only apps without credentials can be given to agents here");
        }
        if (!deps.agentsDir) throw new HttpError(404, "no agents folder");
        const agents = strList((await body()).agents, "agents");
        const changed = attempt(() =>
          setIntegrationAgents(deps.agentsDir as string, entry.id, agents),
        );
        log(
          `integrations: owner set the agents of ${entry.id} (changed: ${changed.join(", ") || "none"})`,
        );
        return { agents, changed };
      },
    ],
    // Google sign-in from the web (ADR-0048). Google sends the browser back to the loopback
    // callback below; from another device that address fails, so the page lets the owner paste
    // it here instead.
    [
      "POST",
      /^\/api\/oauth\/google\/start$/,
      async ({ req, session, body }) => {
        const text = str((await body()).client, "client", 20_000);
        const client = attempt(() => parseClientJson(text));
        const redirect = `http://127.0.0.1:${req.socket.localPort}${GOOGLE_CALLBACK}`;
        return google.start(client, redirect, session.id);
      },
    ],
    [
      "GET",
      /^\/api\/oauth\/google\/status\/([\w-]{1,64})$/,
      ({ params, session }) => {
        const out = google.status(params[0] as string, session.id);
        if (!out) throw new HttpError(404, "this sign-in is unknown or expired; start it again");
        return out;
      },
    ],
    [
      "POST",
      /^\/api\/oauth\/google\/finish$/,
      async ({ session, body }) => {
        let u: URL;
        try {
          u = new URL(str((await body()).url, "url", 8000).trim());
        } catch (err) {
          if (err instanceof HttpError) throw err;
          throw new HttpError(400, "that is not an address; copy the whole address bar");
        }
        try {
          await google.finish(u.searchParams, { owner: session.id });
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
        log("integrations: Google connected from the web (pasted address)");
        return { ok: true };
      },
    ],
    // Model access (Phase 4): subscription or API key per provider; keys go through the vault.
    [
      "GET",
      /^\/api\/billing$/,
      () => {
        if (!deps.billing) throw new HttpError(404, "not available");
        return deps.billing.list();
      },
    ],
    [
      "PUT",
      /^\/api\/billing\/([a-z0-9-]{1,32})$/,
      async ({ params, body }) => {
        if (!deps.billing) throw new HttpError(404, "not available");
        const mode = (await body()).mode;
        if (mode !== "subscription" && mode !== "api") {
          throw new HttpError(400, "mode must be subscription or api");
        }
        attempt(() => deps.billing?.setMode(params[0] as string, mode));
        return deps.billing.list();
      },
    ],
    [
      "GET",
      /^\/api\/budgets$/,
      () => {
        if (!deps.billing) throw new HttpError(404, "not available");
        return deps.billing.budgets();
      },
    ],
    [
      "PUT",
      /^\/api\/budgets\/([a-z0-9-]{1,32})$/,
      async ({ params, body }) => {
        if (!deps.billing) throw new HttpError(404, "not available");
        const b = await body();
        for (const period of ["day", "month"] as const) {
          if (b[period] === undefined) continue;
          const usd = Number(b[period]);
          if (!Number.isFinite(usd) || usd < 0 || usd > 100_000) {
            throw new HttpError(400, `${period} must be a number of dollars (0 = no limit)`);
          }
          attempt(() => deps.billing?.setBudget(params[0] as string, period, usd));
        }
        if (b.fallback !== undefined) {
          if (typeof b.fallback !== "boolean")
            throw new HttpError(400, "fallback must be true or false");
          const on = b.fallback;
          attempt(() => deps.billing?.setFallback(params[0] as string, on));
        }
        return deps.billing.budgets();
      },
    ],
    // Updates: status, the auto switch, and a manual check.
    [
      "GET",
      /^\/api\/update$/,
      async () => {
        if (!deps.update) throw new HttpError(404, "updates are not available");
        return deps.update.status();
      },
    ],
    [
      "PUT",
      /^\/api\/update$/,
      async ({ body }) => {
        if (!deps.update) throw new HttpError(404, "updates are not available");
        deps.update.setAuto((await body()).auto === true);
        return deps.update.status();
      },
    ],
    [
      "POST",
      /^\/api\/update\/check$/,
      async () => {
        if (!deps.update) throw new HttpError(404, "updates are not available");
        return { result: await deps.update.checkNow() };
      },
    ],
    // How long chat images are kept (Settings → Storage); null keeps them forever.
    ["GET", /^\/api\/settings\/images$/, () => ({ keepDays: imageKeepDays(db) ?? null })],
    [
      "PUT",
      /^\/api\/settings\/images$/,
      async ({ body }) => {
        const v = (await body()).keepDays;
        if (v !== null && !(Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 3650)) {
          throw new HttpError(400, "keepDays: whole days from 1 to 3650, or empty to keep forever");
        }
        setSetting(db, IMAGE_KEEP_KEY, v === null ? "" : String(v));
        return { keepDays: imageKeepDays(db) ?? null };
      },
    ],
    // The Achords guide: rules for every agent and the boss (Settings → Guide).
    ["GET", /^\/api\/guide$/, () => readGuide(homeOrThrow())],
    [
      "PUT",
      /^\/api\/guide$/,
      async ({ body }) => {
        const b = await body();
        const text = b.text === "" ? "" : str(b.text, "text", GUIDE_LIMIT);
        writeGuide(homeOrThrow(), text);
        return readGuide(homeOrThrow());
      },
    ],
    // The owner's own accounts (ADR-0042): for work without a client project.
    ["GET", /^\/api\/accounts$/, () => ownAccountsView()],
    [
      "PUT",
      /^\/api\/accounts$/,
      async ({ body }) => {
        const lists = accountLists((await body()).integrations);
        attempt(() => saveOwnAccounts(homeOrThrow(), lists));
        return ownAccountsView();
      },
    ],
    // Sites of a project with their own credentials (ADR-0047), e.g. WordPress; "own" is the
    // owner's own accounts. Credential values are set through /api/vault, never shown here.
    [
      "GET",
      /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,63})\/sites\/([a-z0-9][a-z0-9-]{0,63})$/,
      ({ params }) => sitesView(params[0] as string, siteEntry(params[1] as string)),
    ],
    [
      "POST",
      /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,63})\/sites\/([a-z0-9][a-z0-9-]{0,63})$/,
      async ({ params, res, body }) => {
        const slug = params[0] as string;
        const entry = siteEntry(params[1] as string);
        const url = siteUrl((await body()).url);
        const lists = accountsOf(slug);
        const channel = entry.sites?.channel as string;
        const urls = lists[channel] ?? [];
        if (urls.includes(url)) throw new HttpError(409, `${url} is already listed`);
        attempt(() => saveAccounts(slug, { ...lists, [channel]: [...urls, url] }));
        send(res, 201, sitesView(slug, entry));
      },
    ],
    // ADR-0067: the project's push token for its repositories (level 5), set through /api/vault.
    [
      "GET",
      /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,63})\/git-token$/,
      ({ params }) => {
        const slug = params[0] as string;
        const repositories = (entriesOf(slug).repository ?? []).map((e) => e.value);
        const id = gitTokenId(slug);
        return { id, set: vault().status(id).set, repositories };
      },
    ],
    // ADR-0067: a site's live/staging tag.
    [
      "PUT",
      /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,63})\/sites\/([a-z0-9][a-z0-9-]{0,63})\/([^/]+)$/,
      async ({ params, body }) => {
        const slug = params[0] as string;
        const entry = siteEntry(params[1] as string);
        const url = decodeURIComponent(params[2] as string);
        const env = envOf((await body()).env, "env");
        const lists = entriesOf(slug);
        const channel = entry.sites?.channel as string;
        const list = lists[channel] ?? [];
        if (!list.some((e) => e.value === url)) throw new HttpError(404, `${url} is not listed`);
        attempt(() =>
          saveAccounts(slug, {
            ...lists,
            [channel]: list.map((e) => (e.value === url ? { ...e, env } : e)),
          }),
        );
        return sitesView(slug, entry);
      },
    ],
    [
      "DELETE",
      /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,63})\/sites\/([a-z0-9][a-z0-9-]{0,63})\/([^/]+)$/,
      ({ params }) => {
        const slug = params[0] as string;
        const entry = siteEntry(params[1] as string);
        const url = decodeURIComponent(params[2] as string);
        const lists = accountsOf(slug);
        const channel = entry.sites?.channel as string;
        const urls = lists[channel] ?? [];
        if (!urls.includes(url)) throw new HttpError(404, `${url} is not listed`);
        // The site's vault entries stay; the owner removes them on the vault page if wanted.
        attempt(() => saveAccounts(slug, { ...lists, [channel]: urls.filter((u) => u !== url) }));
        return sitesView(slug, entry);
      },
    ],
    [
      "POST",
      /^\/api\/integrations\/([a-z0-9][a-z0-9-]{0,63})\/test$/,
      async ({ params, body }) => {
        const b = await body();
        return deps.orchestrator.testIntegration(
          params[0] as string,
          b.project ? str(b.project, "project", 64) : undefined,
          b.site ? str(b.site, "site", 300) : undefined,
        );
      },
    ],
    [
      "GET",
      /^\/api\/agents\/([a-z0-9][a-z0-9-]{0,63})$/,
      async ({ params }) => {
        const path = manifestPath(params[0] as string);
        const m = loadManifest(path);
        const local = (await deps.localModels?.().catch(() => [])) ?? [];
        const docPath = join(dirname(path), "AGENT.md");
        return {
          id: m.id,
          name: m.name,
          role: m.role,
          workspace: m.workspace,
          models: m.models,
          // The same fields as the create form, for editing.
          roles: m.roles,
          mcp: m.mcp,
          tools: m.tools,
          fs: m.fs,
          ...(m.shell ? { shell: m.shell } : {}),
          network: m.network,
          ...(m.network.allow.includes("*") || m.shell ? { container: m.container } : {}),
          delegation: m.delegation,
          ...(m.budget?.per_run_usd ? { budget: { per_run_usd: m.budget.per_run_usd } } : {}),
          ...(m.effort ? { effort: m.effort } : {}),
          ...(m.billing ? { billing: m.billing } : {}),
          ...(m.level !== undefined ? levelInfo(m) : {}),
          doc: existsSync(docPath) ? readFileSync(docPath, "utf8") : "",
          // Aliases always run the newest model of a family; local models as pulled.
          suggestions: [
            ...CLAUDE_ALIASES,
            ...(deps.codexModels?.() ?? []),
            ...local.map((x) => `local/${x}`),
          ],
        };
      },
    ],
    [
      "GET",
      /^\/api\/agent-options$/,
      async () => {
        const local = (await deps.localModels?.().catch(() => [])) ?? [];
        // Workflow roles to tick: those the workspaces' rules name (role:x) and those in use.
        const workspaces = [...new Set(listAgents(db).map((a) => a.workspace))];
        const roles = new Set<string>();
        for (const ws of workspaces) {
          const wf = deps.orchestrator.workflow(ws).workflow;
          for (const tr of wf.transitions) if (tr.by.startsWith("role:")) roles.add(tr.by.slice(5));
          for (const on of Object.values(wf.on_enter)) {
            if (on.assign?.startsWith("role:")) roles.add(on.assign.slice(5));
          }
        }
        if (deps.agentsDir)
          for (const m of loadAgents(deps.agentsDir).values())
            for (const r of m.roles) roles.add(r);
        return {
          roles: [...roles].sort(),
          tools: AGENT_TOOL_NAMES,
          models: [
            ...CLAUDE_ALIASES,
            ...(deps.codexModels?.() ?? []),
            ...local.map((x) => `local/${x}`),
          ],
        };
      },
    ],
    [
      "POST",
      /^\/api\/agents$/,
      async ({ res, body }) => {
        if (!deps.agentsDir) throw new HttpError(404, "no agents folder");
        const b = await body();
        try {
          const made = createAgentFiles(deps.agentsDir, {
            id: str(b.id, "id", 64),
            ...agentForm(b),
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
      /^\/api\/agents\/([a-z0-9][a-z0-9-]{0,63})$/,
      async ({ params, body }) => {
        const id = params[0] as string;
        manifestPath(id); // 404 for an unknown agent
        const b = await body();
        try {
          updateAgent(deps.agentsDir ?? "", id, {
            ...agentForm(b),
            doc: str(b.doc, "doc", 50_000),
          });
        } catch (err) {
          if (err instanceof HttpError) throw err;
          throw new HttpError(400, (err as Error).message);
        }
        deps.orchestrator.syncAgents(); // name/workspace show in the list right away
        log(`agent edited in the web UI: ${id}`);
        return { ok: true };
      },
    ],
    // ADR-0067: this agent's level overrides per project; the others in the file are kept.
    [
      "PUT",
      /^\/api\/agents\/([a-z0-9][a-z0-9-]{0,63})\/overrides$/,
      async ({ params, body }) => {
        const id = params[0] as string;
        manifestPath(id); // 404 for an unknown agent
        const home = homeOrThrow();
        const b = await body();
        if (!Array.isArray(b.overrides)) throw new HttpError(400, "overrides: must be a list");
        const projects = deps.projectsDir ? loadProjects(deps.projectsDir) : new Map();
        const mine = (b.overrides as unknown[]).map((o) => {
          const x = o && typeof o === "object" ? (o as Record<string, unknown>) : {};
          const project = str(x.project, "project", 64);
          if (project !== OWN && !projects.has(project)) {
            throw new HttpError(400, `no project ${project}`);
          }
          return { ...x, agent: id };
        });
        const agents = loadAgents(deps.agentsDir ?? "");
        const saved = attempt(() =>
          saveOverrides(home, [...loadOverrides(home).filter((o) => o.agent !== id), ...mine], {
            base: (a) => agents.get(a)?.level,
            projectClass: (slug) =>
              slug === OWN ? "experimental" : (projects.get(slug)?.class as ProjectClass),
          }),
        );
        log(`level overrides of ${id} edited in the web UI`);
        return {
          overrides: saved
            .filter((o) => o.agent === id)
            .map(({ project, level, requires_skills }) => ({ project, level, requires_skills })),
        };
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
  const monitorInput = (b: Record<string, unknown>, full: boolean): Partial<MonitorInput> => {
    const out: Partial<MonitorInput> = {};
    if (full || b.name !== undefined) out.name = str(b.name, "name", 100);
    if (full || b.kind !== undefined) out.kind = str(b.kind, "kind", 16) as MonitorInput["kind"];
    if (full || b.every_minutes !== undefined) out.everyMinutes = Number(b.every_minutes);
    if (b.enabled !== undefined) out.enabled = b.enabled === true;
    if (full || b.config !== undefined) {
      const c = b.config;
      if (!c || typeof c !== "object" || Array.isArray(c) || JSON.stringify(c).length > 4000) {
        throw new HttpError(400, "config must be a small object");
      }
      const cfg = c as Record<string, unknown>;
      // Site checks fetch http(s) addresses only.
      if (cfg.url !== undefined && !/^https?:\/\/[^/\s]+/i.test(String(cfg.url))) {
        throw new HttpError(400, "url must start with http:// or https://");
      }
      // Integration monitors: a catalog id and one of its read tools (checked at run time too).
      if (out.kind === "integration" || cfg.integration !== undefined) {
        str(cfg.integration, "config.integration", 64);
        str(cfg.tool, "config.tool", 64);
        if (cfg.args !== undefined && (typeof cfg.args !== "object" || Array.isArray(cfg.args))) {
          throw new HttpError(400, "config.args must be an object");
        }
      }
      out.config = cfg;
    }
    return out;
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

  const envOf = (v: unknown, field: string): Env => {
    if (v !== "live" && v !== "staging") throw new HttpError(400, `${field}: live or staging`);
    return v;
  };
  const projectClass = (v: unknown): ProjectClass => {
    if (v !== "secured" && v !== "experimental") {
      throw new HttpError(400, "class: secured or experimental");
    }
    return v;
  };
  /**
   * Project accounts from the web editor: channel id → list (ADR-0036). An entry is a plain
   * string (keeps the live/staging tag it had, new ones are live) or `{value, env}` (ADR-0067).
   */
  const accountLists = (v: unknown): AccountListsInput => {
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      throw new HttpError(400, "integrations: must be an object of lists");
    }
    const lists = Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([key, list]) => {
        const field = `integrations.${key}`;
        if (!Array.isArray(list) || list.length > 200) {
          throw new HttpError(400, `${field}: must be a list`);
        }
        return [
          key,
          list.map((e): string | AccountEntry => {
            if (typeof e === "string") return strList([e], field)[0] as string;
            const x = e && typeof e === "object" ? (e as Record<string, unknown>) : {};
            return {
              value: str(x.value, `${field}.value`, 200),
              env: envOf(x.env, `${field}.env`),
            };
          }),
        ];
      }),
    );
    // Git repositories: an https or ssh address of a repository (GitHub, GitLab, self-hosted).
    for (const e of lists.repository ?? []) {
      const r = typeof e === "string" ? e : e.value;
      if (r.trim() && !GIT_REPO.test(r.trim())) {
        throw new HttpError(
          400,
          `"${r.slice(0, 80)}" is not a repository address; use e.g. https://github.com/owner/repo or https://gitlab.com/group/project`,
        );
      }
    }
    return lists;
  };
  const catalogEntry = (id: string): CatalogEntry => {
    const entry = deps.catalog?.().get(id);
    if (!entry) throw new HttpError(404, `no integration ${id}`);
    return entry;
  };
  const siteEntry = (id: string): CatalogEntry => {
    const entry = deps.catalog?.().get(id);
    if (!entry?.sites) throw new HttpError(404, `integration ${id} has no sites`);
    return entry;
  };
  /** Account lists of a project, or of the owner's own accounts ("own"), with their tags. */
  const entriesOf = (slug: string): Record<string, AccountEntry[]> => {
    if (slug === OWN) return loadOwnAccountEntries(homeOrThrow());
    const p = loadProjects(projectsDirOrThrow()).get(slug);
    if (!p) throw new HttpError(404, "no such project");
    return p.integrationEntries;
  };
  const accountsOf = (slug: string): Record<string, string[]> => entryValues(entriesOf(slug));
  const saveAccounts = (slug: string, lists: AccountListsInput) =>
    slug === OWN
      ? saveOwnAccounts(homeOrThrow(), lists)
      : updateProject(projectsDirOrThrow(), slug, { integrations: lists });
  const ownAccountsView = () => {
    const entries = loadOwnAccountEntries(homeOrThrow());
    return { integrations: entryValues(entries), entries };
  };
  const sitesView = (slug: string, entry: CatalogEntry) => {
    const channel = entry.sites?.channel as string;
    const list = entriesOf(slug)[channel] ?? [];
    const sites = siteStatus(
      entry,
      slug,
      list.map((e) => e.value),
      (id) => vault().status(id).set,
    );
    return {
      integration: entry.id,
      channel,
      sites: sites.map((x, i) => ({ ...x, env: list[i]?.env ?? "live" })),
    };
  };
  /** A site address as stored: http(s), no login, query or fragment, no trailing slash. */
  const siteUrl = (v: unknown): string => {
    let u: URL;
    try {
      u = new URL(str(v, "url", 200));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, "url: not an address");
    }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) {
      throw new HttpError(400, "url: an http(s) site address without login, query or #");
    }
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  };
  const homeOrThrow = () => {
    if (!deps.home) throw new HttpError(404, "home is not configured");
    return deps.home;
  };
  const projectsDirOrThrow = () => {
    if (!deps.projectsDir) throw new HttpError(404, "projects are not configured");
    return deps.projectsDir;
  };

  const skillsDir = () => join(homeOrThrow(), "skills");
  const existingSkill = (workspace: string, name: string) => {
    const s = isSkillScope(workspace) ? readSkill(skillsDir(), workspace, name) : undefined;
    if (!s) throw new HttpError(404, "no such skill");
    return s;
  };
  /** Description, body and source of an owner add or edit. */
  const skillFields = (b: Record<string, unknown>) => {
    const source =
      b.source === undefined || b.source === "" ? undefined : str(b.source, "source", 2000);
    return {
      description: str(b.description, "description", 300).replace(/\s+/g, " ").trim(),
      body: str(b.body, "body", 200_000),
      ...(source ? { source } : {}),
    };
  };

  /** The agent form (create and edit share it); validated again by the manifest schema. */
  const agentForm = (b: Record<string, unknown>) => {
    const list = (v: unknown, field: string) => (v === undefined ? [] : strList(v, field));
    const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
    const models = obj(b.models);
    const fs = obj(b.fs);
    const perRun = Number(obj(b.budget).per_run_usd ?? 0);
    return {
      name: str(b.name, "name", 100),
      role: str(b.role, "role", 100),
      workspace: str(b.workspace, "workspace", 64),
      roles: list(b.roles, "roles"),
      models: {
        default: str(models.default, "models.default", 200),
        allowed: list(models.allowed, "models.allowed"),
      },
      // ADR-0067: with a level the lists below are refused (updateAgent, createAgentFiles), so
      // only what the form sent is passed on.
      ...(b.level !== undefined ? { level: levelOf(b.level) } : {}),
      ...(b.tools !== undefined ? { tools: list(b.tools, "tools") } : {}),
      fs: { read: list(fs.read, "fs.read"), write: list(fs.write, "fs.write") },
      ...(b.shell !== undefined
        ? { shell: { allow: list(obj(b.shell).allow, "shell.allow") } }
        : {}),
      ...(b.network !== undefined
        ? { network: { allow: list(obj(b.network).allow, "network.allow") } }
        : {}),
      ...(typeof b.container === "boolean" ? { container: b.container } : {}),
      delegation: {
        can_delegate_to: list(obj(b.delegation).can_delegate_to, "delegation.can_delegate_to"),
        accepts_from: list(obj(b.delegation).accepts_from, "delegation.accepts_from"),
      },
      ...(perRun > 0 ? { budget: { per_run_usd: perRun } } : {}),
      ...(b.effort
        ? { effort: str(b.effort, "effort", 10) as NonNullable<AgentFields["effort"]> }
        : {}),
      ...(b.billing
        ? { billing: str(b.billing, "billing", 20) as NonNullable<AgentFields["billing"]> }
        : {}),
    };
  };
  const levelOf = (v: unknown): number => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_LEVEL) {
      throw new HttpError(400, `level: a whole number from 0 to ${MAX_LEVEL}`);
    }
    return v;
  };
  /**
   * ADR-0067: the agent's level, its effective level per project and why (no project = the
   * owner's own work, experimental), and remit setups that cannot work as compiled.
   */
  const levelInfo = (m: ReturnType<typeof loadManifest>) => {
    const base = m.level as number;
    const overrides = deps.home ? loadOverrides(deps.home) : [];
    const enabledSkills = deps.home
      ? visibleSkills(join(deps.home, "skills"), m.workspace, m.id).map((x) => x.name)
      : [];
    const projects = deps.projectsDir ? [...loadProjects(deps.projectsDir).values()] : [];
    const where = [
      ...projects.map((p) => ({ slug: p.slug, name: p.name, class: p.class })),
      { slug: OWN, name: "Own accounts", class: "experimental" as const },
    ];
    const catalog = deps.catalog?.();
    return {
      level: base,
      ...(m.unsandboxed ? { unsandboxed: m.unsandboxed } : {}),
      ...(m.keys_beside_host_shell ? { keys_beside_host_shell: true } : {}),
      overrides: overrides
        .filter((o) => o.agent === m.id)
        .map(({ project, level, requires_skills }) => ({ project, level, requires_skills })),
      effectiveLevels: where.map((p) => {
        const eff = effectiveLevel({
          base,
          override: overrides.find((o) => o.agent === m.id && o.project === p.slug),
          projectClass: p.class,
          enabledSkills,
        });
        return {
          project: p.slug,
          name: p.name,
          class: p.class ?? null,
          ...eff,
          ...(catalog ? compiledBelow(m, eff.level, p.class, catalog) : {}),
        };
      }),
      conflicts: catalog ? levelConflicts(m, catalog) : [],
    };
  };
  /**
   * What a run with the default model actually gets when it is below the effective level: a
   * level 4 shell without a sandbox runs as 3, a local model at most at 3 (ADR-0067). The
   * gateway always has the container runner; whether the Mac can start one shows at run time.
   */
  const compiledBelow = (
    m: ReturnType<typeof loadManifest>,
    level: number,
    cls: ProjectClass | undefined,
    catalog: Catalog,
  ) => {
    const c = compileLevel(m, {
      level,
      project: { class: cls },
      catalog,
      run: { model: m.models.default, containerAvailable: true },
    });
    if (c.refusal || c.level >= level) return {};
    return {
      level: c.level,
      reason: isLocalModel(m.models.default) ? "local-model" : "no-sandbox",
    };
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
      const host = req.headers.host ?? "";
      // Local names, the container listener, and the remote address the owner set on the web
      // (Tailscale serve forwards with that Host). Anything else may be DNS rebinding.
      if (!deps.allowedHosts.includes(host) && host !== getSetting(db, REMOTE_HOST_KEY)) {
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
      // Google's redirect after the sign-in: a cross-site navigation, so the SameSite=Strict
      // cookie is not sent. The random single-use state is the proof; the device that started
      // it must still be paired.
      if (method === "GET" && path === GOOGLE_CALLBACK) {
        const params = new URL(req.url ?? "/", "http://x").searchParams;
        let msg: string;
        let status = 200;
        try {
          await google.finish(params, {
            accept: (owner) => listSessions(db).some((d) => d.id === owner),
          });
          msg = t("oauth.page.done");
          log("integrations: Google connected from the web");
        } catch (err) {
          status = 400;
          msg = t("oauth.page.failed", { reason: (err as Error).message });
        }
        res.writeHead(status, { ...securityHeaders, "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>Achords</title><p>${escapeHtml(msg)}</p>`,
        );
        return;
      }
      // The integration launcher trades its one-time ticket for the server's environment.
      if (method === "POST" && path === "/api/agent/mcp-env") {
        const auth = req.headers.authorization ?? "";
        const launch = auth.startsWith("Bearer ")
          ? deps.mcpTickets?.redeem(auth.slice(7))
          : undefined;
        if (!launch) throw new HttpError(401, "invalid ticket");
        send(res, 200, launch);
        return;
      }
      // ADR-0055: a run's relay to its integration server on the gateway's side. The relay's
      // token is good for that one run and integration only.
      const relay = /^\/api\/agent\/mcp\/([\w.-]{1,64})$/.exec(path);
      if (relay && (method === "GET" || method === "POST")) {
        const auth = req.headers.authorization ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const id = relay[1] as string;
        if (!deps.mcpHost || !token) throw new HttpError(401, "invalid token");
        if (method === "GET") {
          if (!deps.mcpHost.stream(token, id, res)) throw new HttpError(401, "invalid token");
          return;
        }
        // One JSON-RPC message per request (tool arguments may be a whole page).
        const line = (await readBody(req, MESSAGE_LIMIT)).toString("utf8").trim();
        if (!line || line.includes("\n"))
          throw new HttpError(400, "one JSON-RPC message per request");
        if (!deps.mcpHost.write(token, id, line)) throw new HttpError(401, "invalid token");
        send(res, 202, { ok: true });
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
        // ADR-0067 level 5: the gateway pushes the branch itself (the run holds no credential).
        if (method === "POST" && tool === "push_branch") {
          if (!caller.tools.includes(tool)) {
            throw new HttpError(403, `tool ${tool} not granted to this run`);
          }
          const b = await readJson(req, 8192);
          const remoteUrl =
            b.remote_url === undefined || b.remote_url === ""
              ? undefined
              : str(b.remote_url, "remote_url", 500);
          const out = await deps.orchestrator.pushBranch(
            { from: "task", taskId: caller.taskId },
            {
              folder: str(b.folder, "folder", 1000),
              branch: str(b.branch, "branch", 200),
              ...(remoteUrl ? { remoteUrl } : {}),
            },
          );
          send(res, 200, out);
          return;
        }
        // Publishing (ADR-0037): from the launcher, with a token granting publish:<integration>.
        if (method === "POST" && (tool === "publish" || tool === "publish_log")) {
          // A page or post can be long; the owner sees it before it runs.
          const b = await readJson(req, 512 * 1024);
          const integration = str(b.integration, "integration", 64);
          if (!caller.tools.includes(`publish:${integration}`)) {
            throw new HttpError(403, `publishing to ${integration} not granted to this run`);
          }
          const from = { from: "task" as const, taskId: caller.taskId };
          const toolName = str(b.tool, "tool", 64);
          if (JSON.stringify(b.arguments ?? {}).length > 300_000) {
            throw new HttpError(413, "arguments too large");
          }
          const out =
            tool === "publish"
              ? deps.orchestrator.requestPublish(from, {
                  integration,
                  tool: toolName,
                  args: b.arguments ?? {},
                })
              : deps.orchestrator.logPublish(from, {
                  integration,
                  tool: toolName,
                  args: b.arguments ?? {},
                  result: typeof b.result === "string" ? b.result.slice(0, 2000) : "",
                });
          send(res, out.ok ? 200 : 409, out);
          return;
        }
        // Skills (ADR-0049): read, fetch (async) and propose; the workspace comes from the token's task.
        if (method === "POST" && tool.startsWith("skill_")) {
          if (!caller.tools.includes(tool)) {
            throw new HttpError(403, `tool ${tool} not granted to this run`);
          }
          const b = await readJson(req, 256 * 1024);
          const from = { from: "task" as const, taskId: caller.taskId };
          const o = deps.orchestrator;
          const opt = (v: unknown, field: string, max: number) =>
            v === undefined || v === "" ? undefined : str(v, field, max);
          const replaces = opt(b.replaces, "replaces", 64);
          const sourceUrl = opt(b.source_url, "source_url", 2000);
          const out =
            tool === "skill_read"
              ? o.skillRead(from, str(b.name, "name", 64))
              : tool === "skill_fetch"
                ? await o.skillFetch(from, str(b.url, "url", 2000))
                : tool === "skill_propose"
                  ? o.skillPropose(from, {
                      name: str(b.name, "name", 64),
                      description: str(b.description, "description", 300),
                      body: str(b.body, "body", 100_000),
                      reason: str(b.reason, "reason", 2000),
                      ...(replaces ? { replaces } : {}),
                      ...(sourceUrl ? { sourceUrl } : {}),
                    })
                  : undefined;
          if (!out) throw new HttpError(404, "not found");
          send(res, 200, out);
          return;
        }
        const AGENT_TOOLS = [
          "delegate",
          "handoff",
          "ask_owner",
          "ask_parent",
          "answer_child",
          "record_room_outcome",
          "spawn_worker",
          "propose_agent",
          "move_task",
          "open_room",
          "request_access",
          "request_command",
          "request_permission",
          "report_checks",
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
          tool === "delegate" || tool === "handoff"
            ? o[tool](from, {
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
                    : tool === "report_checks"
                      ? o.reportChecks(from, {
                          passed: b.passed === true,
                          summary: str(b.summary, "summary", 2000),
                        })
                      : tool === "request_access"
                        ? o.requestAccess(from, str(b.reason, "reason", 2000))
                        : tool === "request_command"
                          ? o.requestCommand(from, {
                              command: str(b.command, "command", 300),
                              reason: str(b.reason, "reason", 2000),
                            })
                          : tool === "request_permission"
                            ? o.requestPermission(from, {
                                kind: str(b.kind, "kind", 16),
                                target: str(b.target, "target", 300),
                                reason: str(b.reason, "reason", 2000),
                              })
                            : tool === "ask_parent"
                              ? o.askParent(from, str(b.question, "question", 2000))
                              : tool === "answer_child"
                                ? o.answerChild(from, {
                                    taskId: str(b.task_id, "task_id", 64),
                                    answer: str(b.answer, "answer", 5000),
                                  })
                                : tool === "record_room_outcome"
                                  ? o.recordRoomOutcome(from, {
                                      room: str(b.room, "room", 64),
                                      decision: str(b.decision, "decision", 5000),
                                      decidedBy: str(b.decided_by, "decided_by", 200),
                                      openPoints: strList(b.open_points, "open_points"),
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
