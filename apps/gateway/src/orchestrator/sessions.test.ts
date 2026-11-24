import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createThread,
  getCardSession,
  getTask,
  listMessages,
  openCoreDatabase,
  saveCardSession,
  sessionDir,
  type Task,
  threadCard,
} from "@achords/core";
import { GIT_SHELL_ENV, loadCatalog } from "@achords/policy";
import { cliClaude, type RunRequest, type RunResult } from "@achords/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpTickets, createRunTokens } from "../mcp/tokens.ts";
import { createOrchestrator, type Orchestrator, type OrchestratorDeps } from "./orchestrator.ts";

const FAKE = new URL(
  "../../../../packages/providers/src/fake-claude.test-helper.mjs",
  import.meta.url,
).pathname;

const result = (over: Partial<RunResult> = {}): RunResult => ({
  ok: true,
  stopReason: "completed",
  text: "done",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  windows: [],
  durationMs: 1,
  ...over,
});

describe("one CLI session per agent and card (ADR-0066)", () => {
  let home: string;
  let db: ReturnType<typeof openCoreDatabase>;
  let calls: { agent: string; task: Task; req: RunRequest }[];
  let behave: (req: RunRequest, task: Task) => RunResult | undefined;
  let orch: Orchestrator;
  let n: number;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-sess-"));
    db = openCoreDatabase(join(home, "core.db"));
    calls = [];
    behave = () => undefined;
    n = 0;
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const agent = (id: string, extra: string[] = []) => {
    mkdirSync(join(home, "agents", id), { recursive: true });
    writeFileSync(
      join(home, "agents", id, "agent.yaml"),
      [
        `id: ${id}`,
        `name: ${id}`,
        `role: ${id}`,
        "workspace: shared",
        "models:\n  default: cli-claude/sonnet\n  allowed: [cli-claude/sonnet, cli-claude/opus]",
        ...extra,
      ].join("\n"),
    );
  };

  const start = (over: Partial<OrchestratorDeps> = {}) => {
    agent("boss");
    const run = async (req: RunRequest) => {
      const row = db
        .prepare("SELECT id FROM tasks WHERE status = 'claimed' ORDER BY updated_at DESC LIMIT 1")
        .get();
      const task = getTask(db, String(row?.id)) as Task;
      calls.push({ agent: task.assigneeAgentId as string, task, req });
      n++;
      return behave(req, task) ?? result({ sessionId: req.session?.resume ?? `s-${n}` });
    };
    orch = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": { id: "cli-claude", run } },
      hub: { url: "http://127.0.0.1:7420", tokens: createRunTokens(), serverEntry: "/x.ts" },
      claudeToken: () => ({ CLAUDE_CODE_OAUTH_TOKEN: "tok" }),
      ...over,
    });
    orch.syncAgents();
  };

  const card = (target = "coder") => {
    const thread = createThread(db, {});
    const r = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: target, title: "Build the page", instructions: "make the landing page" },
    );
    if (!r.ok) throw new Error(r.reason);
    return { threadId: thread.id, taskId: r.taskId };
  };

  const drain = async () => {
    for (let i = 0; i < 20; i++) if (!(await orch.workOnce())) return;
  };

  /** The first run asks the owner; the answer resumes the same task. */
  const askFirst = () => {
    behave = (req, task) => {
      if (task.ownerAnswer) return undefined;
      orch.askOwner({ from: "task", taskId: task.id }, "Blue or green?");
      return result({ sessionId: req.session?.resume ?? `s-${n}` });
    };
  };

  it("keeps the session in the card's folder for the agent and resumes it with what is new", async () => {
    agent("coder");
    start();
    askFirst();
    const { threadId, taskId } = card();
    await drain();
    const dir = sessionDir(home, taskId, "coder");
    const first = calls[0]?.req;
    expect(first?.env).toEqual({
      ...GIT_SHELL_ENV,
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      CLAUDE_CONFIG_DIR: dir,
    });
    expect(first?.session).toEqual({});
    expect(existsSync(dir)).toBe(true);
    expect(getCardSession(db, { card: taskId, agent: "coder", project: "" })).toMatchObject({
      sessionId: "s-1",
      model: "cli-claude/sonnet",
      trust: "closed",
    });

    await orch.handleMessage(threadId, "green", "web");
    await drain();
    const second = calls[1]?.req;
    expect(second?.session).toEqual({ resume: "s-1" });
    expect(second?.env?.CLAUDE_CONFIG_DIR).toBe(dir);
    expect(second?.prompt).toMatch(/^# Continue: Build the page/);
    expect(second?.prompt).toMatch(/Owner's answer: green/);
    expect(second?.prompt).not.toMatch(/make the landing page|Conversation in this chat/);
    expect(db.prepare("SELECT resumed FROM runs ORDER BY started_at, rowid").all()).toEqual([
      { resumed: 0 },
      { resumed: 1 },
    ]);
    // In review the card is not done yet: rework sent back from review resumes the same session.
    expect(getTask(db, taskId)?.column).toBe("review");
    expect(getCardSession(db, { card: taskId, agent: "coder", project: "" })?.sessionId).toBe(
      "s-1",
    );
    // Done: the card passes its finish column, and its transcripts go.
    expect(orch.ownerMove(taskId, "review", "done")).toMatchObject({ ok: true });
    expect(getCardSession(db, { card: taskId, agent: "coder", project: "" })).toBeUndefined();
    expect(existsSync(sessionDir(home, taskId))).toBe(false);
  });

  it("a parent question reaches both resumed sessions: the question to the parent, the answer to the child", async () => {
    agent("lead", ["delegation:\n  can_delegate_to: [coder]\n  accepts_from: []"]);
    agent("coder", ["delegation:\n  can_delegate_to: []\n  accepts_from: [lead]"]);
    start();
    behave = (req, task) => {
      const resume = req.session?.resume ?? `s-${n}`;
      if (task.assigneeAgentId === "coder") {
        if (!task.parentAnswer) orch.askParent({ from: "task", taskId: task.id }, "Which font?");
        return result({ sessionId: resume });
      }
      const open = /\(task #([\w-]+)\) asks:/.exec(req.prompt);
      if (open) {
        orch.answerChild(
          { from: "task", taskId: task.id },
          { taskId: open[1] as string, answer: "Inter." },
        );
      } else if (calls.length === 1) {
        orch.delegate(
          { from: "task", taskId: task.id },
          { agent: "coder", title: "Type", instructions: "set the type" },
        );
      }
      return result({ sessionId: resume });
    };
    card("lead");
    await drain();
    expect(calls.map((c) => c.agent)).toEqual(["lead", "coder", "lead", "coder", "lead"]);
    const [, , wake, answered] = calls.map((c) => c.req);
    expect(wake?.session).toEqual({ resume: "s-1" });
    expect(wake?.prompt).toMatch(/^# Continue: Build the page/);
    expect(wake?.prompt).toMatch(/coder \(task #[\w-]+\) asks: Which font\?/);
    expect(answered?.session).toEqual({ resume: "s-2" });
    expect(answered?.prompt).toMatch(/^# Continue: Type/);
    expect(answered?.prompt).toMatch(/You asked lead: Which font\?\nAnswer: Inter\./);
  });

  it("rework sent back from review resumes the agent's session; done ends it (ADR-0062)", async () => {
    agent("coder", ["roles: [dev]"]);
    agent("qa", ["roles: [qa]"]);
    start();
    const { threadId, taskId } = card();
    let reviews = 0;
    behave = (_req, task) => {
      if (task.assigneeAgentId !== "qa") return undefined;
      reviews++;
      orch.moveTask(
        { from: "task", taskId: task.id },
        { taskId: String(threadCard(db, threadId)), to: reviews === 1 ? "in_progress" : "done" },
      );
      return result({
        text: reviews === 1 ? "The button is dead." : "Approved.",
        sessionId: `q-${n}`,
      });
    };
    await drain();
    const dev = calls.filter((c) => c.agent === "coder");
    expect(dev).toHaveLength(2);
    expect(dev[1]?.req.session).toEqual({ resume: dev[0]?.req.session?.resume ?? "s-1" });
    expect(dev[1]?.req.prompt).toMatch(/^# Next task on this card/);
    expect(dev[1]?.req.prompt).toMatch(/the button is dead/i);
    // Approved into done: the card's transcripts go, under whichever task now holds the card.
    const held = String(threadCard(db, threadId));
    expect(getTask(db, held)?.column).toBe("done");
    expect(getCardSession(db, { card: held, agent: "coder", project: "" })).toBeUndefined();
    expect(existsSync(sessionDir(home, held))).toBe(false);
    expect(taskId).not.toBe(held);
  });

  it("another card, agent or project, or a new chat, starts afresh", async () => {
    agent("coder");
    start();
    const { taskId } = card();
    const other = card();
    for (const k of [
      { card: other.taskId, agent: "coder", project: "" },
      { card: taskId, agent: "writer", project: "" },
      { card: taskId, agent: "coder", project: "acme" },
    ]) {
      saveCardSession(db, { ...k, sessionId: "old", model: "cli-claude/sonnet", trust: "closed" });
      mkdirSync(sessionDir(home, k.card, k.agent), { recursive: true });
    }
    await orch.workOnce();
    const run = calls.find((c) => c.task.id === taskId);
    expect(run?.req.session).toEqual({});
    expect(run?.req.prompt).toMatch(/^# Task: Build the page/);
  });

  it("a fallback model starts afresh and replaces the session (ADR-0058)", async () => {
    agent("coder");
    start();
    askFirst();
    const { threadId, taskId } = card();
    await drain();
    await orch.handleMessage(threadId, "green", "web");
    behave = (req) =>
      req.model === "sonnet"
        ? result({ ok: false, stopReason: "unavailable", error: "You've hit your limit" })
        : undefined;
    await drain();
    expect(calls.map((c) => [c.req.model, c.req.session?.resume])).toEqual([
      ["sonnet", undefined],
      ["sonnet", "s-1"],
      ["opus", undefined],
    ]);
    expect(calls[2]?.req.prompt).toMatch(/^# Task: Build the page/);
    expect(getTask(db, taskId)?.status).toBe("done");
  });

  it("a resume the CLI rejects runs afresh in the same task and succeeds", async () => {
    agent("coder");
    const record = join(home, "record.json");
    start({
      providers: {
        "cli-claude": cliClaude({
          command: [process.execPath, FAKE],
          env: { FAKE_CLAUDE_RECORD: record },
        }),
      },
    });
    const { taskId } = card();
    const key = { card: taskId, agent: "coder", project: "" };
    saveCardSession(db, { ...key, sessionId: "gone", model: "cli-claude/sonnet", trust: "closed" });
    mkdirSync(sessionDir(home, taskId, "coder"), { recursive: true });
    await orch.workOnce();
    expect(getTask(db, taskId)?.status).toBe("done");
    const last = JSON.parse(readFileSync(record, "utf8"));
    expect(last.argv).not.toContain("--resume");
    expect(last.stdin).toMatch(/^# Task: Build the page/);
    expect(last.configDir).toBe(sessionDir(home, taskId, "coder"));
    expect(db.prepare("SELECT resumed, status FROM runs").get()).toEqual({
      resumed: 0,
      status: "succeeded",
    });
  });

  it("an open-web session is never resumed in a keyed run, nor in one without open web", async () => {
    const catalogDir = join(home, "catalog");
    mkdirSync(catalogDir);
    writeFileSync(
      join(catalogDir, "gen.yaml"),
      `id: gen\nname: Gen\nbuiltin: wordpress\nenv:\n  KEY: "vault:gen-key"\ntools:\n  read: [run]\n`,
    );
    agent("coder", ["mcp: [gen]"]);
    agent("plain");
    start({
      integrations: {
        catalog: () => loadCatalog(join(home, "no-seed"), catalogDir),
        tickets: createMcpTickets(),
        launcherEntry: "/repo/launch.ts",
        builtins: { wordpress: "/repo/wp.ts" },
        resolveSecret: () => "sk-secret",
      },
    });
    const keyed = card("coder");
    const plain = card("plain");
    for (const [c, a] of [
      [keyed.taskId, "coder"],
      [plain.taskId, "plain"],
    ] as const) {
      saveCardSession(db, {
        card: c,
        agent: a,
        project: "",
        sessionId: "web",
        model: "cli-claude/sonnet",
        trust: "open-web",
      });
      mkdirSync(sessionDir(home, c, a), { recursive: true });
    }
    await drain();
    expect(calls.map((c) => [c.agent, c.req.session])).toEqual([
      ["coder", {}],
      ["plain", {}],
    ]);
    // The coder's run really carried a keyed integration.
    expect(calls[0]?.req.allowedTools).toContain("mcp__gen__run");
  });

  it("without the token, card runs start afresh as before and the chat says why once", async () => {
    agent("coder");
    start({ claudeToken: () => undefined });
    askFirst();
    const { threadId } = card();
    await drain();
    await orch.handleMessage(threadId, "green", "web");
    await drain();
    expect(calls.map((c) => [c.req.session, c.req.env])).toEqual([
      [undefined, GIT_SHELL_ENV],
      [undefined, GIT_SHELL_ENV],
    ]);
    const notes = listMessages(db, threadId).filter((m) => /from scratch/.test(m.content));
    expect(notes).toHaveLength(1);
  });

  it("workers and discussion turns never keep a session", async () => {
    agent("coder", ["tools: [Read]"]);
    start();
    behave = (_req, task) => {
      if (task.workerSpec || calls.length > 1) return undefined;
      orch.spawnWorker(
        { from: "task", taskId: task.id },
        { instructions: "x", tools: [], paths: [] },
      );
      return result({ sessionId: "s-1" });
    };
    card();
    await drain();
    const worker = calls.find((c) => c.task.workerSpec);
    expect(worker).toBeDefined();
    expect(worker?.req.session).toBeUndefined();
    expect(worker?.req.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});
