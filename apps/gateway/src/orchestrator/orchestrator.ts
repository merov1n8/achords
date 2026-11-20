import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  addSpend,
  answerOwnerQuestion,
  appendMessage,
  askOwner as askOwnerQuestion,
  type Channel,
  childFinished,
  claim,
  clearActions,
  closeRoom,
  complete,
  openRoom as createRoom,
  type Db,
  defer,
  enqueueChild,
  enqueueRoot,
  extendLease,
  fail,
  finishRun,
  getRoom,
  getSetting,
  getTask,
  getThread,
  isPaused,
  listChildren,
  listMessages,
  moveCard,
  nextTurn,
  openRoomsOf,
  placeCard,
  type Room,
  recordTurn,
  remainingBudget,
  roomsOf,
  type Sensitivity,
  setRunPid,
  setRunProgress,
  setSetting,
  startRun,
  type Task,
  upsertAgent,
  waitForChildren,
} from "@achords/core";
import { t } from "@achords/i18n";
import type { Embedder, Memory } from "@achords/memory";
import {
  agentSummary,
  checkFs,
  checkModel,
  checkMove,
  DEFAULT_WORKFLOW_YAML,
  isLocalModel,
  loadAgents,
  loadProjects,
  loadWorkflow,
  type Manifest,
  type Project,
  parseManifest,
  permissionMatrix,
  type Workflow,
} from "@achords/policy";
import type { ModelProvider, RunRequest } from "@achords/providers";
import { z } from "zod";
import type { RunTokens } from "../mcp/tokens.ts";

const BOSS_ID = "boss";
const WORKER_ID = "gateway";
const LEASE_MS = 10 * 60_000;
const BOSS_TIMEOUT_MS = 3 * 60_000;
const RUN_TIMEOUT_MS = 30 * 60_000;
const HISTORY = 20;
const MAX_POST = 4000;
const MEMORY_HITS = 5;
const DEFER_MS = 60_000;
const SUMMARY_CHARS = 1500;

const decisionSchema = z.object({
  action: z.enum(["answer", "ask", "delegate"]),
  message: z.string().min(1).describe("What the owner reads. One line for delegate."),
  task: z
    .object({
      title: z.string().min(1),
      description: z.string().min(1).describe("Self-contained instructions for the agent"),
      assignee: z.string().min(1).describe("Agent id from the list"),
      language: z
        .string()
        .min(1)
        .describe("Language the owner writes in (e.g. Hungarian); the agent reports in it"),
    })
    .optional(),
});
// The claude CLI's validator rejects zod's draft 2020-12 `$schema` reference; the rest is plain.
const { $schema: _, ...DECISION_JSON_SCHEMA } = z.toJSONSchema(decisionSchema);

export interface OrchestratorDeps {
  db: Db;
  home: string;
  /** Keyed by the provider part of a manifest model id, e.g. "cli-claude". */
  providers: Record<string, ModelProvider>;
  /** Applied to everything posted to threads (ADR-0012). */
  redact?: (text: string) => string;
  /** Long-term memory (ADR-0008); optional so the hub works without it. */
  memory?: Memory;
  embedder?: Embedder;
  /** The hub's own MCP server for agent runs (ADR-0029); `url` is set once the API listens. */
  hub?: { url: string; tokens: RunTokens; serverEntry: string };
}

export interface Orchestrator {
  handleMessage(
    threadId: string,
    text: string,
    channel: Channel,
  ): Promise<"answer" | "ask" | "delegate" | "routed" | "error">;
  /**
   * Ephemeral worker (ADR-0029): runs the caller's agent with a subset of its permissions;
   * requests beyond them are rejected, not trimmed. Max 3 per task; workers get no hub tools.
   */
  spawnWorker(
    from: { from: "task"; taskId: string },
    request: { instructions: string; tools: string[]; paths: string[] },
  ): { ok: true; taskId: string } | { ok: false; reason: string };
  /**
   * Opens a bounded discussion (ADR-0032) with agents the caller may delegate to; the caller
   * resumes with the transcript once every participant has spoken in every round.
   */
  openRoom(
    from: { from: "task"; taskId: string },
    request: { topic: string; question: string; participants: string[]; rounds: number },
  ): { ok: true; roomId: string } | { ok: false; reason: string };
  /** Files a new-agent proposal; nothing is created until the owner approves it. */
  proposeAgent(
    from: { from: "task"; taskId: string },
    request: { yaml: string; reason: string },
  ): { ok: true; proposalId: string } | { ok: false; reason: string };
  /** Owner decision on a proposal (Telegram /approve, web). */
  decideProposal(
    id: string,
    approve: boolean,
  ): { ok: true; agentId: string } | { ok: false; reason: string };
  /** An agent asks the owner (ADR-0029): posted to the task's thread; the task waits. */
  askOwner(
    from: { from: "task"; taskId: string },
    question: string,
  ): { ok: true } | { ok: false; reason: string };
  /** Loads manifests and mirrors them into the DB; seeds missing workflows. Returns agent ids. */
  syncAgents(): string[];
  /** An agent moves a kanban card (hub tool move_task), checked against the workflow. */
  moveTask(
    from: { from: "task"; taskId: string },
    request: { taskId: string; to: string },
  ): { ok: true; pending?: true } | { ok: false; reason: string };
  /** The owner moves a card (web drag & drop); `from` is the column the owner saw. */
  ownerMove(
    taskId: string,
    from: string,
    to: string,
  ): { ok: true; override: boolean } | { ok: false; reason: string };
  /** A message button (Telegram or web): proposal:<verb>:<id> or move:<verb>:<taskId>. */
  runAction(data: string): { ok: boolean; message: string };
  /** A workspace's workflow and its permission matrix (read-only web view). */
  workflow(workspace: string): { workflow: Workflow; matrix: ReturnType<typeof permissionMatrix> };
  /** Claims and runs one task. Returns false if there was nothing to do. */
  workOnce(signal?: AbortSignal): Promise<boolean>;
  /**
   * Delegates work (ADR-0029). The caller is the boss (for a thread) or the assignee of a task;
   * it is derived from `from`, never taken from the request, and cannot pass permissions.
   */
  delegate(
    from: { from: "boss"; threadId: string } | { from: "task"; taskId: string },
    request: { agent: string; title: string; instructions: string },
    opts?: { budgetUsd?: number },
  ): { ok: true; taskId: string } | { ok: false; reason: string };
}

export const MAX_DELEGATION_DEPTH = 3;
export const MAX_CHILDREN_PER_TASK = 5;
export const MAX_WORKERS_PER_TASK = 3;
export const MAX_ROOM_PARTICIPANTS = 3;
// The owner's live bar shows % done from this checklist (Claude Code's TodoWrite tool).
const PROGRESS_HINT =
  "For work with more than one step, keep a short checklist with the TodoWrite tool and update it as you go; the owner sees your progress from it.";
export const MAX_ROOM_ROUNDS = 3;
// Discussion turns only read: never write, run commands or use hub tools (ADR-0032).
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];
const WORKER_REFUSAL = "workers cannot spawn workers or delegate (depth 1)";

const expandHome = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const { db, home } = deps;
  const redact = deps.redact ?? ((s: string) => s);
  const agentsDir = join(home, "agents");

  // Re-read on every use so manifest edits apply without a restart; mirrored into the DB
  // because tasks reference agents by id.
  const agents = () => {
    const all = loadAgents(agentsDir);
    for (const m of all.values()) upsertAgent(db, m);
    return all;
  };

  const post = (threadId: string, content: string) =>
    appendMessage(db, {
      threadId,
      role: "agent",
      author: BOSS_ID,
      channel: "system",
      content: redact(content).slice(0, MAX_POST),
    });

  // Relevant memories as a prompt section; empty when there is no memory or nothing matches.
  // `local`: the prompt goes to a local model, so local-only memories may be included.
  const recall = async (query: string, workspaces: string[], local: boolean) => {
    if (!deps.memory) return "";
    const hits = await deps.memory.search(
      query,
      { workspaces, limit: MEMORY_HITS, includeLocalOnly: local },
      deps.embedder,
    );
    if (hits.length === 0) return "";
    return `Relevant memory (may be outdated):\n${hits.map((h) => `- [${h.workspace}/${h.kind}] ${h.content}`).join("\n")}\n\n`;
  };

  // AGENT.md: the agent's scope and way of working (prompt.md on installs from before it).
  const agentPrompt = (m: Manifest) => {
    for (const file of ["AGENT.md", "prompt.md"]) {
      const path = join(agentsDir, m.id, file);
      if (existsSync(path)) return readFileSync(path, "utf8");
    }
    return undefined;
  };
  /** "- id: name (role, workspace x): scope" lines for whoever routes work to these agents. */
  const teamLine = (m: Manifest) => {
    const scope = agentSummary(agentPrompt(m) ?? "");
    return `- ${m.id}: ${m.name} (${m.role}, workspace ${m.workspace})${scope ? `: ${scope}` : ""}`;
  };

  /**
   * The model a run uses. Local-only work takes the default if it is local, otherwise the first
   * local model the manifest allows; with none, the run is refused (ADR-0007, no fallback).
   */
  const pickModel = (m: Manifest, sensitivity: Sensitivity): string => {
    if (sensitivity === "normal") return m.models.default;
    const local = [m.models.default, ...m.models.allowed].find(isLocalModel);
    if (!local) {
      throw new Error(
        `this work is local-only, but ${m.id} has no local model allowed (add e.g. local/qwen3:8b to models.allowed in agents/${m.id}/agent.yaml)`,
      );
    }
    return local;
  };

  /** Policy → run request. Throws with a reason if the manifest does not allow the run. */
  const toRequest = (
    m: Manifest,
    prompt: string,
    timeoutMs: number,
    sensitivity: Sensitivity = "normal",
  ) => {
    const model = pickModel(m, sensitivity);
    // Second, independent guard: the policy engine checks the same sensitivity.
    const decision = checkModel(m, model, { dataSensitivity: sensitivity });
    if (!decision.allowed) throw new Error(decision.reason);
    const slash = model.indexOf("/");
    const provider = deps.providers[model.slice(0, slash)];
    if (!provider) throw new Error(`no provider for ${model}`);

    const roots = [...m.fs.write, ...m.fs.read].map(expandHome);
    const cwd = roots[0] ?? join(agentsDir, m.id, "work");
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    // Bash is available only through allow-listed command prefixes; anything else is denied
    // in print mode (interactive approvals come with the channels).
    const allowedTools = [
      ...m.tools.filter((t) => t !== "Bash"),
      ...(m.tools.includes("Bash") ? (m.shell?.allow ?? []).map((c) => `Bash(${c}:*)`) : []),
    ];
    const system = agentPrompt(m);
    const req: RunRequest = {
      prompt,
      model: model.slice(slash + 1),
      cwd,
      tools: m.tools,
      allowedTools,
      timeoutMs,
      ...(roots.length > 1 ? { addDirs: roots.slice(1) } : {}),
      ...(system ? { appendSystemPrompt: system } : {}),
      ...(m.budget.per_run_usd ? { maxBudgetUsd: m.budget.per_run_usd } : {}),
    };
    return { provider, req };
  };

  /** Pure policy check for one delegation step; returns the refusal reason, if any. */
  const refuse = (
    caller: Manifest,
    target: Manifest | undefined,
    parent: Task | undefined,
    targetId: string,
  ): string | undefined => {
    if (parent?.workerSpec) return WORKER_REFUSAL;
    if (!target) return `no agent ${targetId}`;
    if (target.id === BOSS_ID) return "the boss cannot be delegated to";
    if (target.id === caller.id) return `cycle: ${caller.id} cannot delegate to itself`;
    const chain = [...(parent?.agentChain ?? []), caller.id];
    if (chain.includes(target.id))
      return `cycle: ${target.id} is already in the chain ${chain.join(" → ")}`;
    const isBoss = caller.id === BOSS_ID;
    if (!isBoss && !caller.delegation.can_delegate_to.includes(target.id)) {
      return `${caller.id} may not delegate to ${target.id} (delegation.can_delegate_to)`;
    }
    if (!isBoss && !target.delegation.accepts_from.includes(caller.id)) {
      return `${target.id} does not accept delegations from ${caller.id} (delegation.accepts_from)`;
    }
    const depth = (parent?.depth ?? 0) + 1;
    if (depth > MAX_DELEGATION_DEPTH) {
      return `depth limit: ${depth} > ${MAX_DELEGATION_DEPTH} (${[...chain, target.id].join(" → ")})`;
    }
    if (
      parent &&
      // Workers and discussion turns have their own limits.
      listChildren(db, parent.id).filter((c) => !c.workerSpec && !c.roomId).length >=
        MAX_CHILDREN_PER_TASK
    ) {
      return `fan-out limit: a task may delegate at most ${MAX_CHILDREN_PER_TASK} times`;
    }
    if (parent && remainingBudget(db, parent.rootId ?? parent.id) <= 0) {
      return "the delegation chain has used up its budget";
    }
    return undefined;
  };

  // Kanban workflow (ADR-0030): one workflow.yaml per workspace, seeded once, never overwritten.
  const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
  const workflowFor = (workspace: string): Workflow =>
    loadWorkflow(SAFE_NAME.test(workspace) ? join(home, "workflows", `${workspace}.yaml`) : "");
  // Projects (ADR-0031): re-read on use, like manifests.
  const projects = () => loadProjects(join(home, "projects"));
  /** The workflow for a card: the project's own workflow.yaml if it has one. */
  const workflowForTask = (task: Task): Workflow => {
    const project = task.project ? projects().get(task.project) : undefined;
    if (project && existsSync(project.workflowPath)) return loadWorkflow(project.workflowPath);
    return workflowFor(workspaceOf(task));
  };
  const projectSpace = (p: Project) => `${p.workspace}/${p.slug}`;
  /**
   * The only way a project widens a run: an agent of the project's workspace works in its
   * files/ folder (cwd and write root). Agents of other workspaces get the text, not the folder.
   */
  const withProject = (m: Manifest, p: Project | undefined): Manifest =>
    p && m.workspace === p.workspace
      ? {
          ...m,
          fs: { ...m.fs, write: [p.filesDir, ...m.fs.write.filter((w) => w !== p.filesDir)] },
        }
      : m;
  const projectBlock = (p: Project) =>
    `Project: ${p.name} (${p.slug}, workspace ${p.workspace})\n${p.doc.trim()}\n\n`;
  const workspaceOf = (task: Task) =>
    (task.assigneeAgentId ? agents().get(task.assigneeAgentId)?.workspace : undefined) ?? "shared";
  const pendingKey = (taskId: string) => `pending_move:${taskId}`;

  /** on_enter automation; `byOwner` skips nothing here (approval is checked before moving). */
  const enterColumn = (task: Task, column: string, wf: Workflow) => {
    const assign = wf.on_enter[column]?.assign;
    if (!assign?.startsWith("role:")) return;
    const role = assign.slice(5);
    const workspace = workspaceOf(task);
    const reviewer = [...agents().values()]
      .filter(
        (m) => m.workspace === workspace && m.roles.includes(role) && m.id !== task.assigneeAgentId,
      )
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    // Nobody with that role: the card waits for the owner.
    if (!reviewer) return;
    const targets = wf.transitions
      .filter((tr) => tr.from === column && tr.by === assign)
      .map((tr) => tr.to);
    const root = getTask(db, task.id) as Task;
    enqueueChild(db, root, {
      title: `${column}: ${task.title}`,
      description: [
        `Card ${task.id} ("${task.title}", by ${task.assigneeAgentId ?? "?"}) is in "${column}" and assigned to you as ${role}.`,
        `Original instructions:\n${task.description ?? ""}`,
        `Result of the work:\n${root.result ?? "(none yet)"}`,
        `When you have decided, move the card with move_task (task_id "${task.id}") to one of: ${targets.join(", ") || "(no column allowed for your role)"}, and say why.`,
      ].join("\n\n"),
      assigneeAgentId: reviewer.id,
      caller: "workflow",
    });
  };

  /** Applies a checked agent/system move, or parks it for owner approval (on_enter approve). */
  const requestMove = (
    task: Task,
    from: string,
    to: string,
    actor: string,
    wf: Workflow,
  ): { ok: true; pending?: true } | { ok: false; reason: string } => {
    if (wf.on_enter[to]?.approve === "owner") {
      setSetting(db, pendingKey(task.id), JSON.stringify({ from, to, actor }));
      if (task.threadId) {
        appendMessage(db, {
          threadId: task.threadId,
          role: "agent",
          author: BOSS_ID,
          channel: "system",
          content: t("thread.moveRequest", { actor, title: task.title, from, to }),
          actions: [
            { label: t("action.approve"), data: `move:approve:${task.id}` },
            { label: t("action.reject"), data: `move:reject:${task.id}` },
          ],
        });
      }
      return { ok: true, pending: true };
    }
    if (!moveCard(db, { taskId: task.id, from, to, actor })) {
      return { ok: false, reason: "the card was moved meanwhile" };
    }
    enterColumn(task, to, wf);
    return { ok: true };
  };

  /** A successful run lands in `finish` unless the agent already moved the card. */
  const finishCard = (task: Task) => {
    const cur = getTask(db, task.id);
    if (!cur?.column || !cur.assigneeAgentId) return;
    const wf = workflowForTask(cur);
    if (cur.column !== wf.start) return;
    const roles = agents().get(cur.assigneeAgentId)?.roles ?? [];
    const check = checkMove(wf, { assignee: cur.assigneeAgentId, column: cur.column }, wf.finish, {
      kind: "agent",
      id: cur.assigneeAgentId,
      roles,
    });
    if (check.ok) requestMove(cur, cur.column, wf.finish, "system", wf);
  };

  /** One discussion turn as a child of the opener's task (the opener waits for it). */
  const enqueueTurn = (opener: Task, room: Room, turn: { agentId: string; round: number }) =>
    enqueueChild(db, opener, {
      title: `Discussion: ${room.topic} (round ${turn.round})`,
      assigneeAgentId: turn.agentId,
      caller: room.openerAgentId,
      roomId: room.id,
    });

  const orchestrator: Orchestrator = {
    openRoom(from, request) {
      const all = agents();
      const parent = getTask(db, from.taskId);
      const caller = parent?.assigneeAgentId ? all.get(parent.assigneeAgentId) : undefined;
      if (!parent || !caller) return { ok: false, reason: "unknown calling task" };
      if (parent.workerSpec) return { ok: false, reason: WORKER_REFUSAL };
      if (parent.roomId)
        return { ok: false, reason: "a discussion turn cannot open another discussion" };
      const ps = request.participants;
      if (ps.length < 1 || ps.length > MAX_ROOM_PARTICIPANTS || new Set(ps).size !== ps.length) {
        return { ok: false, reason: `1 to ${MAX_ROOM_PARTICIPANTS} different participants` };
      }
      if (
        !Number.isInteger(request.rounds) ||
        request.rounds < 1 ||
        request.rounds > MAX_ROOM_ROUNDS
      ) {
        return { ok: false, reason: `rounds must be 1 to ${MAX_ROOM_ROUNDS}` };
      }
      // Same rules as delegating to each participant (both sides must allow it).
      for (const id of ps) {
        const reason = refuse(caller, all.get(id), parent, id);
        if (reason) return { ok: false, reason };
      }
      const room = createRoom(db, {
        openerTaskId: parent.id,
        openerAgentId: caller.id,
        topic: request.topic,
        question: request.question,
        participants: ps,
        rounds: request.rounds,
      });
      enqueueTurn(parent, room, nextTurn(room) as { agentId: string; round: number });
      return { ok: true, roomId: room.id };
    },

    syncAgents: () => {
      const all = agents();
      const dir = join(home, "workflows");
      mkdirSync(dir, { recursive: true });
      for (const ws of new Set([...all.values()].map((m) => m.workspace))) {
        const path = join(dir, `${ws}.yaml`);
        if (SAFE_NAME.test(ws) && !existsSync(path)) writeFileSync(path, DEFAULT_WORKFLOW_YAML);
      }
      return [...all.keys()];
    },

    workflow(workspace) {
      const workflow = workflowFor(workspace);
      return { workflow, matrix: permissionMatrix(workflow) };
    },

    moveTask(from, request) {
      const caller = getTask(db, from.taskId);
      const manifest = caller?.assigneeAgentId ? agents().get(caller.assigneeAgentId) : undefined;
      if (!caller || !manifest || caller.workerSpec)
        return { ok: false, reason: "unknown calling task" };
      const target = getTask(db, request.taskId);
      if (!target?.column) return { ok: false, reason: "no such card" };
      const workspace = workspaceOf(target);
      if (workspace !== manifest.workspace)
        return { ok: false, reason: "card is in another workspace" };
      const wf = workflowForTask(target);
      const check = checkMove(
        wf,
        { assignee: target.assigneeAgentId, column: target.column },
        request.to,
        {
          kind: "agent",
          id: manifest.id,
          roles: manifest.roles,
        },
      );
      if (!check.ok) return check;
      return requestMove(target, target.column, request.to, `agent:${manifest.id}`, wf);
    },

    ownerMove(taskId, from, to) {
      const target = getTask(db, taskId);
      if (!target?.column) return { ok: false, reason: "no such card" };
      if (target.column !== from) return { ok: false, reason: "the card was moved meanwhile" };
      const wf = workflowForTask(target);
      const check = checkMove(wf, { assignee: target.assigneeAgentId, column: from }, to, {
        kind: "owner",
      });
      if (!check.ok) return check;
      if (!moveCard(db, { taskId, from, to, actor: "owner", override: check.override })) {
        return { ok: false, reason: "the card was moved meanwhile" };
      }
      // The owner decided; a parked agent move for this card is obsolete.
      setSetting(db, pendingKey(taskId), "");
      clearActions(db, "move:", taskId);
      enterColumn(target, to, wf);
      return { ok: true, override: check.override };
    },

    runAction(data) {
      const proposal = /^proposal:(approve|reject):([\w-]{1,36})$/.exec(data);
      if (proposal) {
        const approve = proposal[1] === "approve";
        const out = orchestrator.decideProposal(proposal[2] as string, approve);
        return out.ok
          ? {
              ok: true,
              message: t(approve ? "action.approved" : "action.rejected", { agent: out.agentId }),
            }
          : { ok: false, message: out.reason };
      }
      const move = /^move:(approve|reject):([\w-]{1,36})$/.exec(data);
      if (!move) return { ok: false, message: t("action.unknown") };
      const taskId = move[2] as string;
      const raw = getSetting(db, pendingKey(taskId));
      const task = getTask(db, taskId);
      if (!raw || !task) return { ok: false, message: t("action.noPendingMove") };
      const p = JSON.parse(raw) as { from: string; to: string; actor: string };
      setSetting(db, pendingKey(taskId), "");
      clearActions(db, "move:", taskId);
      const vars = { title: task.title, from: p.from, to: p.to };
      if (move[1] === "reject") return { ok: true, message: t("action.moveRejected", vars) };
      if (!moveCard(db, { taskId, from: p.from, to: p.to, actor: p.actor })) {
        return { ok: false, message: "the card was moved meanwhile" };
      }
      enterColumn(task, p.to, workflowForTask(task));
      return { ok: true, message: t("action.moveApproved", vars) };
    },

    spawnWorker(from, request) {
      const parent = getTask(db, from.taskId);
      const found = parent?.assigneeAgentId ? agents().get(parent.assigneeAgentId) : undefined;
      if (!parent || !found) return { ok: false, reason: "unknown calling task" };
      if (parent.workerSpec) return { ok: false, reason: WORKER_REFUSAL };
      // A project task's caller may hand its project folder to a worker.
      const caller = withProject(
        found,
        parent.project ? projects().get(parent.project) : undefined,
      );
      const extraTool = request.tools.find((t) => !caller.tools.includes(t));
      if (extraTool) {
        return { ok: false, reason: `tool ${extraTool} is not among ${caller.id}'s own tools` };
      }
      const outside = request.paths.find((p) => !checkFs(caller, p, "write").allowed);
      if (outside) {
        return { ok: false, reason: `path ${outside} is outside ${caller.id}'s own write paths` };
      }
      const workers = listChildren(db, parent.id).filter((c) => c.workerSpec).length;
      if (workers >= MAX_WORKERS_PER_TASK) {
        return { ok: false, reason: `at most ${MAX_WORKERS_PER_TASK} workers per task` };
      }
      if (remainingBudget(db, parent.rootId ?? parent.id) <= 0) {
        return { ok: false, reason: "the delegation chain has used up its budget" };
      }
      const child = enqueueChild(db, parent, {
        title: `worker: ${request.instructions.slice(0, 60)}`,
        description: request.instructions,
        assigneeAgentId: caller.id,
        caller: caller.id,
        workerSpec: { tools: [...request.tools], paths: [...request.paths] },
      });
      return { ok: true, taskId: child.id };
    },

    proposeAgent(from, request) {
      const task = getTask(db, from.taskId);
      if (!task?.assigneeAgentId) return { ok: false, reason: "unknown calling task" };
      if (task.workerSpec) return { ok: false, reason: WORKER_REFUSAL };
      let m: Manifest;
      try {
        m = parseManifest(request.yaml, "proposed agent.yaml");
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
      if (agents().has(m.id) || existsSync(join(agentsDir, m.id))) {
        return { ok: false, reason: `agent ${m.id} already exists` };
      }
      const id = randomBytes(4).toString("hex");
      db.prepare(
        `INSERT INTO agent_proposals (id, proposed_by, task_id, thread_id, agent_id, yaml, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        task.assigneeAgentId,
        task.id,
        task.threadId,
        m.id,
        request.yaml,
        request.reason,
        Date.now(),
      );
      if (task.threadId) {
        // Everything the new agent would be allowed to do, so the owner decides on the facts.
        const summary = [
          `models: ${m.models.allowed.join(", ")}`,
          `tools: ${m.tools.join(", ") || "none"}`,
          `fs write: ${m.fs.write.join(", ") || "none"}; read: ${m.fs.read.join(", ") || "none"}`,
          `shell: ${m.shell?.allow.join(", ") ?? "none"}`,
          `network: ${m.network.allow.join(", ") || "none"}`,
          `delegation: to ${m.delegation.can_delegate_to.join(", ") || "none"}, from ${m.delegation.accepts_from.join(", ") || "none"}`,
          `budget: ${JSON.stringify(m.budget)}`,
        ].join("\n");
        appendMessage(db, {
          threadId: task.threadId,
          role: "agent",
          author: task.assigneeAgentId,
          channel: "system",
          content: redact(
            t("thread.proposal", {
              agent: task.assigneeAgentId,
              id: m.id,
              role: m.role,
              reason: request.reason,
              summary,
              pid: id,
            }),
          ).slice(0, MAX_POST),
          actions: [
            { label: t("action.approve"), data: `proposal:approve:${id}` },
            { label: t("action.reject"), data: `proposal:reject:${id}` },
          ],
        });
      }
      return { ok: true, proposalId: id };
    },

    decideProposal(id, approve) {
      const row = db
        .prepare("SELECT agent_id, yaml FROM agent_proposals WHERE id = ? AND status = 'pending'")
        .get(id);
      if (!row) return { ok: false, reason: `no pending proposal ${id}` };
      const agentId = String(row.agent_id);
      if (approve) {
        try {
          parseManifest(String(row.yaml), "proposed agent.yaml"); // still valid?
          mkdirSync(join(agentsDir, agentId), { recursive: false, mode: 0o700 });
          writeFileSync(join(agentsDir, agentId, "agent.yaml"), String(row.yaml), { flag: "wx" });
        } catch (err) {
          return { ok: false, reason: (err as Error).message };
        }
      }
      db.prepare("UPDATE agent_proposals SET status = ?, decided_at = ? WHERE id = ?").run(
        approve ? "approved" : "rejected",
        Date.now(),
        id,
      );
      clearActions(db, "proposal:", id);
      if (approve) agents(); // mirror the new agent into the DB
      return { ok: true, agentId };
    },

    askOwner(from, question) {
      const task = getTask(db, from.taskId);
      if (!task?.threadId || !task.assigneeAgentId) {
        return { ok: false, reason: "this task has no conversation with the owner" };
      }
      askOwnerQuestion(db, task.id, question);
      appendMessage(db, {
        threadId: task.threadId,
        role: "agent",
        author: task.assigneeAgentId,
        channel: "system",
        content: redact(
          t("thread.question", { agent: task.assigneeAgentId, title: task.title, question }),
        ).slice(0, MAX_POST),
      });
      return { ok: true };
    },

    delegate(from, request, opts = {}) {
      const all = agents();
      const target = all.get(request.agent);
      if (from.from === "boss") {
        const boss = all.get(BOSS_ID);
        if (!boss) return { ok: false, reason: "boss agent is not configured" };
        const reason = refuse(boss, target, undefined, request.agent);
        if (reason || !target) return { ok: false, reason: reason ?? "no target" };
        const budget = opts.budgetUsd ?? target.budget.per_run_usd;
        const t = enqueueRoot(db, {
          caller: BOSS_ID,
          title: request.title,
          description: request.instructions,
          threadId: from.threadId,
          assigneeAgentId: target.id,
          // Children of local-only work stay local-only (ADR-0007).
          sensitivity: getThread(db, from.threadId)?.sensitivity ?? "normal",
          ...(budget !== undefined ? { budgetUsd: budget } : {}),
          ...(getThread(db, from.threadId)?.project
            ? { project: getThread(db, from.threadId)?.project as string }
            : {}),
        });
        placeCard(db, t.id, workflowForTask(t).start, "system");
        return { ok: true, taskId: t.id };
      }
      const parent = getTask(db, from.taskId);
      const caller = parent?.assigneeAgentId ? all.get(parent.assigneeAgentId) : undefined;
      if (!parent || !caller) return { ok: false, reason: "unknown calling task" };
      const reason = refuse(caller, target, parent, request.agent);
      if (reason || !target) return { ok: false, reason: reason ?? "no target" };
      // Only these fields cross over: the target runs with its own manifest (no escalation).
      const child = enqueueChild(db, parent, {
        title: request.title,
        description: request.instructions,
        assigneeAgentId: target.id,
        caller: caller.id,
      });
      return { ok: true, taskId: child.id };
    },

    async handleMessage(threadId, text, channel) {
      appendMessage(db, { threadId, role: "user", channel, content: text });
      // An open question from an agent in this thread takes the owner's reply (not the boss).
      if (answerOwnerQuestion(db, threadId, text)) return "routed";
      try {
        const all = agents();
        const boss = all.get(BOSS_ID);
        if (!boss) throw new Error("boss agent is not configured");
        const sensitivity = getThread(db, threadId)?.sensitivity ?? "normal";
        const bossModel = pickModel(boss, sensitivity);
        const team = [...all.values()]
          .filter((m) => m.id !== BOSS_ID)
          .map(teamLine)
          .join("\n");
        const history = listMessages(db, threadId)
          .slice(-HISTORY)
          .map((m) => `${m.role === "user" ? "owner" : (m.author ?? m.role)}: ${m.content}`)
          .join("\n");
        // The boss works for the owner across all business branches.
        const workspaces = [...new Set([...all.values()].map((m) => m.workspace))];
        const threadProject = getThread(db, threadId)?.project;
        const project = threadProject ? projects().get(threadProject) : undefined;
        if (threadProject && !project) throw new Error(`unknown project ${threadProject}`);
        const memories = await recall(
          text,
          [...workspaces, ...(project ? [projectSpace(project)] : [])],
          isLocalModel(bossModel),
        );
        const prompt = `${memories}${project ? projectBlock(project) : ""}Agents you can delegate to:\n${team || "(none)"}\n\nConversation so far (latest last):\n${history}\n\nDecide what to do with the owner's latest message.`;

        const { provider, req } = toRequest(boss, prompt, BOSS_TIMEOUT_MS, sensitivity);
        // Structured output is an internal tool call, so allow a few turns.
        const res = await provider.run({ ...req, jsonSchema: DECISION_JSON_SCHEMA, maxTurns: 4 });
        if (res.stopReason === "unavailable") {
          throw new Error("the local model is not available right now (is Ollama running?)");
        }
        if (!res.ok) throw new Error(res.error ?? "boss run failed");
        const decision = decisionSchema.parse(res.structured);

        if (decision.action === "delegate") {
          const task = decision.task;
          if (!task || task.assignee === BOSS_ID || !all.has(task.assignee)) {
            throw new Error(`unknown agent ${task?.assignee ?? "(none)"}`);
          }
          const r = orchestrator.delegate(
            { from: "boss", threadId },
            {
              agent: task.assignee,
              title: task.title,
              // The sub-agent never sees the conversation, so the reply language travels with it.
              instructions: `${task.description}\n\nWrite your final report for the owner in ${task.language}.`,
            },
          );
          if (!r.ok) throw new Error(r.reason);
        }
        post(threadId, decision.message);
        return decision.action;
      } catch (err) {
        post(threadId, t("thread.bossError", { reason: (err as Error).message }));
        return "error";
      }
    },

    async workOnce(signal) {
      if (isPaused(db)) return false;
      const task = claim(db, { workerId: WORKER_ID, leaseMs: LEASE_MS });
      if (!task) return false;
      await runTask(task, signal);
      return true;
    },
  };
  return orchestrator;

  async function runTask(task: Task, signal?: AbortSignal) {
    const rootId = task.rootId ?? task.id;
    // Quiet output (ADR-0029): only root tasks talk to the owner; children report to their parent.
    const report = (finalFailure: boolean, text: string) => {
      if (!finalFailure) return;
      // A failed turn ends the discussion; the opener resumes with what was said.
      if (task.roomId) closeRoom(db, task.roomId);
      if (task.parentId) childFinished(db, task.id);
      else if (task.threadId) post(task.threadId, text);
    };
    const failFinal = (msg: string) => {
      db.prepare("UPDATE tasks SET max_attempts = attempts WHERE id = ?").run(task.id);
      fail(db, task.id, WORKER_ID, msg);
      report(true, t("thread.failed", { title: task.title, error: msg }));
    };
    const remaining = remainingBudget(db, rootId);
    if (remaining <= 0) {
      failFinal("the delegation chain has used up its budget");
      return;
    }
    let built: ReturnType<typeof toRequest>;
    let manifest: Manifest | undefined;
    let project: Project | undefined;
    let delegates: Manifest[] = [];
    try {
      const all = agents();
      manifest = task.assigneeAgentId ? all.get(task.assigneeAgentId) : undefined;
      if (!manifest) throw new Error(`no agent ${task.assigneeAgentId ?? "(unassigned)"}`);
      project = task.project ? projects().get(task.project) : undefined;
      if (task.project && !project) throw new Error(`unknown project ${task.project}`);
      manifest = withProject(manifest, project);
      if (task.roomId) {
        const { shell: _shell, ...rest } = manifest;
        manifest = {
          ...rest,
          tools: manifest.tools.filter((tool) => READ_ONLY_TOOLS.includes(tool)),
          fs: { read: [...manifest.fs.read, ...manifest.fs.write], write: [] },
          delegation: { can_delegate_to: [], accepts_from: [] },
        };
      }
      if (task.workerSpec) {
        // Ephemeral worker: the caller's agent, cut down to the granted subset; no delegation.
        const { tools, paths } = task.workerSpec;
        const { shell: _shell, ...rest } = manifest;
        manifest = {
          ...rest,
          tools,
          fs: { read: [], write: paths },
          delegation: { can_delegate_to: [], accepts_from: [] },
          ...(tools.includes("Bash") && manifest.shell ? { shell: manifest.shell } : {}),
        };
      }
      delegates = manifest.delegation.can_delegate_to
        .map((id) => all.get(id))
        .filter((m): m is Manifest => m !== undefined);
      // Sub-agents only see their own workspace plus shared knowledge (ADR-0009).
      const local = isLocalModel(pickModel(manifest, task.sensitivity));
      const memories = await recall(
        `${task.title} ${task.description ?? ""}`,
        [manifest.workspace, "shared", ...(project ? [projectSpace(project)] : [])],
        local,
      );
      // Continuation after delegating: the children's results are part of the prompt.
      const children = listChildren(db, task.id).filter((c) => !c.roomId);
      const transcript = (roomId: string) =>
        listMessages(db, roomId)
          .map((msg) => `${msg.author ?? "?"}: ${msg.content}`)
          .join("\n");
      const discussions = roomsOf(db, task.id)
        .map(
          (r) =>
            `\n\nDiscussion "${r.topic}" with ${r.participants.join(", ")}:\n${transcript(r.id)}\nWrite the decision and finish the task.`,
        )
        .join("");
      const results = children.length
        ? `\n\nResults from delegated tasks:\n${children
            .map(
              (c) =>
                `- ${c.title} (${c.assigneeAgentId}, ${c.status}): ${c.result ?? c.error ?? ""}`,
            )
            .join("\n")}\nUse these results and finish the task.`
        : "";
      const answer =
        task.ownerQuestion && task.ownerAnswer
          ? `\n\nYou asked the owner: ${task.ownerQuestion}\nOwner's answer: ${task.ownerAnswer}\nContinue the task with this answer.`
          : "";
      const team =
        delegates.length && deps.hub
          ? `\n\nYou can delegate to:\n${delegates.map(teamLine).join("\n")}\nUse the delegate tool only for work outside your own role.`
          : "";
      const room = task.roomId ? getRoom(db, task.roomId) : undefined;
      const turn = nextTurn(room);
      const prompt =
        room && turn
          ? `${memories}${project ? projectBlock(project) : ""}# Discussion: ${room.topic}\n\nOpened by ${room.openerAgentId}. Round ${turn.round} of ${room.rounds}; you are ${manifest.id}.\n\nTranscript so far:\n${transcript(room.id)}\n\nGive your view in a few sentences. Build on what the others said and disagree when you have a reason; do not repeat the transcript.`
          : `${memories}${project ? projectBlock(project) : ""}# Task: ${task.title}\n\n${task.description ?? ""}${team}${results}${discussions}${answer}`.trim();
      if (task.roomId && !turn) throw new Error("the discussion has ended");
      built = toRequest(manifest, prompt, RUN_TIMEOUT_MS, task.sensitivity);
      // One shared budget per chain: never more than what is left.
      if (Number.isFinite(remaining)) {
        built.req.maxBudgetUsd = Math.min(built.req.maxBudgetUsd ?? remaining, remaining);
      }
    } catch (err) {
      // Policy or configuration problems will not fix themselves: fail without retrying.
      failFinal((err as Error).message);
      return;
    }

    // Hub tools only for agents that may delegate: a private config file for this run only.
    let hubRun: { file: string; revoke: () => void } | undefined;
    // Every run may ask the owner; only agents allowed to delegate get `delegate` too.
    // Workers (depth 1) get no hub tools at all.
    if (deps.hub && !task.workerSpec && !task.roomId) {
      const hubTools = [
        "ask_owner",
        "propose_agent",
        "move_task",
        ...(delegates.length ? ["delegate", "open_room"] : []),
        ...(manifest.tools.length ? ["spawn_worker"] : []),
      ];
      const { token, revoke } = deps.hub.tokens.issue(task.id, manifest.id, hubTools);
      const runDir = join(home, "run");
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const file = join(runDir, `mcp-${randomUUID()}.json`);
      const config = {
        mcpServers: {
          achords: {
            command: process.execPath,
            args: ["--disable-warning=ExperimentalWarning", deps.hub.serverEntry],
            env: {
              ACHORDS_HUB_URL: deps.hub.url,
              ACHORDS_RUN_TOKEN: token,
              ACHORDS_TOOLS: hubTools.join(","),
            },
          },
        },
      };
      writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
      built.req.mcpConfigPath = file;
      built.req.allowedTools = [
        ...built.req.allowedTools,
        ...hubTools.map((t) => `mcp__achords__${t}`),
      ];
      hubRun = { file, revoke };
    }

    // Live progress (step 5b): the agent keeps its own checklist; discussion turns are too short.
    if (!task.roomId) {
      built.req.tools = [...built.req.tools, "TodoWrite"];
      built.req.allowedTools = [...built.req.allowedTools, "TodoWrite"];
      built.req.appendSystemPrompt =
        `${built.req.appendSystemPrompt ?? ""}\n\n${PROGRESS_HINT}`.trim();
    }
    const run = startRun(db, {
      provider: built.provider.id,
      model: built.req.model,
      taskId: task.id,
      agentId: manifest.id,
    });
    const keepAlive = setInterval(
      () => extendLease(db, task.id, WORKER_ID, LEASE_MS),
      LEASE_MS / 3,
    );
    try {
      const res = await built.provider.run({
        ...built.req,
        ...(signal ? { signal } : {}),
        onSpawn: (pid) => setRunPid(db, run.id, pid),
        onProgress: (p) => setRunProgress(db, run.id, p),
      });
      finishRun(
        db,
        run.id,
        res.ok ? "succeeded" : res.stopReason === "cancelled" ? "cancelled" : "failed",
        {
          ...(res.error ? { error: res.error } : {}),
        },
      );
      addSpend(db, rootId, res.usage.costUsd ?? 0);
      if (res.stopReason === "unavailable") {
        // Fail-closed: wait for the backend (e.g. local model server), never fall back.
        defer(db, task.id, WORKER_ID, `waiting for the local model: ${res.error ?? ""}`, DEFER_MS);
      } else if (
        res.ok &&
        ((getTask(db, task.id)?.waitingChildren ?? 0) > 0 || getTask(db, task.id)?.waitingOwner)
      ) {
        // It delegated or asked the owner during this run: resume when that is answered.
        waitForChildren(db, task.id, WORKER_ID);
      } else if (res.ok && task.roomId) {
        // A discussion turn: record it, hand the word to the next speaker, else back to the opener.
        complete(db, task.id, WORKER_ID, res.text);
        recordTurn(db, task.roomId, manifest.id, redact(res.text).slice(0, MAX_POST));
        const room = getRoom(db, task.roomId);
        const next = nextTurn(room);
        const opener = task.parentId ? getTask(db, task.parentId) : undefined;
        if (room && next && opener) enqueueTurn(opener, room, next);
        childFinished(db, task.id);
      } else if (res.ok) {
        complete(db, task.id, WORKER_ID, res.text);
        // The opener's result is the decision of the discussions it opened.
        for (const r of openRoomsOf(db, task.id))
          closeRoom(db, r.id, redact(res.text).slice(0, MAX_POST));
        await deps.memory
          ?.add(
            {
              workspace: project ? projectSpace(project) : manifest.workspace,
              kind: "summary",
              content: redact(`Task "${task.title}" (${manifest.id}): ${res.text}`).slice(
                0,
                SUMMARY_CHARS,
              ),
              source: task.id,
              localOnly: task.sensitivity === "local-only",
            },
            deps.embedder,
          )
          .catch(() => {}); // memory is best effort; the task result is already safe
        if (task.parentId) childFinished(db, task.id);
        else {
          finishCard(task);
          if (task.threadId)
            post(task.threadId, t("thread.done", { title: task.title, result: res.text }));
        }
      } else {
        fail(db, task.id, WORKER_ID, res.error ?? res.stopReason);
        report(
          getTask(db, task.id)?.status === "failed",
          t("thread.failed", { title: task.title, error: res.error ?? res.stopReason }),
        );
      }
    } finally {
      clearInterval(keepAlive);
      hubRun?.revoke();
      if (hubRun) rmSync(hubRun.file, { force: true });
    }
  }
}
