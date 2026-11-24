import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createThread,
  getTask,
  lineTaskCount,
  listMessages,
  openCoreDatabase,
  type Task,
} from "@achords/core";
import type { ModelProvider, RunRequest, RunResult } from "@achords/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunTokens } from "../mcp/tokens.ts";
import { createOrchestrator, MAX_PARENT_QUESTIONS, type Orchestrator } from "./orchestrator.ts";

const result = (over: Partial<RunResult> = {}): RunResult => ({
  ok: true,
  stopReason: "completed",
  text: "",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  windows: [],
  durationMs: 1,
  ...over,
});

interface AgentSpec {
  tools?: string[];
  to?: string[];
  from?: string[];
  model?: string;
  budget?: number;
}

/** Writes agent manifests; the boss is plain (it may delegate to all implicitly). */
function writeAgents(home: string, agents: Record<string, AgentSpec>) {
  const all: Record<string, AgentSpec> = { boss: { model: "cli-claude/sonnet" }, ...agents };
  for (const [id, a] of Object.entries(all)) {
    mkdirSync(join(home, "agents", id), { recursive: true });
    const model = a.model ?? "cli-claude/sonnet";
    writeFileSync(
      join(home, "agents", id, "agent.yaml"),
      [
        `id: ${id}`,
        `name: ${id}`,
        `role: ${id}`,
        "workspace: shared",
        `models:\n  default: ${model}\n  allowed: [${model}, local/qwen3:8b]`,
        `tools: [${(a.tools ?? []).join(", ")}]`,
        a.to || a.from
          ? `delegation:\n  can_delegate_to: [${(a.to ?? []).join(", ")}]\n  accepts_from: [${(a.from ?? []).join(", ")}]`
          : "",
        a.budget ? `budget:\n  per_run_usd: ${a.budget}` : "",
      ].join("\n"),
    );
  }
}

describe("inter-agent delegation (ADR-0029)", () => {
  let home: string;
  let db: ReturnType<typeof openCoreDatabase>;
  let calls: { agent: string; req: RunRequest }[];
  let behave: Record<string, (req: RunRequest, task: Task) => Promise<RunResult> | RunResult>;
  let orch: Orchestrator;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-deleg-"));
    db = openCoreDatabase(join(home, "core.db"));
    calls = [];
    behave = {};
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  /** Fake provider: finds which agent runs from the claimed task and applies its behaviour. */
  const start = (hub = false) => {
    const run = async (req: RunRequest) => {
      const task = db
        .prepare("SELECT id FROM tasks WHERE status = 'claimed' ORDER BY updated_at DESC LIMIT 1")
        .get();
      const t = getTask(db, String(task?.id)) as Task;
      // No claimed task: the boss answers the owner.
      const agent = t?.assigneeAgentId ?? "boss";
      calls.push({ agent, req });
      return (await behave[agent]?.(req, t)) ?? result({ text: `${agent} done` });
    };
    const cloud: ModelProvider = { id: "cli-claude", run };
    const local: ModelProvider = { id: "local", run };
    orch = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": cloud, local },
      ...(hub
        ? { hub: { url: "http://127.0.0.1:7420", tokens: createRunTokens(), serverEntry: "/x.ts" } }
        : {}),
    });
    orch.syncAgents();
  };

  const root = (agent: string, opts: { sensitivity?: "local-only"; budgetUsd?: number } = {}) => {
    const thread = createThread(db, opts.sensitivity ? { sensitivity: opts.sensitivity } : {});
    const r = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent, title: `root for ${agent}`, instructions: "go" },
      opts,
    );
    if (!r.ok) throw new Error(r.reason);
    return { thread, task: getTask(db, r.taskId) as Task };
  };

  const drain = async (max = 20) => {
    for (let i = 0; i < max; i++) if (!(await orch.workOnce())) return;
  };

  it("enforces a maximum depth of 3", async () => {
    writeAgents(home, {
      a: { to: ["b"] },
      b: { to: ["c"], from: ["a"] },
      c: { to: ["d"], from: ["b"] },
      d: { from: ["c"] },
    });
    start();
    const outcomes: string[] = [];
    for (const [caller, target] of [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
    ] as const) {
      behave[caller] = (_req, t) => {
        const r = orch.delegate(
          { from: "task", taskId: t.id },
          { agent: target, title: target, instructions: "x" },
        );
        outcomes.push(
          r.ok ? `${caller}->${target} ok` : `${caller}->${target} refused: ${r.reason}`,
        );
        return result({ text: "waiting" });
      };
    }
    root("a");
    await drain();
    expect(outcomes[0]).toBe("a->b ok");
    expect(outcomes[1]).toBe("b->c ok");
    expect(outcomes[2]).toMatch(/c->d refused: .*depth/);
  });

  it("refuses cycles (A→B→A)", async () => {
    writeAgents(home, { a: { to: ["b"], from: ["b"] }, b: { to: ["a"], from: ["a"] } });
    start();
    let refusal = "";
    behave.a = (_req, t) => {
      orch.delegate({ from: "task", taskId: t.id }, { agent: "b", title: "b", instructions: "x" });
      return result();
    };
    behave.b = (_req, t) => {
      const r = orch.delegate(
        { from: "task", taskId: t.id },
        { agent: "a", title: "back to a", instructions: "x" },
      );
      if (!r.ok) refusal = r.reason;
      return result();
    };
    root("a");
    await drain();
    expect(refusal).toMatch(/cycle/);
  });

  it("is deny by default on both sides; the boss may delegate to anyone", async () => {
    writeAgents(home, { a: {}, b: { to: ["c"] }, c: {}, d: { from: ["e"] } });
    start();
    const results: string[] = [];
    behave.a = (_req, t) => {
      const r = orch.delegate(
        { from: "task", taskId: t.id },
        { agent: "c", title: "c", instructions: "x" },
      );
      results.push(r.ok ? "a->c ok" : r.reason);
      return result();
    };
    behave.b = (_req, t) => {
      const r = orch.delegate(
        { from: "task", taskId: t.id },
        { agent: "c", title: "c", instructions: "x" },
      );
      results.push(r.ok ? "b->c ok" : r.reason);
      return result();
    };
    root("a");
    root("b");
    root("d"); // boss -> d works although d only accepts e
    await drain();
    expect(results[0]).toMatch(/a may not delegate to c/);
    expect(results[1]).toMatch(/c does not accept delegations from b/);
  });

  it("never escalates: the target runs with its own manifest, not the caller's", async () => {
    writeAgents(home, {
      a: { tools: ["Read", "Edit", "Bash"], to: ["b"], model: "cli-claude/opus" },
      b: { tools: [], from: ["a"] },
    });
    start();
    behave.a = (_req, t) => {
      // Extra fields (tools, model) are not part of the request type and are ignored at runtime.
      orch.delegate({ from: "task", taskId: t.id }, {
        agent: "b",
        title: "b",
        instructions: "x",
        ...({ tools: ["Bash"], model: "cli-claude/opus" } as object),
      } as { agent: string; title: string; instructions: string });
      return result();
    };
    root("a");
    await drain();
    const b = calls.find((c) => c.agent === "b")?.req;
    // Only the progress checklist (no access to files, shell or network); nothing from the caller.
    expect(b?.tools).toEqual(["TodoWrite"]);
    expect(b?.allowedTools).toEqual(["TodoWrite"]);
    expect(b?.model).toBe("sonnet");
  });

  it("propagates local-only to every descendant", async () => {
    writeAgents(home, { a: { to: ["b"] }, b: { to: ["c"], from: ["a"] }, c: { from: ["b"] } });
    start();
    // Delegate on the first run only; continuations see the results and finish.
    const first = (req: RunRequest) => !req.prompt.includes("Results from delegated tasks");
    behave.a = (req, t) => {
      if (first(req))
        orch.delegate(
          { from: "task", taskId: t.id },
          { agent: "b", title: "b", instructions: "x" },
        );
      return result();
    };
    behave.b = (req, t) => {
      if (first(req))
        orch.delegate(
          { from: "task", taskId: t.id },
          { agent: "c", title: "c", instructions: "x" },
        );
      return result();
    };
    root("a", { sensitivity: "local-only" });
    await drain();
    const rows = db
      .prepare("SELECT assignee_agent_id, sensitivity FROM tasks ORDER BY depth")
      .all();
    expect(rows.map((r) => `${r.assignee_agent_id}:${r.sensitivity}`)).toEqual([
      "a:local-only",
      "b:local-only",
      "c:local-only",
    ]);
    // ...and every one of them ran on the local model.
    expect(calls.every((c) => c.req.model === "qwen3:8b")).toBe(true);
  });

  it("shares one budget across the chain and stops when it is used up", async () => {
    writeAgents(home, { a: { to: ["b"], budget: 5 }, b: { from: ["a"], budget: 5 } });
    start();
    behave.a = (_req, t) => {
      if (
        t.waitingChildren === 0 &&
        getTask(db, t.id)?.agentChain.length === 1 &&
        calls.filter((c) => c.agent === "a").length === 1
      ) {
        orch.delegate(
          { from: "task", taskId: t.id },
          { agent: "b", title: "b", instructions: "x" },
        );
      }
      return result({ usage: { ...result().usage, costUsd: 0.7 } });
    };
    behave.b = () => result({ usage: { ...result().usage, costUsd: 0.7 } });
    const { task } = root("a", { budgetUsd: 1 });
    await drain();
    // a spent 0.7, so b is capped at the remaining 0.3 ...
    expect(calls.find((c) => c.agent === "b")?.req.maxBudgetUsd).toBeCloseTo(0.3);
    // ... after b the chain is over budget: a's continuation does not run.
    expect(calls.filter((c) => c.agent === "a")).toHaveLength(1);
    expect(getTask(db, task.id)).toMatchObject({ status: "failed" });
    expect(getTask(db, task.id)?.error).toMatch(/budget/);
  });

  it("limits fan-out per task", async () => {
    writeAgents(home, { a: { to: ["b"] }, b: { from: ["a"] } });
    start();
    const results: boolean[] = [];
    behave.a = (_req, t) => {
      if (t.waitingChildren === 0 && calls.filter((c) => c.agent === "a").length === 1) {
        for (let i = 0; i < 6; i++) {
          results.push(
            orch.delegate(
              { from: "task", taskId: t.id },
              { agent: "b", title: `b${i}`, instructions: "x" },
            ).ok,
          );
        }
      }
      return result();
    };
    root("a");
    await drain(30);
    expect(results).toEqual([true, true, true, true, true, false]);
  });

  it("gives agents that may delegate the hub MCP tool via a private, short-lived config file", async () => {
    writeAgents(home, { a: { to: ["b"] }, b: { from: ["a"] } });
    const tokens = createRunTokens();
    const seenDuringRun: { mode: number; token: string; tool: string[] }[] = [];
    let tokenSeen = "";
    const cloud: ModelProvider = {
      id: "cli-claude",
      async run(req) {
        const t = db
          .prepare("SELECT id, assignee_agent_id AS a FROM tasks WHERE status = 'claimed'")
          .get();
        calls.push({ agent: String(t?.a), req });
        // a delegates to b once, so that b really runs (and its hub tools can be checked).
        if (t?.a === "a" && !req.prompt.includes("Results from delegated tasks")) {
          orch.delegate(
            { from: "task", taskId: String(t.id) },
            { agent: "b", title: "b", instructions: "x" },
          );
        }
        if (req.mcpConfigPath) {
          const cfg = JSON.parse(readFileSync(req.mcpConfigPath, "utf8"));
          if (!tokenSeen) tokenSeen = cfg.mcpServers.achords.env.ACHORDS_RUN_TOKEN;
          seenDuringRun.push({
            mode: statSync(req.mcpConfigPath).mode & 0o777,
            token: tokenSeen,
            tool: req.allowedTools,
          });
          expect(tokens.resolve(cfg.mcpServers.achords.env.ACHORDS_RUN_TOKEN)).toBeDefined();
        }
        return result();
      },
    };
    orch = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": cloud, local: cloud },
      hub: { url: "http://127.0.0.1:7420", tokens, serverEntry: "/x/server.ts" },
    });
    orch.syncAgents();
    root("a");
    await drain();
    const aReq = calls.find((c) => c.agent === "a")?.req;
    const bReq = calls.find((c) => c.agent === "b")?.req;
    expect(seenDuringRun[0]).toEqual({
      mode: 0o600,
      token: seenDuringRun[0]?.token,
      tool: expect.arrayContaining(["mcp__achords__delegate", "mcp__achords__ask_owner"]),
    });
    expect(aReq?.prompt).toMatch(/You can delegate to:[\s\S]*- b/);
    // The token is only in the file, never in the request fields that end up on argv.
    expect(JSON.stringify({ ...aReq, mcpConfigPath: undefined })).not.toContain(tokenSeen);
    // After the run: file gone, token revoked.
    expect(existsSync(aReq?.mcpConfigPath as string)).toBe(false);
    expect(tokens.resolve(tokenSeen)).toBeUndefined();
    // b may not delegate: it only gets ask_owner (its file is gone too).
    expect(bReq?.allowedTools).toContain("mcp__achords__ask_owner");
    expect(bReq?.allowedTools).not.toContain("mcp__achords__delegate");
  });

  it("ask_owner from any depth: the question goes to the original thread, the answer back to the asker", async () => {
    writeAgents(home, { a: { to: ["b"] }, b: { from: ["a"] } });
    start();
    behave.a = (req, t) => {
      if (!req.prompt.includes("Results from delegated tasks")) {
        orch.delegate(
          { from: "task", taskId: t.id },
          { agent: "b", title: "Logo", instructions: "make a logo" },
        );
        return result();
      }
      return result({ text: "logo delivered" });
    };
    behave.b = (req, t) => {
      if (!req.prompt.includes("Owner's answer")) {
        expect(orch.askOwner({ from: "task", taskId: t.id }, "Kék vagy zöld legyen?")).toEqual({
          ok: true,
        });
        return result({ text: "asked" });
      }
      return result({ text: `logo in ${req.prompt.includes("zöld") ? "green" : "?"}` });
    };
    const { thread, task } = root("a");
    await drain();
    // b asked; nothing else runs until the owner answers.
    expect(listMessages(db, thread.id).map((m) => [m.author, m.content])).toEqual([
      ["b", "Question from b (Logo): Kék vagy zöld legyen?"],
    ]);
    expect(await orch.workOnce()).toBe(false);

    const before = calls.length;
    expect(await orch.handleMessage(thread.id, "zöld", "telegram")).toBe("routed");
    expect(calls.length).toBe(before); // the boss was not involved
    await drain();
    const bLast = calls.filter((c) => c.agent === "b").at(-1)?.req.prompt ?? "";
    expect(bLast).toMatch(/You asked the owner: Kék vagy zöld legyen\?\nOwner's answer: zöld/);
    expect(getTask(db, task.id)).toMatchObject({ status: "done", result: "logo delivered" });
    expect(listMessages(db, thread.id).at(-1)?.content).toMatch(/^Done \(a\): root for a/);
  });

  it("returns results to the delegating agent; the owner only gets the final result", async () => {
    writeAgents(home, { a: { to: ["b"] }, b: { from: ["a"] } });
    start();
    behave.a = (req, t) => {
      if (t.waitingChildren === 0 && !req.prompt.includes("Results from delegated tasks")) {
        orch.delegate(
          { from: "task", taskId: t.id },
          { agent: "b", title: "Research", instructions: "find X" },
        );
        return result({ text: "waiting for b" });
      }
      return result({ text: "final answer using X" });
    };
    behave.b = () => result({ text: "X is 42" });
    const { thread, task } = root("a");
    await drain();
    const aRuns = calls.filter((c) => c.agent === "a");
    expect(aRuns).toHaveLength(2);
    expect(aRuns[1]?.req.prompt).toMatch(
      /Results from delegated tasks[\s\S]*Research[\s\S]*X is 42/,
    );
    expect(getTask(db, task.id)).toMatchObject({ status: "done", result: "final answer using X" });
    const posted = listMessages(db, thread.id).map((m) => m.content);
    expect(posted).toEqual([
      expect.stringMatching(/^Done \(a\): root for a\n\nfinal answer using X/),
    ]);
  });

  describe("handoff (ADR-0055)", () => {
    const handoff = (t: Task, agent: string, title = agent) =>
      orch.handoff({ from: "task", taskId: t.id }, { agent, title, instructions: `do ${title}` });

    it("a pipeline does not use up depth: the successor continues at the caller's level", async () => {
      writeAgents(home, {
        top: { to: ["mid"] },
        mid: { to: ["a"], from: ["top"] },
        a: { to: ["b"], from: ["mid"] },
        b: { to: ["c"], from: ["a"] },
        c: { from: ["b"] },
      });
      start();
      const outcomes: string[] = [];
      behave.top = (req, t) => {
        if (req.prompt.includes("Results from delegated tasks"))
          return result({ text: "top done" });
        orch.delegate(
          { from: "task", taskId: t.id },
          { agent: "mid", title: "m", instructions: "x" },
        );
        return result({ text: "waiting" });
      };
      behave.mid = (req, t) => {
        if (req.prompt.includes("Results from delegated tasks")) {
          outcomes.push(req.prompt.includes("c finished the line") ? "mid got c" : "mid without c");
          return result({ text: "mid done" });
        }
        orch.delegate(
          { from: "task", taskId: t.id },
          { agent: "a", title: "a", instructions: "x" },
        );
        return result({ text: "waiting" });
      };
      // a is at depth 3: delegating is refused, handing off works.
      behave.a = (_req, t) => {
        const d = orch.delegate(
          { from: "task", taskId: t.id },
          { agent: "b", title: "b", instructions: "x" },
        );
        outcomes.push(d.ok ? "a delegated" : "a delegate refused");
        const h = handoff(t, "b");
        outcomes.push(h.ok ? "a handed off" : `a refused: ${h.reason}`);
        return result({ text: "a report" });
      };
      behave.b = (req, t) => {
        outcomes.push(req.prompt.includes("a report") ? "b saw a's report" : "b blind");
        expect(t.depth).toBe(3);
        handoff(t, "c");
        return result({ text: "b report" });
      };
      behave.c = () => result({ text: "c finished the line" });
      const { task } = root("top");
      await drain();
      expect(outcomes).toEqual([
        "a delegate refused",
        "a handed off",
        "b saw a's report",
        "mid got c",
      ]);
      expect(getTask(db, task.id)?.status).toBe("done");
      // mid resumed only once, after the whole line finished.
      expect(calls.filter((c) => c.agent === "mid")).toHaveLength(2);
    });

    it("from a root task: each step reports to the owner and the last one finishes", async () => {
      writeAgents(home, { a: { to: ["b"] }, b: { from: ["a"] } });
      start();
      behave.a = (_req, t) => {
        handoff(t, "b", "Edit");
        return result({ text: "script written" });
      };
      behave.b = () => result({ text: "video edited" });
      const { thread, task } = root("a");
      await drain();
      const posted = listMessages(db, thread.id).map((m) => m.content);
      expect(posted[0]).toMatch(/a handed over to b[\s\S]*script written/);
      expect(posted[1]).toMatch(/^Done \(b\): Edit\n\nvideo edited/);
      expect(getTask(db, task.id)?.status).toBe("done");
    });

    it("refuses cycles across steps, a second handoff, and handoff with open children", async () => {
      writeAgents(home, {
        a: { to: ["b", "c"] },
        b: { to: ["a", "c"], from: ["a"] },
        c: { from: ["a", "b"] },
      });
      start();
      const out: string[] = [];
      behave.a = (_req, t) => {
        out.push(handoff(t, "b").ok ? "a>b" : "a>b refused");
        const again = handoff(t, "c");
        out.push(again.ok ? "a>c" : `second: ${again.reason}`);
        return result({ text: "a" });
      };
      behave.b = (req, t) => {
        if (req.prompt.includes("Results from delegated tasks")) return result({ text: "b" });
        const back = handoff(t, "a");
        out.push(back.ok ? "b>a" : `back: ${back.reason}`);
        orch.delegate(
          { from: "task", taskId: t.id },
          { agent: "c", title: "c", instructions: "x" },
        );
        const busy = handoff(t, "c");
        out.push(busy.ok ? "b>c" : `busy: ${busy.reason}`);
        return result({ text: "b" });
      };
      root("a");
      await drain();
      expect(out[0]).toBe("a>b");
      expect(out[1]).toMatch(/^second: .*one handoff/);
      expect(out[2]).toMatch(/^back: cycle/);
      expect(out[3]).toMatch(/^busy: .*unfinished/);
    });

    it("respects delegation switches and the hop limit", async () => {
      const ring = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"];
      writeAgents(
        home,
        Object.fromEntries(
          ring.map((id, i) => [id, { to: ring.slice(i + 1), from: ring.slice(0, i) }]),
        ),
      );
      start();
      const out: string[] = [];
      for (const [i, id] of ring.entries()) {
        behave[id] = (_req, t) => {
          const next = ring[i + 1];
          if (next) {
            const h = handoff(t, next);
            out.push(h.ok ? `${id}>${next}` : `${id} refused: ${h.reason}`);
          }
          return result({ text: id });
        };
      }
      root("s0");
      await drain(40);
      expect(out.filter((o) => !o.includes("refused"))).toHaveLength(6);
      expect(out.at(-1)).toMatch(/s6 refused: .*hop limit/);
    });

    it("the boss and agents without delegation targets get no handoff tool", async () => {
      writeAgents(home, { solo: {} });
      start();
      const { task } = root("solo");
      const r = handoff(task, "boss");
      expect(r.ok).toBe(false);
    });
  });
  describe("ask_parent (ADR-0066)", () => {
    const tools = (agent: string, i = 0) =>
      calls.filter((c) => c.agent === agent)[i]?.req.allowedTools ?? [];
    const prompts = (agent: string) =>
      calls.filter((c) => c.agent === agent).map((c) => c.req.prompt);
    /** a delegates b (and optionally c) on its first run. */
    const delegateFirst = (also: string[] = []) => {
      const first = (req: RunRequest, t: Task): RunResult => {
        if (calls.filter((c) => c.agent === "a").length === 1) {
          for (const agent of ["b", ...also]) {
            orch.delegate(
              { from: "task", taskId: t.id },
              { agent, title: `step ${agent}`, instructions: "x" },
            );
          }
          return result({ text: "delegated" });
        }
        return result({
          text: req.prompt.includes("Results from delegated tasks") ? "a final" : "a",
        });
      };
      behave.a = first;
      return first;
    };

    it("the child asks; the parent is woken despite its children, answers, and the child continues", async () => {
      writeAgents(home, { a: { to: ["b", "c"] }, b: { from: ["a"] }, c: { from: ["a"] } });
      start(true);
      const base = delegateFirst(["c"]);
      behave.a = (req, t) => {
        const open = /b \(task #([\w-]+)\) asks: Which tone\?/.exec(req.prompt);
        if (open) {
          expect(t.waitingChildren).toBe(2); // woken although b and c are not finished
          expect(
            orch.answerChild(
              { from: "task", taskId: t.id },
              { taskId: open[1] as string, answer: "Friendly." },
            ),
          ).toEqual({ ok: true });
          return result({ text: "answered" });
        }
        return base(req, t);
      };
      behave.b = (req, t) => {
        if (!t.parentAnswer) {
          expect(orch.askParent({ from: "task", taskId: t.id }, "Which tone?")).toEqual({
            ok: true,
          });
          return result({ text: "asked" });
        }
        return result({
          text: `copy, ${req.prompt.includes("Answer: Friendly.") ? "friendly" : "?"}`,
        });
      };
      const { task } = root("a");
      await drain(30);
      expect(calls.map((c) => c.agent)).toEqual(["a", "b", "a", "b", "c", "a"]);
      expect(tools("a", 0)).not.toContain("mcp__achords__ask_parent"); // the root asks the owner
      expect(tools("a", 0)).not.toContain("mcp__achords__answer_child");
      expect(tools("b", 0)).toContain("mcp__achords__ask_parent");
      expect(tools("a", 1)).toContain("mcp__achords__answer_child");
      // The wake shows the question, not unfinished children as results.
      expect(prompts("a")[1]).not.toMatch(/Results from delegated tasks/);
      expect(prompts("b")[1]).toMatch(/You asked a: Which tone\?\nAnswer: Friendly\./);
      expect(getTask(db, task.id)).toMatchObject({ status: "done", result: "a final" });
      expect(prompts("a")[2]).toMatch(/copy, friendly/);
    });

    it("the fourth question is refused", async () => {
      writeAgents(home, { a: { to: ["b"] }, b: { from: ["a"] } });
      start();
      const base = delegateFirst();
      behave.a = (req, t) => {
        const open = /\(task #([\w-]+)\) asks: (q\d)/.exec(req.prompt);
        if (!open) return base(req, t);
        orch.answerChild(
          { from: "task", taskId: t.id },
          { taskId: open[1] as string, answer: `a${open[2]}` },
        );
        return result();
      };
      const asked: string[] = [];
      behave.b = (_req, t) => {
        const r = orch.askParent({ from: "task", taskId: t.id }, `q${t.parentQuestions + 1}`);
        asked.push(r.ok ? "ok" : r.reason);
        return result({ text: "b" });
      };
      root("a");
      await drain(30);
      expect(MAX_PARENT_QUESTIONS).toBe(3);
      expect(asked.slice(0, 3)).toEqual(["ok", "ok", "ok"]);
      expect(asked[3]).toMatch(/at most 3 .*ask the owner or decide/);
      expect(asked).toHaveLength(4);
    });

    it("questions do not count toward the 20 tasks, but their runs are booked to the root's budget", async () => {
      writeAgents(home, { a: { to: ["b"] }, b: { from: ["a"] } });
      start();
      const base = delegateFirst();
      const paid = { ...result().usage, costUsd: 0.25 };
      behave.a = (req, t) => {
        const open = /\(task #([\w-]+)\) asks:/.exec(req.prompt);
        if (open) {
          orch.answerChild(
            { from: "task", taskId: t.id },
            { taskId: open[1] as string, answer: "yes" },
          );
          return result({ usage: paid });
        }
        return { ...base(req, t), usage: paid };
      };
      behave.b = (_req, t) => {
        if (!t.parentAnswer) orch.askParent({ from: "task", taskId: t.id }, "ok?");
        return result({ usage: paid });
      };
      const { task } = root("a", { budgetUsd: 10 });
      await drain(30);
      // a, b (asks), a (wakes), b (continues), a (finishes).
      expect(calls).toHaveLength(5);
      expect(lineTaskCount(db, task.id)).toBe(2);
      expect(getTask(db, task.id)?.spentUsd).toBeCloseTo(1.25);
    });

    it("the owner's reply does not answer a parent question; an unanswered wake leaves it open", async () => {
      writeAgents(home, { a: { to: ["b"] }, b: { from: ["a"] } });
      start();
      delegateFirst();
      behave.b = (_req, t) => {
        if (!t.parentAnswer) orch.askParent({ from: "task", taskId: t.id }, "Which tone?");
        return result({ text: "b" });
      };
      const { thread } = root("a");
      await drain(30);
      // a delegated, b asked, a was woken once and ended without answering: nothing else runs.
      expect(calls.map((c) => c.agent)).toEqual(["a", "b", "a"]);
      const row = db.prepare("SELECT id FROM tasks WHERE assignee_agent_id = 'b'").get();
      const child = getTask(db, String(row?.id)) as Task;
      expect(child).toMatchObject({ waitingParent: true, parentQuestion: "Which tone?" });
      expect(await orch.handleMessage(thread.id, "Friendly.", "web")).not.toBe("routed");
      expect(getTask(db, child.id)).toMatchObject({ waitingParent: true, parentAnswer: null });
    });

    it("the parent can ask the owner while the child waits", async () => {
      writeAgents(home, { a: { to: ["b"] }, b: { from: ["a"] } });
      start();
      const base = delegateFirst();
      behave.a = (req, t) => {
        const open = /\(task #([\w-]+)\) asks:/.exec(req.prompt);
        if (!open) return base(req, t);
        if (!t.ownerAnswer) {
          orch.askOwner({ from: "task", taskId: t.id }, "Which tone does b need?");
          return result({ text: "asked the owner" });
        }
        orch.answerChild(
          { from: "task", taskId: t.id },
          { taskId: open[1] as string, answer: t.ownerAnswer },
        );
        return result({ text: "answered" });
      };
      behave.b = (req, t) => {
        if (!t.parentAnswer) {
          orch.askParent({ from: "task", taskId: t.id }, "Which tone?");
          return result({ text: "asked" });
        }
        return result({ text: req.prompt.includes("Answer: Formal.") ? "formal copy" : "?" });
      };
      const { thread, task } = root("a");
      await drain(30);
      expect(calls.map((c) => c.agent)).toEqual(["a", "b", "a"]);
      expect(await orch.handleMessage(thread.id, "Formal.", "web")).toBe("routed");
      await drain(30);
      expect(calls.map((c) => c.agent)).toEqual(["a", "b", "a", "a", "b", "a"]);
      // Woken again by the owner's answer, with the child's question still open.
      expect(prompts("a")[2]).toMatch(/asks: Which tone\?[\s\S]*Owner's answer: Formal\./);
      expect(prompts("a")[3]).toMatch(/formal copy/);
      expect(getTask(db, task.id)?.status).toBe("done");
    });

    it("a handoff is refused while a question is open, and asking after a handoff too", async () => {
      writeAgents(home, { a: { to: ["b"] }, b: { to: ["c"], from: ["a"] }, c: { from: ["b"] } });
      start();
      delegateFirst();
      const out: string[] = [];
      behave.b = (_req, t) => {
        if (t.parentAnswer) return result();
        orch.askParent({ from: "task", taskId: t.id }, "Which tone?");
        const h = orch.handoff(
          { from: "task", taskId: t.id },
          { agent: "c", title: "c", instructions: "x" },
        );
        out.push(h.ok ? "handed off" : h.reason);
        return result();
      };
      root("a");
      await drain(30);
      expect(out[0]).toMatch(/open question/);
      // The other way round: after a handoff the run must end, not ask.
      const c = db.prepare("SELECT id FROM tasks WHERE assignee_agent_id = 'b'").get();
      const b = getTask(db, String(c?.id)) as Task;
      db.prepare("UPDATE tasks SET handoff = ? WHERE id = ?").run(
        JSON.stringify({ agent: "c", title: "c", instructions: "x" }),
        b.id,
      );
      expect(orch.askParent({ from: "task", taskId: b.id }, "again?")).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/handed this work off/),
      });
    });
  });
});
