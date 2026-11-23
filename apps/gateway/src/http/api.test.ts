import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
  getSetting,
  getThread,
  listMessages,
  openCoreDatabase,
  recordUsageWindows,
  setRunProgress,
  setSetting,
  startRun,
  upsertAgent,
} from "@achords/core";
import { loadCatalog } from "@achords/policy";
import { openVault, type Vault } from "@achords/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpTickets, createRunTokens } from "../mcp/tokens.ts";
import { createApiHandler } from "./api.ts";

describe("HTTP API", () => {
  let db: Db;
  let vault: Vault;
  let server: Server;
  let base: string;
  let host: string;
  const handled: { threadId: string; text: string }[] = [];
  const delegations: { from: unknown; request: unknown; handoff?: boolean }[] = [];
  const questions: { from: unknown; question: string }[] = [];
  const workerCalls: { from: unknown; request: unknown }[] = [];
  const decisions: { id: string; approve: boolean }[] = [];
  const moves: unknown[] = [];
  const rooms: unknown[] = [];
  const cards: unknown[] = [];
  let synced = 0;
  const tokens = createRunTokens();
  const mcpTickets = createMcpTickets();
  // ADR-0055: the relay route, against a fake host that knows one token for "fal".
  const relayed: string[] = [];
  const mcpHost = {
    write: (token: string, id: string, line: string) => {
      if (token !== "relay-ok" || id !== "fal") return false;
      relayed.push(line);
      return true;
    },
    stream: (token: string, id: string, res: import("node:http").ServerResponse) => {
      if (token !== "relay-ok" || id !== "fal") return false;
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end('{"id":1,"result":{}}\n');
      return true;
    },
  };
  const logs: string[] = [];
  let agentsDir: string;
  let runDir: string;
  let projectsDir: string;
  let budgetDay = 0;
  const heard: number[] = [];
  let tokenServer: Server;
  let tokenReply: object = {};
  const tokenForms: URLSearchParams[] = [];

  beforeEach(async () => {
    // Fake Google token endpoint for the web sign-in.
    tokenForms.length = 0;
    tokenServer = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        tokenForms.push(new URLSearchParams(body));
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(tokenReply));
      });
    });
    await new Promise<void>((r) => tokenServer.listen(0, "127.0.0.1", r));
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
          requestAccess: (from, reason) => {
            questions.push({ from, question: `access: ${reason}` });
            return { ok: true };
          },
          requestCommand: (from, request) => {
            questions.push({ from, question: `command: ${request.command} (${request.reason})` });
            return { ok: true };
          },
          requestPublish: (from, request) => {
            questions.push({ from, question: `publish: ${JSON.stringify(request)}` });
            return { ok: true, text: "sent" };
          },
          testIntegration: async (id, project) => ({ ok: true, text: `${id}:${project ?? "-"}` }),
          logPublish: (from, report) => {
            questions.push({ from, question: `log: ${report.tool}` });
            return { ok: true, text: "logged" };
          },
          skillRead: (from, name) => {
            questions.push({ from, question: `skill_read: ${name}` });
            return { ok: true, text: "skill body" };
          },
          skillFetch: async (_from, url) => ({
            ok: true,
            text: `page ${url}`,
            untrusted: "example.com",
          }),
          skillPropose: (from, request) => {
            questions.push({ from, question: `skill_propose: ${JSON.stringify(request)}` });
            return { ok: true, text: "sent" };
          },
          createCard: (input) => {
            cards.push(input);
            if (input.agent === "nobody") {
              return { ok: false, reason: "There is no agent called nobody." };
            }
            if (input.project === "ghost") {
              return { ok: false, reason: "There is no project called ghost." };
            }
            const task = enqueue(db, { title: input.title, parked: !input.start });
            return { ok: true, taskId: task.id };
          },
          startCard: (taskId, agent) => {
            cards.push({ start: taskId, agent });
            return taskId === "started"
              ? { ok: false, reason: "This card has already started." }
              : { ok: true };
          },
          handoff: (from, request) => {
            delegations.push({ from, request, handoff: true });
            return { ok: true };
          },
          delegate: (from, request) => {
            delegations.push({ from, request });
            return request.agent === "nope"
              ? { ok: false, reason: "no agent nope" }
              : { ok: true, taskId: "child-1" };
          },
        },
        billing: {
          list: () => [],
          setMode: () => {},
          budgets: () => ({
            "cli-claude": { day: budgetDay, month: 0, spentDay: 1.5, spentMonth: 3 },
          }),
          setBudget: (_p, period, usd) => {
            if (period === "day") budgetDay = usd;
          },
        },
        runTokens: tokens,
        mcpTickets,
        mcpHost,
        agentsDir,
        projectsDir,
        home: runDir,
        runDir,
        catalog: () =>
          loadCatalog(new URL("../../../../seed/catalog/", import.meta.url).pathname, "/none"),
        integrations: () => [
          {
            id: "ga4",
            name: "GA4",
            usedBy: ["advertiser"],
            command: "uvx",
            commandFound: true,
            secrets: ["google-refresh-token"],
            missingSecrets: ["google-refresh-token"],
            perProject: false,
            projectsReady: [],
            scoped: true,
            projectsScoped: [],
            ready: false,
            testable: true,
            sites: [],
            kind: "account" as const,
          },
        ],
        transcriber: {
          available: () => ({ ok: true }),
          transcribe: async (path) => {
            heard.push(readFileSync(path).length);
            return { ok: true, text: "hello from whisper" };
          },
        },
        localModels: async () => ["qwen3:8b"],
        google: {
          authUrl: "https://accounts.example/auth",
          tokenUrl: `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/token`,
        },
        log: (m) => logs.push(m),
      }),
    );
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => tokenServer.close(r));
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
      "/api/integrations",
    ]) {
      expect((await fetch(`${base}${path}`)).status).toBe(401);
    }
  });

  it("a paired device makes a pairing code for another one (web: Devices → New pairing code)", async () => {
    const { call } = await pair();
    const res = await call("/api/pair-codes", { method: "POST", body: "{}" });
    const { code } = (await res.json()) as { code: string };
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    // The code pairs a second browser once.
    const second = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ code, deviceName: "phone" }),
    });
    expect(second.status).toBe(200);
    // Without a session nobody gets a code.
    const anon = await fetch(`${base}/api/pair-codes`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: "{}",
    });
    expect(anon.status).toBe(401);
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

  it("accepts the remote address the owner set on the web (Tailscale), nothing else", async () => {
    const { call, cookie } = await pair();
    const hostStatus = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const r = request(`${base}/api/session`, { headers: { cookie, host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        r.on("error", reject);
        r.end();
      });
    expect(await hostStatus("mac.tail1.ts.net")).toBe(421);
    const bad = await call("/api/remote-access", {
      method: "PUT",
      body: JSON.stringify({ host: "https://evil example/" }),
    });
    expect(bad.status).toBe(400);
    const ok = await call("/api/remote-access", {
      method: "PUT",
      body: JSON.stringify({ host: "https://Mac.tail1.ts.net/" }),
    });
    expect(await ok.json()).toMatchObject({ host: "mac.tail1.ts.net" });
    expect(await hostStatus("mac.tail1.ts.net")).toBe(200);
    expect(await hostStatus("evil.example")).toBe(421);
    // Cleared: back to local only.
    await call("/api/remote-access", { method: "PUT", body: JSON.stringify({ host: "" }) });
    expect(await hostStatus("mac.tail1.ts.net")).toBe(421);
  });

  it("the guide: shipped default, the owner's own text, empty goes back to the default", async () => {
    const { call } = await pair();
    const first = (await (await call("/api/guide")).json()) as { text: string; custom: boolean };
    expect(first).toMatchObject({ custom: false, text: expect.stringMatching(/^# Achords guide/) });
    const saved = await call("/api/guide", {
      method: "PUT",
      body: JSON.stringify({ text: "Short reports." }),
    });
    expect(await saved.json()).toEqual({ custom: true, text: "Short reports.\n" });
    const reset = await call("/api/guide", { method: "PUT", body: JSON.stringify({ text: "" }) });
    expect(await reset.json()).toMatchObject({ custom: false });
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

    // A pasted document (well over the usual form limits) arrives whole.
    const doc = `# Spec\n${"lorem ipsum ".repeat(20_000)}END`;
    const big = await call(`/api/threads/${t.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: doc }),
    });
    expect(big.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(handled.at(-1)?.text).toBe(doc);

    expect(
      (await call("/api/threads/nope/messages", { method: "POST", body: '{"text":"x"}' })).status,
    ).toBe(404);
    expect((await call("/api/threads")).status).toBe(200);
    const list = (await (await call(`/api/threads/${t.id}/messages`)).json()) as unknown[];
    expect(Array.isArray(list)).toBe(true);
  });

  it("chat run details: summary of the chat's work, and Stop for its tasks", async () => {
    const { call } = await pair();
    upsertAgent(db, { id: "coder", name: "Coder", role: "dev", workspace: "shared" });
    const thread = createThread(db, { title: "Auth" });
    const task = enqueue(db, { title: "Refactor", threadId: thread.id, assigneeAgentId: "coder" });
    const run = startRun(db, { provider: "cli-claude", taskId: task.id, agentId: "coder" });
    finishRun(db, run.id, "succeeded", {
      costUsd: 0.4,
      tokens: { input: 10, output: 5, cached: 0 },
    });
    budgetDay = 5;
    expect(await (await call(`/api/threads/${thread.id}/summary`)).json()).toEqual({
      agentsWorking: 0,
      agentsTotal: 1,
      tasksDone: 0,
      tasksTotal: 1,
      waitingOwner: false,
      tokensIn: 10,
      tokensCached: 0,
      tokensOut: 5,
      costUsd: 0.4,
      budgetDayUsd: 5,
      participants: [{ agent: "coder", name: "Coder", status: "queued" }],
    });
    budgetDay = 0;
    expect(await (await call(`/api/threads/${thread.id}/summary`)).json()).not.toHaveProperty(
      "budgetDayUsd",
    );
    expect((await call("/api/threads/nope/summary")).status).toBe(404);

    const stop = await call(`/api/threads/${thread.id}/stop`, { method: "POST" });
    expect(await stop.json()).toEqual({ cancelled: 1, stopped: 0 });
    expect(logs.some((l) => l.includes(`stopped chat ${thread.id}`))).toBe(true);
    expect((await call("/api/threads/nope/stop", { method: "POST" })).status).toBe(404);
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
    const integrations = (await (await call("/api/integrations")).json()) as { id: string }[];
    expect(integrations.map((i) => i.id)).toEqual(["ga4"]);
    const test = await call("/api/integrations/ga4/test", {
      method: "POST",
      body: '{"project":"acme"}',
    });
    expect(await test.json()).toEqual({ ok: true, text: "ga4:acme" });
  });

  it("monitors: create, list, edit, quiet hours, delete (ADR-0039)", async () => {
    const { call } = await pair();
    const created = await call("/api/monitors", {
      method: "POST",
      body: JSON.stringify({
        name: "Shop",
        kind: "site",
        config: { url: "https://shop.example" },
        every_minutes: 10,
      }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const bad = await call("/api/monitors", {
      method: "POST",
      body: JSON.stringify({
        name: "x",
        kind: "site",
        config: { url: "file:///etc" },
        every_minutes: 10,
      }),
    });
    expect(bad.status).toBe(400);
    expect(
      (await call(`/api/monitors/${id}`, { method: "PUT", body: '{"enabled":false}' })).status,
    ).toBe(200);
    const list = (await (await call("/api/monitors")).json()) as { enabled: boolean }[];
    expect(list.map((m) => m.enabled)).toEqual([false]);
    expect(
      (await call("/api/monitors/quiet", { method: "PUT", body: '{"hours":"22-7"}' })).status,
    ).toBe(200);
    expect(await (await call("/api/monitors/quiet")).json()).toEqual({ hours: "22-7" });
    expect(
      (await call("/api/monitors/quiet", { method: "PUT", body: '{"hours":"late"}' })).status,
    ).toBe(400);
    expect((await call(`/api/monitors/${id}`, { method: "DELETE" })).status).toBe(200);
  });

  it("chats: filter, pin, rename, archive, delete; the Telegram chat is not deletable", async () => {
    const { call } = await pair();
    const a = createThread(db, { title: "Cart bug", project: "acme" });
    const b = createThread(db, { title: "Blog" });
    const put = (id: string, body: object) =>
      call(`/api/threads/${id}`, { method: "PUT", body: JSON.stringify(body) });
    expect(
      (await (await put(a.id, { pinned: true, title: "Cart fix" })).json()) as object,
    ).toMatchObject({
      pinned: true,
      title: "Cart fix",
    });
    const ids = async (query: string) =>
      ((await (await call(`/api/threads${query}`)).json()) as { id: string }[]).map((t) => t.id);
    expect(await ids("?q=cart")).toEqual([a.id]);
    expect(await ids("?project=acme")).toEqual([a.id]);
    await put(b.id, { archived: true });
    expect(await ids("")).not.toContain(b.id);
    expect(await ids("?archived=1")).toEqual([b.id]);
    expect((await put("nope", { pinned: true })).status).toBe(404);
    // The Telegram chat can be deleted too: Telegram starts a fresh chat with its next message.
    setSetting(db, "telegram.thread_id", a.id);
    expect((await call(`/api/threads/${a.id}`, { method: "DELETE" })).status).toBe(200);
    expect(getSetting(db, "telegram.thread_id")).toBe("");
    expect((await call(`/api/threads/${b.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await ids("?archived=1")).toEqual([]);
  });

  it("own accounts: read and save lists for work without a client project (ADR-0042)", async () => {
    const { call } = await pair();
    expect(await (await call("/api/accounts")).json()).toEqual({ integrations: {} });
    const put = await call("/api/accounts", {
      method: "PUT",
      body: JSON.stringify({ integrations: { facebook: ["1365", ""], instagram: ["1784"] } }),
    });
    expect(await put.json()).toEqual({ integrations: { facebook: ["1365"], instagram: ["1784"] } });
    expect(await (await call("/api/accounts")).json()).toEqual({
      integrations: { facebook: ["1365"], instagram: ["1784"] },
    });
    const bad = await call("/api/accounts", {
      method: "PUT",
      body: JSON.stringify({ integrations: { "Bad Key": ["x"] } }),
    });
    expect(bad.status).toBe(400);
  });

  it("WordPress sites per project: list with credential status, add and remove (ADR-0047)", async () => {
    const { call } = await pair();
    await call("/api/projects", {
      method: "POST",
      body: '{"slug":"acme","name":"Acme","workspace":"web-clients"}',
    });
    const path = "/api/projects/acme/sites/wordpress";
    expect(await (await call(path)).json()).toEqual({
      integration: "wordpress",
      channel: "wordpress",
      sites: [],
    });
    const add = (url: string, at = path) =>
      call(at, { method: "POST", body: JSON.stringify({ url }) });
    expect((await add("https://Acme.example/")).status).toBe(201);
    expect((await add("https://acme.example")).status).toBe(409);
    for (const bad of [
      "ftp://x.example",
      "not a url",
      "https://u:p@x.example",
      "https://x.example/?a=1",
    ]) {
      expect((await add(bad)).status, bad).toBe(400);
    }
    const shop = await add("https://shop.acme.example");
    // Old single-site ids cover the first site; the others need their own.
    vault.set("wordpress-user-acme", "editor", "test");
    vault.set("wordpress-password-acme", "app-password-value-1234", "test");
    vault.set("wordpress-user-acme-shop-acme-example", "editor", "test");
    expect(shop.status).toBe(201);
    const listed = await (await call(path)).text();
    expect(listed).not.toContain("app-password-value");
    expect(JSON.parse(listed).sites).toEqual([
      {
        url: "https://acme.example",
        secrets: {
          user: "wordpress-user-acme-acme-example",
          password: "wordpress-password-acme-acme-example",
        },
        missing: [],
        legacy: true,
        ready: true,
      },
      {
        url: "https://shop.acme.example",
        secrets: {
          user: "wordpress-user-acme-shop-acme-example",
          password: "wordpress-password-acme-shop-acme-example",
        },
        missing: ["wordpress-password-acme-shop-acme-example"],
        legacy: false,
        ready: false,
      },
    ]);
    // Other account lists of the project stay as they were.
    expect(await (await call("/api/projects/acme")).json()).toMatchObject({
      integrations: { wordpress: ["https://acme.example", "https://shop.acme.example"] },
    });
    const del = await call(`${path}/${encodeURIComponent("https://acme.example")}`, {
      method: "DELETE",
    });
    expect(((await del.json()) as { sites: { url: string }[] }).sites.map((s) => s.url)).toEqual([
      "https://shop.acme.example",
    ]);
    expect(
      (await call(`${path}/${encodeURIComponent("https://nope.example")}`, { method: "DELETE" }))
        .status,
    ).toBe(404);
    // Own accounts hold sites the same way; unknown projects and integrations without sites don't.
    expect((await add("https://mine.example", "/api/projects/own/sites/wordpress")).status).toBe(
      201,
    );
    expect(await (await call("/api/accounts")).json()).toEqual({
      integrations: { wordpress: ["https://mine.example"] },
    });
    expect((await call("/api/projects/nope/sites/wordpress")).status).toBe(404);
    expect((await call("/api/projects/acme/sites/blender")).status).toBe(404);
  });

  it("budgets: read and set per provider, numbers only (Phase 4)", async () => {
    const { call } = await pair();
    const put = await call("/api/budgets/cli-claude", { method: "PUT", body: '{"day": 5}' });
    expect(await put.json()).toMatchObject({ "cli-claude": { day: 5, spentDay: 1.5 } });
    expect(
      (await call("/api/budgets/cli-claude", { method: "PUT", body: '{"day": -1}' })).status,
    ).toBe(400);
    const usage = (await (await call("/api/usage")).json()) as {
      spend: { today: { provider: unknown[] } };
    };
    expect(Array.isArray(usage.spend.today.provider)).toBe(true);
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

  it("integration launcher: a ticket yields the launch once; run tokens are not tickets", async () => {
    const launch = {
      command: "npx",
      args: ["x@1"],
      env: { WP_PASSWORD: "s3cret-value" },
      files: {},
    };
    const { ticket } = mcpTickets.issue(launch);
    const redeem = (auth: string) =>
      fetch(`${base}/api/agent/mcp-env`, { method: "POST", headers: { authorization: auth } });
    const first = await redeem(`Bearer ${ticket}`);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(launch);
    expect((await redeem(`Bearer ${ticket}`)).status).toBe(401);
    const run = tokens.issue("task-1", "web-dev", ["ask_owner"]);
    expect((await redeem(`Bearer ${run.token}`)).status).toBe(401);
  });

  it("relay route: only the run's own token for that integration reaches its server", async () => {
    const at = (id: string, token: string, init: RequestInit = {}) =>
      fetch(`${base}/api/agent/mcp/${id}`, {
        ...init,
        headers: { authorization: `Bearer ${token}` },
      });
    const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((await at("fal", "relay-ok", { method: "POST", body: line })).status).toBe(202);
    expect(relayed).toEqual([line]);
    const stream = await at("fal", "relay-ok");
    expect(await stream.text()).toBe('{"id":1,"result":{}}\n');
    expect((await at("fal", "forged", { method: "POST", body: line })).status).toBe(401);
    expect((await at("elevenlabs", "relay-ok")).status).toBe(401);
    // A run token of the hub tools is no relay token.
    const run = tokens.issue("task-1", "web-dev", ["delegate"]);
    expect((await at("fal", run.token)).status).toBe(401);
    // One message per request: a second line could slip past the launcher's checks.
    expect((await at("fal", "relay-ok", { method: "POST", body: `${line}\n${line}` })).status).toBe(
      400,
    );
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
    expect(
      (await post("/api/agent/handoff", { agent: "a", title: "b", instructions: "c" })).status,
    ).toBe(403);
    const next = tokens.issue("task-10", "writer", ["handoff"]);
    delegations.length = 0;
    const handed = await fetch(`${base}/api/agent/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${next.token}` },
      body: JSON.stringify({
        agent: "social",
        title: "Post",
        instructions: "post it",
        taskId: "x",
      }),
    });
    expect(await handed.json()).toEqual({ ok: true });
    expect(delegations).toEqual([
      {
        from: { from: "task", taskId: "task-10" },
        request: { agent: "social", title: "Post", instructions: "post it" },
        handoff: true,
      },
    ]);
  });

  it("agent endpoint: request_access reaches the orchestrator only when granted", async () => {
    const post = (token: string) =>
      fetch(`${base}/api/agent/request_access`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ reason: "Blender effect from a video" }),
      });
    const granted = tokens.issue("task-4", "artist", ["request_access"]).token;
    expect(await (await post(granted)).json()).toEqual({ ok: true });
    expect(questions.at(-1)).toEqual({
      from: { from: "task", taskId: "task-4" },
      question: "access: Blender effect from a video",
    });
    expect((await post(tokens.issue("task-4", "artist", ["ask_owner"]).token)).status).toBe(403);
  });

  it("agent endpoint: request_command reaches the orchestrator only when granted", async () => {
    const post = (token: string) =>
      fetch(`${base}/api/agent/request_command`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ command: "git push origin audit", reason: "merge the audit" }),
      });
    const granted = tokens.issue("task-4", "dev", ["request_command"]).token;
    expect(await (await post(granted)).json()).toEqual({ ok: true });
    expect(questions.at(-1)).toEqual({
      from: { from: "task", taskId: "task-4" },
      question: "command: git push origin audit (merge the audit)",
    });
    expect((await post(tokens.issue("task-4", "dev", ["ask_owner"]).token)).status).toBe(403);
  });

  it("publish endpoints need a token granting that integration (ADR-0037)", async () => {
    const post = (token: string, path: string, body: object) =>
      fetch(`${base}/api/agent/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    const wp = tokens.issue("task-3", "marketer", ["publish:wordpress"]).token;
    const call = { integration: "wordpress", tool: "create_draft", arguments: { title: "Hi" } };
    expect(await (await post(wp, "publish", call)).json()).toEqual({ ok: true, text: "sent" });
    expect(questions.at(-1)).toEqual({
      from: { from: "task", taskId: "task-3" },
      question: `publish: ${JSON.stringify({ integration: "wordpress", tool: "create_draft", args: { title: "Hi" } })}`,
    });
    expect((await post(wp, "publish_log", { ...call, result: "ok" })).status).toBe(200);
    expect((await post(wp, "publish", { ...call, integration: "meta" })).status).toBe(403);
    const hub = tokens.issue("task-3", "marketer", ["ask_owner"]).token;
    expect((await post(hub, "publish", call)).status).toBe(403);
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

  it("kanban: the owner edits a card, its checklist and comments; the detail has them", async () => {
    const { call } = await pair();
    const card = enqueue(db, { title: "card", description: "d" });
    const path = `/api/tasks/${card.id}`;
    const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
    logs.length = 0;

    const edited = await call(path, {
      method: "PATCH",
      body: '{"title":"new","description":null}',
    });
    expect(await json(edited)).toMatchObject({ title: "new", description: null });
    expect(logs.some((l) => l.includes(`owner edited task ${card.id}`))).toBe(true);
    expect((await call(path, { method: "PATCH", body: '{"title":""}' })).status).toBe(400);
    const long = JSON.stringify({ title: "x".repeat(201) });
    expect((await call(path, { method: "PATCH", body: long })).status).toBe(400);
    expect((await call("/api/tasks/nope", { method: "PATCH", body: '{"title":"x"}' })).status).toBe(
      404,
    );

    const item = await json(
      await call(`${path}/checklist`, { method: "POST", body: '{"text":"step"}' }),
    );
    expect(item).toMatchObject({ text: "step", done: false });
    const ticked = await call(`${path}/checklist/${item.id}`, {
      method: "PATCH",
      body: '{"done":true,"text":"step 1"}',
    });
    expect(await json(ticked)).toMatchObject({ text: "step 1", done: true });
    expect(
      (await call(`${path}/checklist/999`, { method: "PATCH", body: '{"done":true}' })).status,
    ).toBe(404);
    const second = await json(
      await call(`${path}/checklist`, { method: "POST", body: '{"text":"gone"}' }),
    );
    expect((await call(`${path}/checklist/${second.id}`, { method: "DELETE" })).status).toBe(200);

    const comment = await json(
      await call(`${path}/comments`, { method: "POST", body: '{"text":"note"}' }),
    );
    const other = await json(
      await call(`${path}/comments`, { method: "POST", body: '{"text":"drop"}' }),
    );
    expect((await call(`${path}/comments/${other.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(`${path}/comments/${other.id}`, { method: "DELETE" })).status).toBe(404);

    const detail = await json(await call(path));
    expect(detail).toMatchObject({
      title: "new",
      checklist: [{ text: "step 1", done: true }],
      comments: [{ id: comment.id, text: "note" }],
    });
    // The board list stays light.
    const list = (await (await call("/api/tasks")).json()) as Record<string, unknown>[];
    expect(list[0]).not.toHaveProperty("checklist");
    expect((await call("/api/tasks/nope")).status).toBe(404);
  });

  it("kanban: the owner creates a card by hand and starts it later", async () => {
    const { call, cookie } = await pair();
    cards.length = 0;
    const res = await call("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "Write the FAQ",
        description: "",
        agent: "dev",
        project: "acme",
        column: "backlog",
        start: false,
      }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ title: "Write the FAQ", parked: true });
    // Empty optional fields are left out; the orchestrator gets only what was chosen.
    expect(cards).toEqual([
      { title: "Write the FAQ", agent: "dev", project: "acme", column: "backlog", start: false },
    ]);
    for (const [body, error] of [
      [{}, /title/],
      [{ title: "x".repeat(201) }, /title/],
      [{ title: "x", agent: 5 }, /agent/],
      [{ title: "x", start: "yes" }, /start/],
      [{ title: "x", agent: "nobody" }, /^There is no agent called nobody\.$/],
      [{ title: "x", project: "ghost" }, /^There is no project called ghost\.$/],
    ] as const) {
      const bad = await call("/api/tasks", { method: "POST", body: JSON.stringify(body) });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toMatch(error);
    }
    // Owner session with CSRF only.
    const noCsrf = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { cookie, origin: base, "content-type": "application/json" },
      body: '{"title":"x"}',
    });
    expect(noCsrf.status).toBe(403);
    // A pasted document as the card's description is accepted whole.
    const long = await call("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "Spec", description: "d".repeat(200_000) }),
    });
    expect(long.status).toBe(201);
    const huge = await call("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "x", description: "d".repeat(1024 * 1024 + 1) }),
    });
    expect(huge.status).toBe(413);

    const card = enqueue(db, { title: "later", parked: true });
    const start = await call(`/api/tasks/${card.id}/start`, {
      method: "POST",
      body: '{"agent":"dev"}',
    });
    expect(await start.json()).toEqual({ ok: true });
    expect(cards.at(-1)).toEqual({ start: card.id, agent: "dev" });
    expect((await call("/api/tasks/nope/start", { method: "POST", body: "{}" })).status).toBe(404);
    const started = enqueue(db, { title: "s" });
    db.prepare("UPDATE tasks SET id = 'started' WHERE id = ?").run(started.id);
    const again = await call("/api/tasks/started/start", { method: "POST", body: "{}" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe(
      "This card has already started.",
    );
  });

  it("kanban: the owner deletes a card unless it is running", async () => {
    const { call } = await pair();
    const card = enqueue(db, { title: "card" });
    const running = enqueue(db, { title: "busy" });
    db.prepare("UPDATE tasks SET status = 'claimed', claimed_by = 'w' WHERE id = ?").run(
      running.id,
    );
    logs.length = 0;
    const refused = await call(`/api/tasks/${running.id}`, { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/running; stop it first/);
    const ok = await call(`/api/tasks/${card.id}`, { method: "DELETE" });
    expect(await ok.json()).toEqual({ ok: true, deleted: 1 });
    expect(logs.some((l) => l.includes(`owner deleted task ${card.id}`))).toBe(true);
    expect((await call(`/api/tasks/${card.id}`, { method: "DELETE" })).status).toBe(404);
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

  it("chat image retention: 30 days by default, the owner's number, empty keeps them", async () => {
    const { call } = await pair();
    const get = async () =>
      ((await (await call("/api/settings/images")).json()) as { keepDays: number | null }).keepDays;
    expect(await get()).toBe(30);
    const put = (keepDays: unknown) =>
      call("/api/settings/images", { method: "PUT", body: JSON.stringify({ keepDays }) });
    expect((await put(7)).status).toBe(200);
    expect(await get()).toBe(7);
    expect((await put(0)).status).toBe(400);
    expect((await put("5")).status).toBe(400);
    expect(await (await put(null)).json()).toEqual({ keepDays: null });
    expect(await get()).toBeNull();
  });

  it("chat images: stored for the chat, shown back, wrong type or size refused", async () => {
    const { call } = await pair();
    const thread = createThread(db, { title: "Shots" });
    const up = await call(`/api/threads/${thread.id}/images`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: "PNG-BYTES",
    });
    const { path, name } = (await up.json()) as { path: string; name: string };
    expect(path).toMatch(new RegExp(`/attachments/${thread.id}/[0-9a-f-]{36}\\.png$`));
    const back = await call(`/api/threads/${thread.id}/images/${name}`);
    expect(back.headers.get("content-type")).toBe("image/png");
    expect(await back.text()).toBe("PNG-BYTES");
    const svg = await call(`/api/threads/${thread.id}/images`, {
      method: "POST",
      headers: { "content-type": "image/svg+xml" },
      body: "<svg/>",
    });
    expect(svg.status).toBe(415);
    const big = await call(`/api/threads/${thread.id}/images`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: Buffer.alloc(5 * 1024 * 1024 + 1),
    });
    expect(big.status).toBe(413);
    expect((await call(`/api/threads/${thread.id}/images/..%2Fcore.db`)).status).toBe(404);
    expect((await fetch(`${base}/api/threads/${thread.id}/images/${name}`)).status).toBe(401);
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
    // Command requests (ADR-0056): all three buttons reach the orchestrator.
    for (const verb of ["task", "always", "reject"]) {
      const res = await call("/api/actions", {
        method: "POST",
        body: JSON.stringify({ data: `cmd:${verb}:b8746623` }),
      });
      expect(res.status).toBe(200);
      expect(decisions.at(-1)?.id).toBe("b8746623");
    }
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

    // Edit uses the same form, pre-filled from GET, and keeps what the form does not show.
    const detail = (await (await call("/api/agents/qa")).json()) as Record<string, unknown>;
    expect(detail).toMatchObject({
      role: "qa",
      roles: ["qa"],
      tools: ["Read"],
      fs: { read: [], write: [] },
      doc: expect.stringContaining("Reviews web work."),
    });
    const { id: _id, description: _d, ...rest } = form;
    const put = (body: unknown) =>
      call("/api/agents/qa", { method: "PUT", body: JSON.stringify(body) });
    expect(
      (await put({ ...rest, role: "reviewer", doc: "# Tester\n\nChecks pages." })).status,
    ).toBe(200);
    expect(readFileSync(join(agentsDir, "qa", "agent.yaml"), "utf8")).toContain("role: reviewer");
    expect(readFileSync(join(agentsDir, "qa", "AGENT.md"), "utf8")).toContain("Checks pages.");
    expect((await put({ ...rest, doc: "x", fs: { write: ["relative"] } })).status).toBe(400);
    expect(
      (
        await call("/api/agents/nope", {
          method: "PUT",
          body: JSON.stringify({ ...rest, doc: "x" }),
        })
      ).status,
    ).toBe(404);
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
    expect(await (await call("/api/usage")).json()).toMatchObject({
      windows: [
        expect.objectContaining({ provider: "cli-claude", kind: "five_hour", utilization: 0.42 }),
      ],
      spentTodayUsd: 0.3,
      spend: { today: { provider: [{ key: "cli-claude", billing: "subscription", usd: 0.3 }] } },
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

  it("projects: delete moves the folder aside (files kept), refused while work runs", async () => {
    const { call } = await pair();
    await call("/api/projects", {
      method: "POST",
      body: '{"slug":"gone","name":"Gone","workspace":"web-clients"}',
    });
    const busy = enqueue(db, { title: "running", project: "gone" });
    const refused = await call("/api/projects/gone", { method: "DELETE" });
    expect(refused.status).toBe(409);
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(busy.id);
    const res = await call("/api/projects/gone", { method: "DELETE" });
    const { movedTo } = (await res.json()) as { movedTo: string };
    expect(movedTo).toMatch(/projects-removed\/gone-\d{4}-\d{2}-\d{2}$/);
    expect(existsSync(join(movedTo, "PROJECT.md"))).toBe(true);
    expect((await call("/api/projects/gone")).status).toBe(404);
    expect((await call("/api/projects/gone", { method: "DELETE" })).status).toBe(404);
  });

  it("projects: git repositories accept GitHub and GitLab addresses only", async () => {
    const { call } = await pair();
    await call("/api/projects", {
      method: "POST",
      body: '{"slug":"repo","name":"Repo","workspace":"web-clients"}',
    });
    const put = (repository: string[]) =>
      call("/api/projects/repo", {
        method: "PUT",
        body: JSON.stringify({ integrations: { repository } }),
      });
    expect(
      (
        await put([
          "https://github.com/acme/booking",
          "https://gitlab.com/acme/game.git",
          "git@gitlab.com:acme/tools.git",
          "https://gitlab.example.agency/team/site",
        ])
      ).status,
    ).toBe(200);
    for (const bad of ["github.com/acme/x", "https://github.com/acme", "ftp://x/y/z", "rm -rf /"]) {
      const r = await put([bad]);
      expect(r.status, bad).toBe(400);
    }
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
    // Accounts: lists per channel, several of each.
    const accounts = { instagram: ["@acme", "@acme.shop"], ga4: ["111"] };
    expect(
      (
        await call("/api/projects/acme", {
          method: "PUT",
          body: JSON.stringify({ integrations: accounts }),
        })
      ).status,
    ).toBe(200);
    expect(await (await call("/api/projects/acme")).json()).toMatchObject({
      name: "Acme webshop",
      integrations: accounts,
    });
    for (const bad of ['{"integrations":["x"]}', '{"integrations":{"ga4":"111"}}']) {
      expect((await call("/api/projects/acme", { method: "PUT", body: bad })).status).toBe(400);
    }

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

  it("skills: agents read, fetch and propose only with granted tools; workspace never from the body", async () => {
    const run = tokens.issue("task-s", "web-dev", ["skill_read", "skill_propose"]);
    const post = (tool: string, body: unknown) =>
      fetch(`${base}/api/agent/${tool}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${run.token}` },
        body: JSON.stringify(body),
      });
    expect(await (await post("skill_read", { name: "x", workspace: "other" })).json()).toEqual({
      ok: true,
      text: "skill body",
    });
    expect(questions.at(-1)).toEqual({
      from: { from: "task", taskId: "task-s" },
      question: "skill_read: x",
    });
    await post("skill_propose", {
      name: "r",
      description: "d",
      body: "b",
      reason: "why",
      source_url: "https://example.com/r.md",
      workspace: "shared",
    });
    expect(questions.at(-1)?.question).toBe(
      'skill_propose: {"name":"r","description":"d","body":"b","reason":"why","sourceUrl":"https://example.com/r.md"}',
    );
    expect((await post("skill_fetch", { url: "https://example.com" })).status).toBe(403);
    expect((await post("skill_nope", {})).status).toBe(403);
  });

  it("skills: the owner adds, edits, switches, deletes and sets the mode (session + CSRF only)", async () => {
    upsertAgent(db, { id: "web-dev", name: "Web", role: "dev", workspace: "web-clients" });
    const { call } = await pair();
    const add = (body: unknown) =>
      call("/api/skills", { method: "POST", body: JSON.stringify(body) });
    const draft = {
      workspace: "web-clients",
      name: "owner-report",
      description: "Report",
      body: "Plain.",
    };
    expect((await add(draft)).status).toBe(200);
    expect((await add(draft)).status).toBe(409);
    expect((await add({ ...draft, name: "../x" })).status).toBe(400);
    expect((await add({ ...draft, workspace: ".." })).status).toBe(400);
    expect(
      readFileSync(join(runDir, "skills", "web-clients", "owner-report.md"), "utf8"),
    ).toContain("Plain.");

    const put = (path: string, body: unknown) =>
      call(path, { method: "PUT", body: JSON.stringify(body) });
    expect((await put("/api/skills/web-clients/owner-report", { enabled: false })).status).toBe(
      200,
    );
    await put("/api/skills/web-clients/owner-report", { description: "New", body: "Changed." });
    expect((await put("/api/skills/web-clients/missing", { enabled: true })).status).toBe(404);
    expect((await put("/api/skills-mode/web-clients", { mode: "auto" })).status).toBe(200);
    expect((await put("/api/skills-mode/web-clients", { mode: "yolo" })).status).toBe(400);

    const list = (await (await call("/api/skills")).json()) as {
      skills: { name: string; description: string; enabled: boolean; body: string }[];
      workspaces: string[];
      modes: Record<string, string>;
      proposals: unknown[];
    };
    expect(list.skills).toMatchObject([
      { name: "owner-report", description: "New", enabled: false, body: "Changed." },
    ]);
    expect(list.workspaces).toEqual(["shared", "web-clients"]);
    expect(list.modes).toEqual({ shared: "review", "web-clients": "auto" });
    expect(list.proposals).toEqual([]);

    // Writes need the CSRF header; an agent's run token is not a session.
    const noCsrf = await call("/api/skills/web-clients/owner-report", {
      method: "DELETE",
      headers: { "x-achords-csrf": "wrong" },
    });
    expect(noCsrf.status).toBe(403);
    const run = tokens.issue("task-x", "web-dev", ["skill_propose"]);
    const viaToken = await fetch(`${base}/api/skills`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${run.token}`,
        origin: base,
      },
      body: JSON.stringify(draft),
    });
    expect(viaToken.status).toBe(401);
    expect((await call("/api/skills/web-clients/owner-report", { method: "DELETE" })).status).toBe(
      200,
    );
    expect((await call("/api/skills/web-clients/owner-report", { method: "DELETE" })).status).toBe(
      404,
    );
  });

  it("skills: folder skills and agent scopes (ADR-0053): view, switch only, own-agent adds", async () => {
    upsertAgent(db, { id: "advertiser", name: "Ads", role: "ads", workspace: "marketing" });
    const { call } = await pair();
    const folder = join(runDir, "skills", "agents", "advertiser", "claude-ads", "ads-google");
    mkdirSync(join(folder, "scripts"), { recursive: true });
    const text = "---\nname: ads-google\ndescription: Google Ads\nlicense: MIT\n---\n\n# Ads\n";
    writeFileSync(join(folder, "SKILL.md"), text);
    writeFileSync(join(folder, "scripts", "check.py"), "print(1)");
    const path = "/api/skills/agents/advertiser/ads-google";

    const list = (await (await call("/api/skills")).json()) as {
      skills: { workspace: string; name: string; folder: boolean; body: string }[];
      agents: string[];
    };
    expect(list.skills).toMatchObject([
      { workspace: "agents/advertiser", name: "ads-google", folder: true, body: "" },
    ]);
    expect(list.agents).toEqual(["advertiser"]);
    expect(await (await call(path)).json()).toMatchObject({
      body: "# Ads",
      files: ["scripts/check.py"],
      more: 0,
    });

    const put = (body: unknown) => call(path, { method: "PUT", body: JSON.stringify(body) });
    expect((await put({ enabled: false })).status).toBe(200);
    expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toBe(
      text.replace("MIT\n---", "MIT\nenabled: false\n---"),
    );
    expect((await put({ description: "x", body: "y" })).status).toBe(400);
    expect((await call(path, { method: "DELETE" })).status).toBe(400);

    const add = (workspace: string) =>
      call("/api/skills", {
        method: "POST",
        body: JSON.stringify({ workspace, name: "brief", description: "Briefs", body: "B." }),
      });
    expect((await add("agents/advertiser")).status).toBe(200);
    expect(existsSync(join(runDir, "skills", "agents", "advertiser", "brief.md"))).toBe(true);
    expect((await add("agents/nobody")).status).toBe(400);
    expect((await add("agents")).status).toBe(400);
  });

  it("skills: approve and reject go through the message actions; import refuses unsafe links", async () => {
    const { call } = await pair();
    const act = await call("/api/actions", {
      method: "POST",
      body: JSON.stringify({ data: "skill:approve:ab12" }),
    });
    expect(act.status).toBe(200);
    expect(decisions.at(-1)).toEqual({ id: "ab12", approve: true });
    for (const url of [
      "http://example.com/s.md",
      "https://127.0.0.1/s.md",
      "https://localhost/x",
    ]) {
      const r = await call("/api/skills/import", { method: "POST", body: JSON.stringify({ url }) });
      expect(r.status, url).toBe(422);
    }
  });

  describe("integrations from the web: Google sign-in, revoke, local apps", () => {
    const CLIENT = JSON.stringify({
      installed: { client_id: "cid.apps", client_secret: "csecret", project_id: "proj-1" },
    });
    const start = async (call: Awaited<ReturnType<typeof pair>>["call"]) => {
      const res = await call("/api/oauth/google/start", {
        method: "POST",
        body: JSON.stringify({ client: CLIENT }),
      });
      expect(res.status).toBe(200);
      const out = (await res.json()) as { url: string; state: string };
      return { ...out, auth: new URL(out.url) };
    };

    it("signs in to Google through the gateway's loopback callback, without a cookie", async () => {
      tokenReply = {
        refresh_token: "rt-web",
        scope:
          "https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters",
      };
      const { call } = await pair();
      const { auth, state } = await start(call);
      const redirect = auth.searchParams.get("redirect_uri") as string;
      expect(redirect).toBe(`${base}/api/oauth/google/callback`);
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      expect(await (await call(`/api/oauth/google/status/${state}`)).json()).toEqual({
        status: "pending",
      });
      // Google redirects the browser: a plain GET, no session cookie.
      const page = await fetch(`${redirect}?state=${state}&code=c-1`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toMatch(/text\/html/);
      expect(await page.text()).toMatch(/Google is connected/);
      expect(tokenForms[0]?.get("redirect_uri")).toBe(redirect);
      expect(
        vault
          .list()
          .map((s) => s.id)
          .sort(),
      ).toEqual([
        "google-client-id",
        "google-client-secret",
        "google-project-id",
        "google-refresh-token",
      ]);
      expect(await (await call(`/api/oauth/google/status/${state}`)).json()).toEqual({
        status: "done",
      });
      // Single use.
      expect((await fetch(`${redirect}?state=${state}&code=c-1`)).status).toBe(400);
      expect(tokenForms).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain("rt-web");
    });

    it("refuses forged states, other devices, signed-out devices, and escapes Google's error", async () => {
      tokenReply = { refresh_token: "rt" };
      const a = await pair("Phone");
      const b = await pair("Laptop");
      const { state } = await start(a.call);
      const cb = `${base}/api/oauth/google/callback`;
      expect((await fetch(`${cb}?state=forged&code=x`)).status).toBe(400);
      expect((await b.call(`/api/oauth/google/status/${state}`)).status).toBe(404);
      const other = await b.call("/api/oauth/google/finish", {
        method: "POST",
        body: JSON.stringify({
          url: `http://127.0.0.1:1/api/oauth/google/callback?state=${state}&code=x`,
        }),
      });
      expect(other.status).toBe(400);
      // The device that started it is unpaired: the callback no longer accepts it.
      await a.call("/api/logout", { method: "POST" });
      const gone = await fetch(`${cb}?state=${state}&code=x`);
      expect(await gone.text()).toMatch(/signed out/);
      const evil = await fetch(
        `${cb}?state=forged&error=${encodeURIComponent("<script>x</script>")}`,
      );
      expect(await evil.text()).not.toContain("<script>");
      expect(tokenForms).toHaveLength(0);
      expect(vault.list()).toEqual([]);
      // Needs a session and CSRF like every other change.
      expect(
        (
          await fetch(`${base}/api/oauth/google/start`, {
            method: "POST",
            headers: { cookie: b.cookie, origin: base, "content-type": "application/json" },
            body: JSON.stringify({ client: CLIENT }),
          })
        ).status,
      ).toBe(403);
      const web = await b.call("/api/oauth/google/start", {
        method: "POST",
        body: JSON.stringify({ client: '{"web":{}}' }),
      });
      expect(web.status).toBe(400);
      expect(((await web.json()) as { error: string }).error).toMatch(/Desktop app/);
    });

    it("finishes from a pasted address (another device), then revokes", async () => {
      tokenReply = {
        refresh_token: "rt-2",
        scope:
          "https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters",
      };
      const { call } = await pair();
      const { state } = await start(call);
      const bad = await call("/api/oauth/google/finish", {
        method: "POST",
        body: JSON.stringify({ url: "not an address" }),
      });
      expect(bad.status).toBe(400);
      const ok = await call("/api/oauth/google/finish", {
        method: "POST",
        body: JSON.stringify({
          url: ` http://127.0.0.1:7420/api/oauth/google/callback?state=${state}&code=c-2&scope=x `,
        }),
      });
      expect(ok.status).toBe(200);
      expect(tokenForms[0]?.get("code")).toBe("c-2");
      expect(vault.status("google-refresh-token").set).toBe(true);

      // Revoking GA4 deletes the shared Google ids (Search Console uses them too).
      const revoke = await call("/api/integrations/ga4/secrets", { method: "DELETE" });
      expect(((await revoke.json()) as { deleted: string[] }).deleted.sort()).toEqual([
        "google-client-id",
        "google-client-secret",
        "google-project-id",
        "google-refresh-token",
      ]);
      expect(vault.list()).toEqual([]);
      vault.set("meta-access-token", "token-value-123", "test");
      await call("/api/integrations/meta/secrets", { method: "DELETE" });
      expect(vault.status("meta-access-token").set).toBe(false);
      expect((await call("/api/integrations/blender/secrets", { method: "DELETE" })).status).toBe(
        404,
      );
      expect((await call("/api/integrations/nope/secrets", { method: "DELETE" })).status).toBe(404);
    });

    it("gives a local app to the chosen agents and removes it from all", async () => {
      mkdirSync(join(agentsDir, "artist"));
      writeFileSync(
        join(agentsDir, "artist", "agent.yaml"),
        "id: artist\nname: Artist\nrole: r\nworkspace: shared\nmodels:\n  default: cli-claude/sonnet\nmcp: [unity] # 3D\n",
      );
      const { call } = await pair();
      const put = (id: string, agents: unknown) =>
        call(`/api/integrations/${id}/agents`, {
          method: "PUT",
          body: JSON.stringify({ agents }),
        });
      expect((await put("blender", ["boss", "artist"])).status).toBe(200);
      expect(readFileSync(join(agentsDir, "artist", "agent.yaml"), "utf8")).toContain(
        "mcp: [unity, blender] # 3D",
      );
      expect(readFileSync(join(agentsDir, "boss", "agent.yaml"), "utf8")).toContain(
        "mcp: [blender]",
      );
      expect((await put("blender", [])).status).toBe(200);
      expect(readFileSync(join(agentsDir, "artist", "agent.yaml"), "utf8")).toContain(
        "mcp: [unity] # 3D",
      );
      expect((await put("blender", ["ghost"])).status).toBe(400);
      // Integrations with credentials are not handed out here.
      expect((await put("ga4", ["boss"])).status).toBe(400);
      expect((await put("blender", "boss")).status).toBe(400);
    });
  });
});
