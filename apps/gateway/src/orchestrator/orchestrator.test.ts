import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachmentsDir,
  createThread,
  enqueue,
  getTask,
  listActiveRuns,
  listMessages,
  openCoreDatabase,
  saveImage,
  setPaused,
} from "@achords/core";
import { openMemory } from "@achords/memory";
import { createProject, GIT_SHELL_ENV } from "@achords/policy";
import type { ModelProvider, RunRequest, RunResult } from "@achords/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGuide, writeGuide } from "../guide.ts";
import { createOrchestrator, type Orchestrator } from "./orchestrator.ts";
import { seedAgents } from "./seed.ts";

const SEED_DIR = new URL("../../../../seed/agents/", import.meta.url).pathname;

function result(over: Partial<RunResult> = {}): RunResult {
  return {
    ok: true,
    stopReason: "completed",
    text: "",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    windows: [],
    durationMs: 1,
    ...over,
  };
}

function fakeProvider(reply: (req: RunRequest) => RunResult) {
  const calls: RunRequest[] = [];
  const provider: ModelProvider = {
    id: "cli-claude",
    async run(req) {
      calls.push(req);
      req.onSpawn?.(4242);
      return reply(req);
    },
  };
  return { provider, calls };
}

// web-dev as shipped before ADR-0067 (lists, no level): the list flows still serve unmigrated
// installs.
const legacyWebDev = (home: string) =>
  writeFileSync(
    join(home, "agents", "web-dev", "agent.yaml"),
    `# Web developer for client work. Works only inside its workspace folder.
id: web-dev
name: Web developer
role: web-dev
workspace: web-clients
models:
  default: cli-claude/sonnet
tools: [Read, Edit, Write, Glob, Grep, Bash]
fs:
  write: ["${home}/workspaces/web-clients"]
shell:
  allow: ["git status", "git diff", "git log", "ls", "npm test", "pnpm test"]
budget:
  per_run_usd: 2
`,
  );

describe("seedAgents", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-seed-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("copies seed agents once, fills in ACHORDS_HOME, never overwrites local edits", () => {
    const agents = join(home, "agents");
    expect(seedAgents(SEED_DIR, agents, home).sort()).toEqual(["boss", "web-dev"]);
    const yaml = readFileSync(join(agents, "web-dev", "agent.yaml"), "utf8");
    expect(yaml).toContain(`${home}/workspaces/web-clients`);
    expect(yaml).not.toContain("{{ACHORDS_HOME}}");
    // New installs start leveled (ADR-0067).
    expect(yaml).toMatch(/^level: 4$/m);
    expect(yaml).not.toMatch(/^(tools|shell|network|container):/m);

    writeFileSync(join(agents, "web-dev", "AGENT.md"), "local edit");
    expect(seedAgents(SEED_DIR, agents, home)).toEqual([]);
    expect(readFileSync(join(agents, "web-dev", "AGENT.md"), "utf8")).toBe("local edit");
  });
});

describe("orchestrator", () => {
  let home: string;
  let db: ReturnType<typeof openCoreDatabase>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-orch-"));
    seedAgents(SEED_DIR, join(home, "agents"), home);
    db = openCoreDatabase(join(home, "core.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const make = (reply: (req: RunRequest) => RunResult, redact?: (s: string) => string) => {
    const fake = fakeProvider(reply);
    const orch: Orchestrator = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": fake.provider },
      ...(redact ? { redact } : {}),
    });
    expect(orch.syncAgents().sort()).toEqual(["boss", "web-dev"]);
    return { orch, calls: fake.calls };
  };

  const boss = (structured: unknown) => () => result({ structured });

  it("boss answers directly: reply in the thread, no task", async () => {
    const { orch, calls } = make(boss({ action: "answer", message: "Szia!" }));
    const t = createThread(db, {});
    expect(await orch.handleMessage(t.id, "hello", "telegram")).toBe("answer");
    expect(listMessages(db, t.id).map((m) => [m.role, m.author, m.content])).toEqual([
      ["user", null, "hello"],
      ["agent", "boss", "Szia!"],
    ]);
    // Boss runs locked down: no tools, structured output, its own manifest's model and budget.
    expect(calls[0]).toMatchObject({
      model: "sonnet",
      tools: [],
      allowedTools: [],
      maxBudgetUsd: 0.5,
    });
    // The claude CLI rejects a draft 2020-12 $schema reference (found with the real CLI).
    expect(calls[0]?.jsonSchema).toMatchObject({ type: "object", required: ["action", "message"] });
    expect(calls[0]?.jsonSchema).not.toHaveProperty("$schema");
    expect(calls[0]?.prompt).toContain("web-dev");
    expect(calls[0]?.prompt).toContain("hello");
    expect(calls[0]?.appendSystemPrompt).toContain("ask");
  });

  it("subscription or API key per provider; a missing key fails with where to set it (Phase 4)", async () => {
    let mode: "subscription" | "api" = "subscription";
    let key: string | undefined = "sk-test";
    const fake = fakeProvider(() => result({ structured: { action: "answer", message: "ok" } }));
    const orch = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": fake.provider },
      billing: (provider) => {
        expect(provider).toBe("cli-claude");
        if (mode === "subscription") return { mode };
        if (!key)
          throw new Error("API mode for Claude needs its API key (Settings → Model access)");
        return { mode, env: { ANTHROPIC_API_KEY: key } };
      },
    });
    orch.syncAgents();
    const t = createThread(db, {});
    await orch.handleMessage(t.id, "hi", "web");
    expect(fake.calls[0]?.billing).toBe("subscription");
    expect(fake.calls[0]?.env).toEqual(GIT_SHELL_ENV);
    mode = "api";
    await orch.handleMessage(t.id, "hi", "web");
    expect(fake.calls[1]).toMatchObject({ billing: "api", env: { ANTHROPIC_API_KEY: "sk-test" } });
    key = undefined;
    await orch.handleMessage(t.id, "hi", "web");
    expect(fake.calls).toHaveLength(2);
    expect(listMessages(db, t.id).at(-1)?.content).toMatch(
      /needs its API key \(Settings → Model access\)/,
    );
  });

  it("prices token-only runs, records API billing, and holds API work over budget (Phase 4)", async () => {
    let blocked: string | undefined;
    const fake = fakeProvider(() =>
      result({
        text: "done",
        usage: {
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: null,
        },
      }),
    );
    const orch = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": fake.provider },
      billing: () => ({ mode: "api", env: { ANTHROPIC_API_KEY: "k" } }),
      price: (model, u) => (model === "cli-claude/sonnet" ? u.inputTokens / 1000 : null),
      budget: () => blocked,
    });
    orch.syncAgents();
    const t = createThread(db, {});
    orch.delegate(
      { from: "boss", threadId: t.id },
      { agent: "web-dev", title: "a", instructions: "go" },
    );
    await orch.workOnce();
    const run = db.prepare("SELECT billing, cost_usd, input_tokens FROM runs").get();
    expect(run).toMatchObject({ billing: "api", cost_usd: 1, input_tokens: 1000 });
    blocked = "Claude API budget for today is used up";
    const r = orch.delegate(
      { from: "boss", threadId: t.id },
      { agent: "web-dev", title: "b", instructions: "go" },
    );
    await orch.workOnce();
    expect(fake.calls).toHaveLength(1); // not run
    const task = db
      .prepare("SELECT status, error FROM tasks WHERE id = ?")
      .get(r.ok ? r.taskId : "");
    expect(task?.status).toBe("queued");
    expect(String(task?.error)).toMatch(/budget for today is used up/);
  });

  it("@agent goes straight to that agent, without the boss", async () => {
    const { orch, calls } = make(() => result({ text: "kész" }));
    const t = createThread(db, {});
    expect(
      await orch.handleMessage(t.id, "@web-dev nézd meg a kosár hibát\nrészletek", "telegram"),
    ).toBe("delegate");
    expect(calls).toHaveLength(0); // no boss run
    expect(listMessages(db, t.id).at(-1)?.content).toBe("→ web-dev is on it.");
    const task = db.prepare("SELECT title, description, assignee_agent_id FROM tasks").get();
    expect(task).toMatchObject({ title: "nézd meg a kosár hibát", assignee_agent_id: "web-dev" });
    expect(String(task?.description)).toMatch(/részletek[\s\S]*language of this message/);
    expect(await orch.handleMessage(t.id, "@nobody hello", "web")).toBe("error");
    expect(listMessages(db, t.id).at(-1)?.content).toMatch(
      /no agent called nobody. Agents: web-dev/,
    );
  });

  it("boss proposes an agent change; only the approved diff is written, once (ADR-0041)", async () => {
    const change = {
      agent: "web-dev",
      add: { network: ["developer.wordpress.org"], tools: ["WebFetch"] },
      remove: { shell: ["npm test"] },
      reason: "the owner wants web-dev to read WordPress docs",
    };
    legacyWebDev(home);
    const { orch, calls } = make(boss({ action: "change_agent", message: "Javasoltam.", change }));
    const t = createThread(db, {});
    expect(await orch.handleMessage(t.id, "web-dev olvashassa a WP doksit", "web")).toBe(
      "change_agent",
    );
    // The boss sees what each agent has now.
    expect(calls[0]?.prompt).toMatch(
      /- web-dev: mcp \[\]; tools \[Read, Edit, Write, Glob, Grep, Bash\]/,
    );
    const path = join(home, "agents", "web-dev", "agent.yaml");
    const before = readFileSync(path, "utf8");
    const msg = listMessages(db, t.id).find((m) => m.actions?.length);
    expect(msg?.content).toMatch(
      /Proposed change to web-dev[\s\S]*- tools: \+ WebFetch\n- websites: \+ developer.wordpress.org\n- shell commands: − npm test/,
    );
    expect(readFileSync(path, "utf8")).toBe(before); // nothing yet
    const approve = msg?.actions?.[0]?.data ?? "";
    expect(orch.runAction(approve).ok).toBe(true);
    const after = readFileSync(path, "utf8");
    expect(after).toContain("# Web developer for client work."); // comments kept
    expect(after).toMatch(/tools: \[Read, Edit, Write, Glob, Grep, Bash, WebFetch\]/);
    expect(after).toMatch(/allow: \[[^\]]*pnpm test[^\]]*\]/);
    expect(after).not.toMatch(/[[,] ?"?npm test/);
    expect(orch.runAction(approve).ok).toBe(false);
  });

  it("an agent change made against an older file is refused at approval", async () => {
    const change = { agent: "web-dev", add: { tools: ["WebFetch"] }, reason: "docs" };
    const { orch } = make(boss({ action: "change_agent", message: "ok", change }));
    const t = createThread(db, {});
    await orch.handleMessage(t.id, "x", "web");
    const path = join(home, "agents", "web-dev", "agent.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace("per_run_usd: 2", "per_run_usd: 3"));
    const approve = listMessages(db, t.id).find((m) => m.actions?.length)?.actions?.[0]?.data ?? "";
    expect(orch.runAction(approve)).toMatchObject({ ok: false, message: /edited since/ });
    expect(readFileSync(path, "utf8")).not.toContain("WebFetch");
  });

  it("boss proposes an addition to the project description; written once, on approval (ADR-0060)", async () => {
    createProject(join(home, "projects"), { slug: "acme", name: "Acme", workspace: "web-clients" });
    const path = join(home, "projects", "acme", "PROJECT.md");
    writeFileSync(path, "# Acme\n\nA shop.\n");
    const project_update = { add: "Acme is a Unity mobile game.\n" };
    const { orch } = make(
      boss({ action: "update_project", message: "Javasoltam.", project_update }),
    );
    const t = createThread(db, { project: "acme" });
    expect(await orch.handleMessage(t.id, "írd be a leírásba", "web")).toBe("update_project");
    const msg = listMessages(db, t.id).find((m) => m.actions?.length);
    expect(msg?.content).toMatch(
      /description of Acme:\n\nAcme is a Unity mobile game\.\n\nNothing changes/,
    );
    expect(readFileSync(path, "utf8")).toBe("# Acme\n\nA shop.\n"); // nothing yet
    const approve = msg?.actions?.[0]?.data ?? "";
    expect(orch.runAction(approve)).toMatchObject({
      ok: true,
      message: /Added to the description/,
    });
    expect(readFileSync(path, "utf8")).toBe("# Acme\n\nA shop.\n\nAcme is a Unity mobile game.\n");
    expect(orch.runAction(approve).ok).toBe(false); // once
    expect(readFileSync(path, "utf8")).toBe("# Acme\n\nA shop.\n\nAcme is a Unity mobile game.\n");
  });

  it("a project description change: rejected, stale, or in a chat without a project, writes nothing", async () => {
    createProject(join(home, "projects"), { slug: "acme", name: "Acme", workspace: "web-clients" });
    const path = join(home, "projects", "acme", "PROJECT.md");
    writeFileSync(path, "# Acme\n");
    const decision = {
      action: "update_project",
      message: "ok",
      project_update: { add: "New fact." },
    };
    const { orch } = make(boss(decision));
    const pending = async () => {
      const t = createThread(db, { project: "acme" });
      await orch.handleMessage(t.id, "x", "web");
      return listMessages(db, t.id).find((m) => m.actions?.length)?.actions ?? [];
    };

    const rejected = await pending();
    expect(orch.runAction(rejected[1]?.data ?? "")).toMatchObject({
      ok: true,
      message: /Not added/,
    });
    expect(orch.runAction(rejected[0]?.data ?? "").ok).toBe(false);

    // Edited by the owner in the meantime: the proposal no longer applies.
    const stale = await pending();
    writeFileSync(path, "# Acme\n\nEdited by hand.\n");
    expect(orch.runAction(stale[0]?.data ?? "")).toMatchObject({
      ok: false,
      message: /edited since/,
    });
    expect(readFileSync(path, "utf8")).toBe("# Acme\n\nEdited by hand.\n");

    const t = createThread(db, {});
    expect(await orch.handleMessage(t.id, "x", "web")).toBe("error");
    expect(listMessages(db, t.id).at(-1)?.content).toMatch(/no project/);
  });

  it("a delegation can carry a project description addition: the work starts, the text waits", async () => {
    createProject(join(home, "projects"), { slug: "acme", name: "Acme", workspace: "web-clients" });
    const { orch } = make(
      boss({
        action: "delegate",
        message: "web-dev megcsinálja.",
        task: {
          title: "Fix cart",
          description: "Fix it.",
          assignee: "web-dev",
          language: "Hungarian",
        },
        project_update: { add: "Acme sells shoes." },
      }),
    );
    const t = createThread(db, { project: "acme" });
    expect(await orch.handleMessage(t.id, "javítsd; amúgy cipőbolt", "web")).toBe("delegate");
    expect(db.prepare("SELECT title FROM tasks").get()).toMatchObject({ title: "Fix cart" });
    const msg = listMessages(db, t.id).find((m) => m.actions?.length);
    expect(msg?.content).toContain("Acme sells shoes.");
    expect(readFileSync(join(home, "projects", "acme", "PROJECT.md"), "utf8")).not.toContain(
      "shoes",
    );
  });

  it("AGENT.md: the agent's own runs get it, the boss sees each agent's summary", async () => {
    const { orch, calls } = make(boss({ action: "answer", message: "ok" }));
    await orch.handleMessage(createThread(db, {}).id, "hello", "web");
    // Boss: its own AGENT.md as system prompt, the team with one-line scopes.
    expect(calls[0]?.appendSystemPrompt).toMatch(/# Boss/);
    expect(calls[0]?.prompt).toMatch(
      /- web-dev: Web developer \(web-dev, workspace web-clients\): Builds and maintains client websites/,
    );
  });

  it("an older install's prompt.md still works when there is no AGENT.md", async () => {
    rmSync(join(home, "agents", "boss", "AGENT.md"));
    writeFileSync(join(home, "agents", "boss", "prompt.md"), "legacy boss prompt");
    const { orch, calls } = make(boss({ action: "answer", message: "ok" }));
    await orch.handleMessage(createThread(db, {}).id, "hello", "web");
    expect(calls[0]?.appendSystemPrompt).toMatch(/\n\nlegacy boss prompt$/);
  });

  it("boss asks a clarifying question: no task yet", async () => {
    const { orch } = make(boss({ action: "ask", message: "Melyik ügyfélnek?" }));
    const t = createThread(db, {});
    expect(await orch.handleMessage(t.id, "csinálj egy TODO appot", "telegram")).toBe("ask");
    expect(listMessages(db, t.id).at(-1)?.content).toBe("Melyik ügyfélnek?");
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()?.n).toBe(0);
  });

  it("one chat, one card: follow-up work continues the chat's card unless a new one is asked for", async () => {
    let newCard = false;
    let n = 0;
    const { orch } = make((req) =>
      req.jsonSchema
        ? result({
            structured: {
              action: "delegate",
              message: "ok",
              task: {
                title: `step ${++n}`,
                description: "do it",
                assignee: "web-dev",
                language: "Hungarian",
                ...(newCard ? { new_card: true } : {}),
              },
            },
          })
        : result({ text: "done" }),
    );
    const t = createThread(db, {});
    const cards = () =>
      db
        .prepare("SELECT title, board_column AS col FROM tasks WHERE board_column IS NOT NULL")
        .all();
    await orch.handleMessage(t.id, "first", "web");
    await orch.workOnce();
    expect(cards()).toEqual([{ title: "step 1", col: "review" }]);
    await orch.handleMessage(t.id, "fix it", "web");
    // The card moves on to the new task, back in progress; still one card.
    expect(cards()).toEqual([{ title: "step 2", col: "in_progress" }]);
    newCard = true;
    await orch.handleMessage(t.id, "and a separate ticket for the footer", "web");
    expect(cards()).toHaveLength(2);
  });

  it("boss delegates: a kanban task for the sub-agent, a one-line ack in the thread", async () => {
    const { orch } = make(
      boss({
        action: "delegate",
        message: "Rendben, a web-dev megcsinálja.",
        task: {
          title: "TODO app for Acme",
          description: "Build ...",
          assignee: "web-dev",
          language: "Hungarian",
        },
      }),
    );
    const t = createThread(db, {});
    await orch.handleMessage(t.id, "TODO app az Acme-nek, sima HTML", "web");
    const task = db.prepare("SELECT * FROM tasks").get();
    expect(task).toMatchObject({
      title: "TODO app for Acme",
      description: "Build ...\n\nWrite your final report for the owner in Hungarian.",
      assignee_agent_id: "web-dev",
      thread_id: t.id,
      status: "queued",
    });
    expect(listMessages(db, t.id).at(-1)?.content).toBe("Rendben, a web-dev megcsinálja.");
  });

  it("passes the owner's language to the sub-agent, which reports in it", async () => {
    const { orch, calls } = make((req) =>
      req.jsonSchema
        ? result({
            structured: {
              action: "delegate",
              message: "Rendben.",
              task: {
                title: "X",
                description: "Build X",
                assignee: "web-dev",
                language: "Hungarian",
              },
            },
          })
        : result({ text: "Kész." }),
    );
    const t = createThread(db, {});
    await orch.handleMessage(t.id, "csináld meg az X-et", "telegram");
    expect(db.prepare("SELECT description FROM tasks").get()?.description).toContain("Hungarian");
    await orch.workOnce();
    expect(calls.at(-1)?.prompt).toMatch(/final report.*Hungarian/s);
    // The schema asks the boss for the language explicitly.
    expect(JSON.stringify(calls[0]?.jsonSchema)).toContain("language");
  });

  it("refuses to delegate to an agent that does not exist", async () => {
    const { orch } = make(
      boss({
        action: "delegate",
        message: "ok",
        task: { title: "x", description: "y", assignee: "hacker" },
      }),
    );
    const t = createThread(db, {});
    expect(await orch.handleMessage(t.id, "do it", "web")).toBe("error");
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()?.n).toBe(0);
    expect(listMessages(db, t.id).at(-1)?.content).toMatch(/could not/i);
  });

  it("the owner's guide reaches the boss and every agent; empty goes back to the default", async () => {
    writeGuide(home, "# House rules\n\nKeep reports to five lines.");
    const { orch, calls } = make(() => result({ text: "ok" }));
    const t = createThread(db, {});
    await orch.handleMessage(t.id, "hi", "web");
    enqueue(db, { title: "X", description: "Y", threadId: t.id, assigneeAgentId: "web-dev" });
    await orch.workOnce();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect((c as RunRequest).appendSystemPrompt).toContain("Keep reports to five lines.");
    }
    writeGuide(home, "  ");
    expect(readGuide(home)).toMatchObject({
      custom: false,
      text: expect.stringMatching(/^# Achords guide/),
    });
  });

  it("images in the chat: the run may read that chat's image folder and is told how", async () => {
    const { orch, calls } = make(() => result({ text: "ok" }));
    const t = createThread(db, {});
    const other = createThread(db, {});
    saveImage(home, t.id, "image/png", Buffer.from("PNG"));
    saveImage(home, other.id, "image/png", Buffer.from("PNG"));
    enqueue(db, {
      title: "Look",
      description: "See the shot",
      threadId: t.id,
      assigneeAgentId: "web-dev",
    });
    await orch.workOnce();
    const req = calls[0] as RunRequest;
    const dir = realpathSync(attachmentsDir(home, t.id));
    expect(req.allowedTools).toContain(`Read(/${dir}/**)`);
    expect(req.allowedTools?.some((r) => r.includes(other.id))).toBe(false);
    expect(req.prompt).toMatch(/open them with the Read tool/);
  });

  it("reports a failed boss run briefly instead of going silent", async () => {
    const { orch } = make(() => result({ ok: false, stopReason: "error", error: "boom" }));
    const t = createThread(db, {});
    expect(await orch.handleMessage(t.id, "hi", "web")).toBe("error");
    expect(listMessages(db, t.id).at(-1)).toMatchObject({ author: "boss", role: "agent" });
  });

  it("worker runs the sub-agent from its manifest and reports done in the thread", async () => {
    legacyWebDev(home);
    const { orch, calls } = make(() => result({ text: "Kész: index.html a workspace-ben." }));
    const t = createThread(db, {});
    const task = enqueue(db, {
      title: "TODO app",
      description: "Build it",
      threadId: t.id,
      assigneeAgentId: "web-dev",
    });

    expect(await orch.workOnce()).toBe(true);
    const req = calls[0] as RunRequest;
    const ws = join(home, "workspaces", "web-clients");
    expect(req).toMatchObject({
      model: "sonnet",
      cwd: ws,
      // TodoWrite only keeps the run's own checklist (live progress), no file/shell/network access.
      tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "TodoWrite"],
      maxBudgetUsd: 2,
    });
    expect(existsSync(ws)).toBe(true);
    // Bash is available, but only allow-listed commands run without approval.
    expect(req.allowedTools).toContain("Bash(git status:*)");
    expect(req.allowedTools).not.toContain("Bash");
    // File tools only inside the agent's own folders: a bare "Read" would open the whole disk.
    expect(req.allowedTools).not.toContain("Read");
    expect(req.allowedTools).not.toContain("Edit");
    expect(req.allowedTools).toContain(`Read(/${realpathSync(ws)}/**)`);
    expect(req.allowedTools).toContain(`Edit(/${realpathSync(ws)}/**)`);
    expect(req.prompt).toContain("Build it");
    expect(req.appendSystemPrompt).toContain("# Web developer");

    expect(getTask(db, task.id)).toMatchObject({ status: "done" });
    // The report is the agent's own: posted under its name.
    expect(listMessages(db, t.id).at(-1)).toMatchObject({
      author: "web-dev",
      content: "Done (web-dev): TODO app\n\nKész: index.html a workspace-ben.",
    });
    // The shipped guide applies to every run, before the agent's own instructions.
    expect(req.appendSystemPrompt).toMatch(/^# Achords guide[\s\S]*# Web developer/);
    expect(listActiveRuns(db)).toEqual([]);
    const run = db.prepare("SELECT * FROM runs").get();
    expect(run).toMatchObject({
      status: "succeeded",
      pid: 4242,
      agent_id: "web-dev",
      task_id: task.id,
    });
    expect(await orch.workOnce()).toBe(false);
  });

  it("retries quietly and only reports the final failure", async () => {
    const { orch } = make(() => result({ ok: false, stopReason: "error", error: "tests failed" }));
    const t = createThread(db, {});
    const task = enqueue(db, {
      title: "X",
      threadId: t.id,
      assigneeAgentId: "web-dev",
      maxAttempts: 2,
    });
    await orch.workOnce();
    expect(getTask(db, task.id)?.status).toBe("queued");
    expect(listMessages(db, t.id)).toEqual([]);
    await orch.workOnce();
    expect(getTask(db, task.id)?.status).toBe("failed");
    expect(listMessages(db, t.id).at(-1)?.content).toBe("Failed: X\n\ntests failed");
  });

  it("enforces the manifest's model policy before running (local-only fails closed)", async () => {
    const yamlPath = join(home, "agents", "web-dev", "agent.yaml");
    writeFileSync(yamlPath, `${readFileSync(yamlPath, "utf8")}sensitivity: local-only\n`);
    const { orch, calls } = make(() => result({ text: "should not run" }));
    const task = enqueue(db, { title: "X", assigneeAgentId: "web-dev", maxAttempts: 1 });
    await orch.workOnce();
    expect(calls).toEqual([]);
    expect(getTask(db, task.id)).toMatchObject({ status: "failed" });
    expect(getTask(db, task.id)?.error).toMatch(/local-only/);
  });

  it("does nothing while the queue is paused", async () => {
    const { orch, calls } = make(() => result());
    enqueue(db, { title: "X", assigneeAgentId: "web-dev" });
    setPaused(db, true);
    expect(await orch.workOnce()).toBe(false);
    expect(calls).toEqual([]);
  });

  it("gives the boss and sub-agents relevant memories and remembers finished tasks (redacted)", async () => {
    const memory = openMemory(":memory:", { dims: 16 });
    await memory.add({
      workspace: "web-clients",
      kind: "decision",
      content: "Acme wants plain HTML, no frameworks",
    });
    await memory.add({
      workspace: "studio",
      kind: "fact",
      content: "Acme is also a Unity asset name",
    });
    const fake = fakeProvider((req) =>
      req.jsonSchema
        ? result({
            structured: {
              action: "delegate",
              message: "ok",
              task: {
                title: "Acme TODO",
                description: "Build the Acme TODO",
                assignee: "web-dev",
                language: "English",
              },
            },
          })
        : result({ text: "Built it. token=supersecretvalue123" }),
    );
    const orch = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": fake.provider },
      memory,
      redact: (s) => s.replaceAll("supersecretvalue123", "[REDACTED]"),
    });
    orch.syncAgents();
    const t = createThread(db, {});
    await orch.handleMessage(t.id, "Acme TODO please", "web");
    // The boss sees memories from every workspace.
    expect(fake.calls[0]?.prompt).toContain("Acme wants plain HTML");
    await orch.workOnce();
    // The sub-agent only sees its own workspace (+ shared).
    expect(fake.calls[1]?.prompt).toContain("Acme wants plain HTML");
    expect(fake.calls[1]?.prompt).not.toContain("Unity asset");

    const saved = await memory.search("Acme TODO built", { workspaces: ["web-clients"] });
    const summary = saved.find((h) => h.kind === "summary");
    expect(summary?.content).toContain("Built it");
    expect(summary?.content).not.toContain("supersecretvalue123");
    memory.close();
  });

  it("redacts secrets from everything posted to the thread", async () => {
    const { orch } = make(
      () => result({ text: "token=supersecretvalue123" }),
      (s) => s.replaceAll("supersecretvalue123", "[REDACTED]"),
    );
    const t = createThread(db, {});
    enqueue(db, { title: "X", threadId: t.id, assigneeAgentId: "web-dev" });
    await orch.workOnce();
    expect(listMessages(db, t.id).at(-1)?.content).toBe("Done (web-dev): X\n\ntoken=[REDACTED]");
  });

  it("stores and logs the run's refused tool calls, redacted", async () => {
    const lines: string[] = [];
    const fake = fakeProvider(() =>
      result({
        denials: [
          {
            tool: "Bash",
            input: "curl -H 'x: supersecretvalue123' https://example.com",
            reason: "requires approval: supersecretvalue123",
            unsandboxed: true,
          },
          { tool: "WebFetch", input: '{"url":"https://example.org"}', reason: "not granted" },
        ],
      }),
    );
    const orch = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": fake.provider },
      redact: (s) => s.replaceAll("supersecretvalue123", "[REDACTED]"),
      log: (m) => lines.push(m),
    });
    orch.syncAgents();
    enqueue(db, { title: "X", assigneeAgentId: "web-dev" });
    await orch.workOnce();
    const run = db.prepare("SELECT id, denials FROM runs").get() as { id: string; denials: string };
    expect(run.denials).not.toContain("supersecretvalue123");
    expect(JSON.parse(run.denials)).toEqual([
      {
        tool: "Bash",
        input: "curl -H 'x: [REDACTED]' https://example.com",
        reason: "requires approval: [REDACTED]",
        unsandboxed: true,
      },
      { tool: "WebFetch", input: '{"url":"https://example.org"}', reason: "not granted" },
    ]);
    expect(lines).toEqual([
      `run ${run.id} (web-dev): denied Bash (unsandboxed) "curl -H 'x: [REDACTED]' https://example.com" — requires approval: [REDACTED]`,
      `run ${run.id} (web-dev): denied WebFetch "{"url":"https://example.org"}" — not granted`,
    ]);
  });

  it("stores no denials for a run without refused calls", async () => {
    const { orch } = make(() => result());
    enqueue(db, { title: "X", assigneeAgentId: "web-dev" });
    await orch.workOnce();
    expect(db.prepare("SELECT denials FROM runs").get()).toEqual({ denials: null });
  });
});
