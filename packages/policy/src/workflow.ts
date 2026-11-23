import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ADR-0030: the kanban as a permissioned state machine. Process rules live here, capabilities
// stay in agent.yaml; agents are matched by their `roles`.

const COLUMN = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, "lowercase letters, digits, _");
const BY = z
  .string()
  .regex(/^(owner|assignee|role:[a-z0-9][a-z0-9-]{0,63})$/, "owner, assignee or role:<name>");

export const workflowSchema = z
  .object({
    columns: z.array(COLUMN).min(1),
    /** Where a task appears when it is given to an agent. */
    start: COLUMN,
    /** Where a successful run ends up if the agent did not move the card itself. */
    finish: COLUMN,
    transitions: z.array(
      z
        .object({ from: COLUMN, to: COLUMN, by: BY, not: z.literal("assignee").optional() })
        .strict(),
    ),
    on_enter: z
      .record(
        COLUMN,
        z
          .object({
            assign: BY.optional(),
            approve: z.literal("owner").optional(),
            // ADR-0065: a finished card enters this column only with a passing report_checks.
            needs_checks: z.boolean().optional(),
          })
          .strict(),
      )
      .default({}),
  })
  .strict()
  .superRefine((w, ctx) => {
    const known = new Set(w.columns);
    const check = (col: string, path: (string | number)[]) => {
      if (!known.has(col))
        ctx.addIssue({ code: "custom", path, message: `unknown column "${col}"` });
    };
    check(w.start, ["start"]);
    check(w.finish, ["finish"]);
    w.transitions.forEach((t, i) => {
      check(t.from, ["transitions", i, "from"]);
      check(t.to, ["transitions", i, "to"]);
    });
    for (const col of Object.keys(w.on_enter)) check(col, ["on_enter", col]);
  });

export type Workflow = z.output<typeof workflowSchema>;

export const DEFAULT_WORKFLOW_YAML = `# Kanban workflow for this workspace (ADR-0030). Edit freely; it is never overwritten.
# by: owner | assignee | role:<name> (agents get roles in agent.yaml)
# not: assignee = four-eyes check (the agent that did the work cannot approve it)
columns: [backlog, todo, in_progress, review, done, deployed]
start: in_progress   # a task given to an agent appears here
finish: review       # a successful run lands here unless the agent moved the card itself
transitions:
  - { from: backlog, to: todo, by: owner }
  - { from: todo, to: in_progress, by: assignee }
  - { from: in_progress, to: review, by: assignee }
  - { from: review, to: in_progress, by: role:qa }
  - { from: review, to: done, by: role:qa, not: assignee }
  - { from: done, to: deployed, by: owner }
on_enter:
  review: { assign: role:qa }   # a QA agent gets it; with none, the owner reviews
`;

export function parseWorkflow(text: string, source: string): Workflow {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`${source}: invalid YAML: ${(err as Error).message}`);
  }
  const result = workflowSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`${source}: invalid workflow\n${issues}`);
  }
  return result.data;
}

export function loadWorkflow(path: string): Workflow {
  return existsSync(path)
    ? parseWorkflow(readFileSync(path, "utf8"), path)
    : parseWorkflow(DEFAULT_WORKFLOW_YAML, "default workflow");
}

export type Mover = { kind: "owner" } | { kind: "agent"; id: string; roles: string[] };
export type MoveCheck = { ok: true; override: boolean } | { ok: false; reason: string };

const matches = (by: string, mover: Mover, assignee: string | null) => {
  if (mover.kind === "owner") return by === "owner";
  if (by === "assignee") return mover.id === assignee;
  return by.startsWith("role:") && mover.roles.includes(by.slice(5));
};

/**
 * May `mover` move a card from `task.column` to `to`? Agents only along listed transitions.
 * The owner may always move; a move no rule grants the owner is flagged as an override (logged).
 */
export function checkMove(
  wf: Workflow,
  task: { assignee: string | null; column: string },
  to: string,
  mover: Mover,
): MoveCheck {
  if (!wf.columns.includes(to)) return { ok: false, reason: `unknown column "${to}"` };
  if (task.column === to) return { ok: false, reason: `already in ${to}` };
  const rules = wf.transitions.filter((t) => t.from === task.column && t.to === to);
  const granted = rules.filter((r) => matches(r.by, mover, task.assignee));
  const fourEyes = (r: (typeof rules)[number]) =>
    r.not === "assignee" && mover.kind === "agent" && mover.id === task.assignee;
  if (granted.some((r) => !fourEyes(r))) return { ok: true, override: false };
  if (mover.kind === "owner") return { ok: true, override: true };
  if (granted.length > 0) {
    return {
      ok: false,
      reason: `four-eyes rule: you cannot approve your own work (${task.column} → ${to})`,
    };
  }
  return { ok: false, reason: `not allowed by the workflow: ${task.column} → ${to}` };
}

/** Read-only view for the web: for each column, from where and by whom it may be entered. */
export function permissionMatrix(wf: Workflow) {
  return wf.columns.map((to) => ({
    to,
    rules: wf.transitions
      .filter((t) => t.to === to)
      .map(({ from, by, not }) => ({ from, by, ...(not ? { not } : {}) })),
  }));
}
