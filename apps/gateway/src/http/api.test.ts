import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPairingCode,
  createThread,
  type Db,
  enqueue,
  finishRun,
  getThread,
  listMessages,
  openCoreDatabase,
  recordUsageWindows,
  setRunProgress,
  startRun,
  upsertAgent,
} from "@achords/core";
import { openVault, type Vault } from "@achords/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunTokens } from "../mcp/tokens.ts";
import { createApiHandler } from "./api.ts";

describe("HTTP API", () => {
  let db: Db;
  let vault: Vault;
  let server: Server;
  let base: string;
  let host: string;
  const handled: { threadId: string; text: string }[] = [];
  const delegations: { from: unknown; request: unknown }[] = [];
  const questions: { from: unknown; question: string }[] = [];
  const workerCalls: { from: unknown; request: unknown }[] = [];
  const decisions: { id: string; approve: boolean }[] = [];
  const moves: unknown[] = [];
  const rooms: unknown[] = [];
  let synced = 0;
  const tokens = createRunTokens();
  const logs: string[] = [];
  let agentsDir: string;
  let runDir: string;
  let projectsDir: string;
  const heard: number[] = [];

  beforeEach(async () => {
    db = openCoreDatabase(":memory:");
    agentsDir = mkdtempSync(join(tmpdir(), "achords-api-agents-"));
    runDir = mkdtempSync(join(tmpdir(), "achords-api-run-"));
    projectsDir = join(runDir, "projects");
    mkdirSync(join(agentsDir, "boss"));
    writeFileSync(
      join(agentsDir, "boss", "agent.yaml"),
      "id: boss\nname: Boss\nrole: orchestrator\nworkspace: shared\nmodels:\n  default: cli-claude/sonnet\n",
    );
    vault = openVault(":memory:", randomBytes(32));
    handled.length = 0;
    server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    host = `127.0.0.1:${port}`;
    base = `http://${host}`;
    server.on(
      "request",
      createApiHandler({
        db,
        vault: () => vault,
        allowedHosts: [host, `localhost:${port}`],
        orchestrator: {
          handleMessage: async (threadId, text) => {
            handled.push({ threadId, text });
            return "answer";
          },
          spawnWorker: (from, request) => {
            workerCalls.push({ from, request });
            return { ok: true, taskId: "w-1" };
          },
          proposeAgent: () => ({ ok: true, proposalId: "p1" }),
          decideProposal: (id, approve) => {
            decisions.push({ id, approve });
            return { ok: true, agentId: "tester" };
          },
          runAction: (data) => {
            const [, verb, id] = data.split(":");
            decisions.push({ id: id as string, approve: verb === "approve" });
            return { ok: true, message: "Approved: agent tester." };
          },
          moveTask: (from, request) => {
            moves.push({ from, request });
            return { ok: true };
          },
          ownerMove: (_taskId, from, to) =>
            from === "stale"
              ? { ok: false, reason: "the card was moved meanwhile" }
              : { ok: true, override: to === "deployed" },
          workflow: () => ({ workflow: { columns: ["a"] }, matrix: [] }) as never,
          openRoom: (from, request) => {
            rooms.push({ from, request });
            return { ok: true, roomId: "r1" };
          },
          syncAgents: () => {
            synced++;
            return [];
          },
          askOwner: (from, question) => {
            questions.push({ from, question });
            return { ok: true };
          },
          delegate: (from, request) => {
            delegations.push({ from, request });
            return request.agent === "nope"
              ? { ok: false, reason: "no agent nope" }
              : { ok: true, taskId: "child-1" };
          },
        },
        runTokens: tokens,
        agentsDir,
        projectsDir,
        runDir,
        transcriber: {
          available: () => ({ ok: true }),
          transcribe: async (path) => {
            heard.push(readFileSync(path).length);
            return { ok: true, text: "hello from whisper" };
          },
        },
        localModels: async () => ["qwen3:8b"],
        log: (m) => logs.push(m),
      }),
    );
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    vault.close();
    db.close();
  });

  /** Pairs a device and returns a fetch wrapper that sends its cookie and CSRF token. */
  async function pair(deviceName = "MacBook") {
    const code = createPairingCode(db, "web");
    const res = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ code, deviceName }),
    });
    expect(res.status).toBe(200);
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const { csrf, device } = (await res.json()) as { csrf: string; device: { id: string } };
    const call = (path: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: {
          cookie,
          origin: base,
          "content-type": "application/json",
          "x-achords-csrf": csrf,
          ...(init.headers as Record<string, string>),
        },
      });
    return { call, cookie, csrf, device, setCookie: res.headers.get("set-cookie") ?? "" };
  }

  it("pairing sets an HttpOnly, Secure, SameSite=Strict session cookie; the token is not in the body", async () => {
    const code = createPairingCode(db, "web");
    const res = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ code, deviceName: "MacBook" }),
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    // Named per port: browsers share cookies across ports of one host, so a second gateway
    // (tests, another instance) on 127.0.0.1 must not overwrite this one's session.
    const port = new URL(base).port;
    expect(setCookie).toMatch(new RegExp(`^achords_session_${port}=[A-Za-z0-9_-]{43};`));
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const body = await res.text();
    expect(body).not.toContain(setCookie.split(";")[0]?.split("=")[1]);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects wrong codes and locks out after 5 attempts", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${base}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ code: "AAAA-AAAA", deviceName: "x" }),
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it("logs why a request was not authenticated (never the token itself)", async () => {
    logs.length = 0;
    await fetch(`${base}/api/session`);
    await fetch(`${base}/api/session`, {
      headers: { cookie: `achords_session_${new URL(base).port}=forged-token-value` },
    });
    expect(logs).toEqual([
      expect.stringMatching(/not paired: no session cookie/),
      expect.stringMatching(/not paired: unknown, revoked or expired session/),
    ]);
    expect(logs.join("\n")).not.toContain("forged-token-value");
  });

  it("requires a session for everything except pairing", async () => {
    for (const path of [
      "/api/session",
      "/api/threads",
      "/api/tasks",
      "/api/vault",
      "/api/devices",
    ]) {
      expect((await fetch(`${base}${path}`)).status).toBe(401);
    }
  });

  it("blocks foreign Host headers (DNS rebinding)", async () => {
    const { cookie } = await pair();
    // fetch() ignores a custom Host header, so use http.request to really send one.
    const status = await new Promise<number>((resolve, reject) => {
      const r = request(
        `${base}/api/session`,
        { headers: { cookie, host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      r.on("error", reject);
      r.end();
    });
    expect(status).toBe(421);
  });

  it("requires the CSRF header and a same-origin Origin on state-changing requests", async () => {
    const { call, cookie } = await pair();
    const noCsrf = await fetch(`${base}/api/threads`, {
      method: "POST",
      headers: { cookie, origin: base, "content-type": "application/json" },
      body: "{}",
    });
    expect(noCsrf.status).toBe(403);
    const crossOrigin = await call("/api/threads", {
      method: "POST",
      body: "{}",
      headers: { origin: "https://evil.example" },
    });
    expect(crossOrigin.status).toBe(403);
    expect((await call("/api/threads", { method: "POST", body: "{}" })).status).toBe(201);
  });

  it("threads: create, post a message (handled async by the boss), list messages", async () => {
    const { call } = await pair();
    const t = (await (
      await call("/api/threads", { method: "POST", body: '{"title":"T"}' })
    ).json()) as {
      id: string;
    };
    const post = await call(`/api/threads/${t.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "szia" }),
    });
    expect(post.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(handled).toEqual([{ threadId: t.id, text: "szia" }]);

    expect(
      (await call("/api/threads/nope/messages", { method: "POST", body: '{"text":"x"}' })).status,
    ).toBe(404);
    expect((await call("/api/threads")).status).toBe(200);
    const list = (await (await call(`/api/threads/${t.id}/messages`)).json()) as unknown[];
    expect(Array.isArray(list)).toBe(true);
  });

  it("creates local-only threads; there is no way to downgrade them", async () => {
    const { call } = await pair();
    const t = (await (
      await call("/api/threads", { method: "POST", body: '{"sensitivity":"local-only"}' })
    ).json()) as { id: string; sensitivity: string };
    expect(t.sensitivity).toBe("local-only");
    expect(
      (await call("/api/threads", { method: "POST", body: '{"sensitivity":"public"}' })).status,
    ).toBe(400);
    expect(
      (await call(`/api/threads/${t.id}`, { method: "PATCH", body: '{"sensitivity":"normal"}' }))
        .status,
    ).toBe(404);
  });

  it("serves tasks and agents for the kanban", async () => {
    const { call } = await pair();
    upsertAgent(db, { id: "web-dev", name: "Web dev", role: "web-dev", workspace: "w" });
    enqueue(db, { title: "card", assigneeAgentId: "web-dev" });
    const tasks = (await (await call("/api/tasks")).json()) as { title: string }[];
    expect(tasks.map((t) => t.title)).toEqual(["card"]);
    const agents = (await (await call("/api/agents")).json()) as { id: string }[];
    expect(agents.map((a) => a.id)).toEqual(["web-dev"]);
  });

  it("vault is write-only over HTTP", async () => {
    const { call } = await pair();
    const value = "sk-test-value-0123456789-abcd";
    const put = await call("/api/vault/telegram.bot-token", {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
    expect(put.status).toBe(200);
    const list = await (await call("/api/vault")).text();
    expect(list).toContain('"last4":"abcd"');
    expect(list).not.toContain(value.slice(0, 12));
    expect(vault.audit("telegram.bot-token")[0]).toMatchObject({
      action: "set",
      actor: "web:MacBook",
    });
    expect((await call("/api/vault/telegram.bot-token", { method: "DELETE" })).status).toBe(200);
    expect((await call("/api/vault/BAD ID", { method: "PUT", body: '{"value":"x"}' })).status).toBe(
      400,
    );
  });

  it("lists devices and revokes them; a revoked session stops working", async () => {
    const mac = await pair("MacBook");
    const phone = await pair("iPhone");
    const devices = (await (await mac.call("/api/devices")).json()) as {
      id: string;
      current: boolean;
    }[];
    expect(devices.map((d) => d.current)).toEqual([true, false]);
    expect((await mac.call(`/api/devices/${phone.device.id}`, { method: "DELETE" })).status).toBe(
      200,
    );
    expect((await phone.call("/api/session")).status).toBe(401);
    expect((await mac.call("/api/session")).status).toBe(200);
  });

  it("ignores a session cookie set by a gateway on another port of the same host", async () => {
    const { cookie } = await pair();
    const token = cookie.split("=")[1];
    const res = await fetch(`${base}/api/session`, {
      headers: { cookie: `achords_session_1=other; achords_session=${token}` },
    });
    expect(res.status).toBe(401);
    const ok = await fetch(`${base}/api/session`, {
      headers: { cookie: `achords_session_1=other; ${cookie}` },
    });
    expect(ok.status).toBe(200);
  });

  it("transcribes a recorded voice note on this machine (owner only, size-limited)", async () => {
    const { cookie, csrf } = await pair();
    const post = (body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/transcribe`, {
        method: "POST",
        headers: {
          cookie,
          origin: base,
          "x-achords-csrf": csrf,
          "content-type": "audio/webm",
          ...headers,
        },
        body,
      });
    const ok = await post(new Uint8Array([1, 2, 3]));
    expect(await ok.json()).toEqual({ text: "hello from whisper" });
    expect(heard).toEqual([3]); // the audio reached the transcriber; temp file removed after
    expect(readdirSync(runDir)).toEqual([]);
    expect((await post(new Uint8Array(3), { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(new Uint8Array(11 * 1024 * 1024))).status).toBe(413);
    expect((await post(new Uint8Array(3), { "x-achords-csrf": "wrong" })).status).toBe(403);
  });

  it("logout revokes the current session and clears the cookie", async () => {
    const { call } = await pair();
    const res = await call("/api/logout", { method: "POST", body: "{}" });
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect((await call("/api/session")).status).toBe(401);
  });

  it("rejects oversized and malformed bodies", async () => {
    const { call } = await pair();
    expect((await call("/api/threads", { method: "POST", body: "{nope" })).status).toBe(400);
    const big = JSON.stringify({ title: "x".repeat(70_000) });
    expect((await call("/api/threads", { method: "POST", body: big })).status).toBe(413);
  });

  it("agent endpoint: caller identity comes only from the run token (no cookie, no CSRF)", async () => {
    delegations.length = 0;
    const run = tokens.issue("task-7", "web-dev", ["delegate", "ask_owner"]);
    const post = (auth: string | undefined, body: unknown) =>
      fetch(`${base}/api/agent/delegate`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
        body: JSON.stringify(body),
      });
    const ok = await post(`Bearer ${run.token}`, {
      agent: "writer",
      title: "Draft",
      instructions: "x",
      taskId: "someone-elses-task",
      tools: ["Bash"],
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, taskId: "child-1" });
    // The task in the body is ignored; only the token's task counts; extra fields are dropped.
    expect(delegations[0]).toEqual({
      from: { from: "task", taskId: "task-7" },
      request: { agent: "writer", title: "Draft", instructions: "x" },
    });
    expect((await post(undefined, { agent: "writer", title: "a", instructions: "b" })).status).toBe(
      401,
    );
    expect(
      (await post("Bearer forged", { agent: "writer", title: "a", instructions: "b" })).status,
    ).toBe(401);
    const refused = await post(`Bearer ${run.token}`, {
      agent: "nope",
      title: "a",
      instructions: "b",
    });
    expect(await refused.json()).toEqual({ ok: false, reason: "no agent nope" });
    run.revoke();
    expect(
      (await post(`Bearer ${run.token}`, { agent: "writer", title: "a", instructions: "b" }))
        .status,
    ).toBe(401);
  });

  it("agent endpoint: ask_owner, and only tools granted to the run", async () => {
    const run = tokens.issue("task-9", "writer", ["ask_owner"]);
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${run.token}` },
        body: JSON.stringify(body),
      });
    const asked = await post("/api/agent/ask_owner", { question: "Melyik ügyfél?" });
    expect(await asked.json()).toEqual({ ok: true });
    expect(questions.at(-1)).toEqual({
      from: { from: "task", taskId: "task-9" },
      question: "Melyik ügyfél?",
    });
    expect(
      (await post("/api/agent/delegate", { agent: "a", title: "b", instructions: "c" })).status,
    ).toBe(403);
  });

  it("agent endpoint: spawn_worker passes only the declared fields", async () => {
    const run = tokens.issue("task-5", "dev", ["spawn_worker", "propose_agent"]);
    const res = await fetch(`${base}/api/agent/spawn_worker`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${run.token}` },
      body: JSON.stringify({ instructions: "x", tools: ["Read"], paths: [], taskId: "other" }),
    });
    expect(await res.json()).toEqual({ ok: true, taskId: "w-1" });
    expect(workerCalls.at(-1)).toEqual({
      from: { from: "task", taskId: "task-5" },
      request: { instructions: "x", tools: ["Read"], paths: [] },
    });
  });

  it("kanban: the owner moves cards (stale views refused); agents move only via their run token", async () => {
    const { call } = await pair();
    const ok = await call("/api/tasks/t1/move", {
      method: "POST",
      body: '{"from":"in_progress","to":"deployed"}',
    });
    expect(await ok.json()).toEqual({ ok: true, override: true });
    expect(logs.some((l) => /owner override on task t1/.test(l))).toBe(true);
    const stale = await call("/api/tasks/t1/move", {
      method: "POST",
      body: '{"from":"stale","to":"done"}',
    });
    expect(stale.status).toBe(409);

    const token = tokens.issue("task-9", "qa", ["move_task"]).token;
    const agent = await fetch(`${base}/api/agent/move_task`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: '{"task_id":"t1","to":"done","as":"owner"}',
    });
    expect(await agent.json()).toEqual({ ok: true });
    // Identity from the token; extra fields ignored.
    expect(moves.at(-1)).toEqual({
      from: { from: "task", taskId: "task-9" },
      request: { taskId: "t1", to: "done" },
    });
    const notGranted = tokens.issue("task-9", "qa", ["ask_owner"]).token;
    const refused = await fetch(`${base}/api/agent/move_task`, {
      method: "POST",
      headers: { authorization: `Bearer ${notGranted}`, "content-type": "application/json" },
      body: '{"task_id":"t1","to":"done"}',
    });
    expect(refused.status).toBe(403);
  });

  it("message actions can be run from the web (owner session + CSRF)", async () => {
    const { call } = await pair();
    const ok = await call("/api/actions", {
      method: "POST",
      body: '{"data":"proposal:approve:p9"}',
    });
    expect(await ok.json()).toEqual({ ok: true, message: "Approved: agent tester." });
    expect(decisions.at(-1)).toEqual({ id: "p9", approve: true });
    expect(
      (await call("/api/actions", { method: "POST", body: '{"data":"rm:-rf:/"}' })).status,
    ).toBe(400);
    const noCsrf = await fetch(`${base}/api/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: '{"data":"proposal:approve:p9"}',
    });
    expect(noCsrf.status).toBe(401);
  });

  it("agent model settings: read and update through the manifest, owner only", async () => {
    const { call } = await pair();
    const agent = (await (await call("/api/agents/boss")).json()) as {
      models: { default: string; allowed: string[] };
      suggestions: string[];
    };
    expect(agent.models.default).toBe("cli-claude/sonnet");
    expect(agent.suggestions).toEqual(
      expect.arrayContaining(["cli-claude/opus", "cli-claude/fable"]),
    );

    const put = await call("/api/agents/boss/models", {
      method: "PUT",
      body: JSON.stringify({
        default: "cli-claude/opus",
        allowed: ["cli-claude/opus", "cli-claude/sonnet"],
      }),
    });
    expect(put.status).toBe(200);
    expect(readFileSync(join(agentsDir, "boss", "agent.yaml"), "utf8")).toContain(
      "default: cli-claude/opus",
    );

    const bad = await call("/api/agents/boss/models", {
      method: "PUT",
      body: JSON.stringify({
        default: "cli-claude/claude-opus",
        allowed: ["cli-claude/claude-opus"],
      }),
    });
    expect(bad.status).toBe(400);
    expect((await call("/api/agents/..%2Fevil/models", { method: "PUT", body: "{}" })).status).toBe(
      404,
    );
    expect((await call("/api/agents/nobody")).status).toBe(404);
  });

  it("agents: rename, create (deny-by-default, validated), and form options", async () => {
    const { call } = await pair();
    expect(
      (await call("/api/agents/boss/name", { method: "PUT", body: '{"name":"Chief"}' })).status,
    ).toBe(200);
    expect(readFileSync(join(agentsDir, "boss", "agent.yaml"), "utf8")).toContain("name: Chief");
    expect(synced).toBe(1); // the agent list (DB mirror) shows the new name right away

    const options = (await (await call("/api/agent-options")).json()) as {
      tools: string[];
      models: string[];
    };
    expect(options.tools).toContain("Read");
    expect(options.models).toContain("cli-claude/opus");

    const form = {
      id: "qa",
      name: "Tester",
      role: "qa",
      workspace: "web-clients",
      roles: ["qa"],
      models: { default: "cli-claude/sonnet", allowed: ["cli-claude/sonnet"] },
      tools: ["Read"],
      description: "Reviews web work.",
    };
    const created = await call("/api/agents", { method: "POST", body: JSON.stringify(form) });
    expect(created.status).toBe(201);
    expect(synced).toBeGreaterThan(0); // workflows seeded for a new workspace
    expect(readFileSync(join(agentsDir, "qa", "AGENT.md"), "utf8")).toContain("Reviews web work.");
    expect((await call("/api/agents", { method: "POST", body: JSON.stringify(form) })).status).toBe(
      409,
    );
    const bad = await call("/api/agents", {
      method: "POST",
      body: JSON.stringify({ ...form, id: "qa2", tools: ["Read"], fs: { write: ["relative"] } }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/absolute/);
  });

  it("agent rooms: agents open them with their run token; the owner reads them (ADR-0032)", async () => {
    const token = tokens.issue("task-7", "dev", ["open_room"]).token;
    const res = await fetch(`${base}/api/agent/open_room`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        topic: "Hero",
        question: "Short?",
        participants: ["qa"],
        rounds: "2",
      }),
    });
    expect(await res.json()).toEqual({ ok: true, roomId: "r1" });
    expect(rooms.at(-1)).toEqual({
      from: { from: "task", taskId: "task-7" },
      request: { topic: "Hero", question: "Short?", participants: ["qa"], rounds: 2 },
    });
    const { call } = await pair();
    expect(await (await call("/api/rooms")).json()).toEqual([]);
    expect((await call("/api/rooms/nope/messages")).status).toBe(404);
  });

  it("schedules: create (validated), list, toggle, upcoming runs, delete", async () => {
    const { call } = await pair();
    upsertAgent(db, { id: "web-dev", name: "Web dev", role: "web-dev", workspace: "w" });
    const body = {
      name: "Daily check",
      cron: "0 9 * * *",
      agentId: "web-dev",
      title: "Check",
      instructions: "Look.",
    };
    const created = await call("/api/schedules", { method: "POST", body: JSON.stringify(body) });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const bad = await call("/api/schedules", {
      method: "POST",
      body: JSON.stringify({ ...body, cron: "daily" }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/5 fields/);
    expect(
      (
        await call("/api/schedules", {
          method: "POST",
          body: JSON.stringify({ ...body, agentId: "ghost" }),
        })
      ).status,
    ).toBe(400);

    const upcoming = (await (await call("/api/schedules/upcoming?days=7")).json()) as {
      scheduleId: string;
      at: number;
    }[];
    expect(upcoming.filter((u) => u.scheduleId === id).length).toBeGreaterThanOrEqual(6);

    const off = await call(`/api/schedules/${id}`, { method: "PUT", body: '{"enabled":false}' });
    expect(((await off.json()) as { enabled: boolean }).enabled).toBe(false);
    expect(await (await call("/api/schedules/upcoming?days=7")).json()).toEqual([]);
    expect((await call(`/api/schedules/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(await (await call("/api/schedules")).json()).toEqual([]);
  });

  it("usage: latest quota windows and today's cost", async () => {
    const { call } = await pair();
    recordUsageWindows(db, "cli-claude", [
      { kind: "five_hour", utilization: 0.42, resetsAt: 9e12, status: "allowed" },
    ]);
    const run = startRun(db, { provider: "cli-claude" });
    finishRun(db, run.id, "succeeded", { costUsd: 0.3 });
    expect(await (await call("/api/usage")).json()).toEqual({
      windows: [
        expect.objectContaining({ provider: "cli-claude", kind: "five_hour", utilization: 0.42 }),
      ],
      spentTodayUsd: 0.3,
    });
  });

  it("live progress of running agents for the web bar", async () => {
    const { call } = await pair();
    const task = enqueue(db, { title: "Landing" });
    upsertAgent(db, { id: "tester", name: "Tester", role: "qa", workspace: "w" });
    const run = startRun(db, { provider: "cli-claude", taskId: task.id, agentId: "tester" });
    setRunProgress(db, run.id, { done: 1, total: 3, current: "Copy" });
    expect(await (await call("/api/runs/live")).json()).toEqual([
      expect.objectContaining({ title: "Landing", done: 1, total: 3, current: "Copy" }),
    ]);
    expect((await fetch(`${base}/api/runs/live`)).status).toBe(401);
  });

  it("projects: list, create, and pick one for a thread", async () => {
    const { call } = await pair();
    const created = await call("/api/projects", {
      method: "POST",
      body: '{"slug":"acme","name":"Acme shop","workspace":"web-clients"}',
    });
    expect(created.status).toBe(201);
    const list = (await (await call("/api/projects")).json()) as {
      slug: string;
      filesDir: string;
    }[];
    expect(list).toEqual([
      expect.objectContaining({ slug: "acme", filesDir: join(projectsDir, "acme", "files") }),
    ]);
    expect(
      (
        await call("/api/projects", {
          method: "POST",
          body: '{"slug":"acme","name":"x","workspace":"w"}',
        })
      ).status,
    ).toBe(409);

    const one = (await (await call("/api/projects/acme")).json()) as { doc: string };
    expect(one.doc).toContain("# Acme shop");
    const upd = await call("/api/projects/acme", {
      method: "PUT",
      body: JSON.stringify({ name: "Acme webshop", doc: "# Acme webshop\n\nWooCommerce." }),
    });
    expect(upd.status).toBe(200);
    expect(await (await call("/api/projects/acme")).json()).toMatchObject({
      name: "Acme webshop",
      doc: "# Acme webshop\n\nWooCommerce.",
    });
    expect(
      (await call("/api/projects/acme", { method: "PUT", body: '{"workspace":"../x"}' })).status,
    ).toBe(400);
    expect((await call("/api/projects/nope")).status).toBe(404);

    const thread = createThread(db, {});
    const set = await call(`/api/threads/${thread.id}/project`, {
      method: "PUT",
      body: '{"project":"acme"}',
    });
    expect(set.status).toBe(200);
    expect(getThread(db, thread.id)?.project).toBe("acme");
    expect(
      (
        await call(`/api/threads/${thread.id}/project`, {
          method: "PUT",
          body: '{"project":"nope"}',
        })
      ).status,
    ).toBe(404);
    await call(`/api/threads/${thread.id}/project`, { method: "PUT", body: '{"project":null}' });
    expect(getThread(db, thread.id)?.project).toBeNull();
  });

  it("only the owner (paired session + CSRF) decides proposals; agents cannot", async () => {
    const { call } = await pair();
    db.prepare(
      "INSERT INTO agent_proposals (id, proposed_by, agent_id, yaml, reason, created_at) VALUES ('p1', 'dev', 'tester', 'id: tester', 'qa', 1)",
    ).run();
    const list = (await (await call("/api/proposals")).json()) as { id: string }[];
    expect(list.map((p) => p.id)).toEqual(["p1"]);
    expect((await call("/api/proposals/p1/approve", { method: "POST", body: "{}" })).status).toBe(
      200,
    );
    expect(decisions.at(-1)).toEqual({ id: "p1", approve: true });
    // An agent's run token cannot reach owner endpoints.
    const run = tokens.issue("task-5", "dev", ["propose_agent"]);
    const viaToken = await fetch(`${base}/api/proposals/p1/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${run.token}`,
        origin: base,
      },
      body: "{}",
    });
    expect(viaToken.status).toBe(401);
    const agentApprove = await fetch(`${base}/api/agent/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${run.token}` },
      body: "{}",
    });
    expect(agentApprove.status).toBe(404);
  });

  it("unknown routes are 404", async () => {
    const { call } = await pair();
    expect((await call("/api/nope")).status).toBe(404);
    const t = createThread(db, {});
    expect(listMessages(db, t.id)).toEqual([]);
  });
});
