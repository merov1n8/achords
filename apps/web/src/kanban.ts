import { t } from "./i18n.ts";
import type { Task } from "./types.ts";

export type Rule = { from: string; by: string; not?: string };
export type Matrix = { to: string; rules: Rule[] }[];
export interface BoardColumn {
  id: string;
  cards: { task: Task; children: number }[];
}

/** Cards the predicate keeps (e.g. one workspace's) in workflow column order. */
export function boardColumns(
  columns: string[],
  tasks: Task[],
  shows: (task: Task) => boolean,
): BoardColumn[] {
  const children = new Map<string, number>();
  for (const task of tasks) {
    if (task.parentId) children.set(task.parentId, (children.get(task.parentId) ?? 0) + 1);
  }
  const cards = tasks.filter((task) => task.column && shows(task));
  return columns.map((id) => ({
    id,
    cards: cards
      .filter((task) => task.column === id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((task) => ({ task, children: children.get(task.id) ?? 0 })),
  }));
}

/**
 * The workspace a card belongs to, as the gateway decides its workflow: the assignee's; a card
 * made by hand without an agent goes by its project, else "shared". Undefined for an agent that
 * no longer exists.
 */
export function cardWorkspace(
  task: Pick<Task, "assigneeAgentId" | "project">,
  agentWorkspaces: Map<string, string>,
  projectWorkspaces: Map<string, string>,
): string | undefined {
  if (task.assigneeAgentId) return agentWorkspaces.get(task.assigneeAgentId);
  return projectWorkspaces.get(task.project ?? "") ?? "shared";
}

/** For the owner every drop is possible; one that no owner rule grants is an override (logged). */
export function dropKind(
  matrix: Matrix,
  from: string,
  to: string,
): "same" | "allowed" | "override" {
  if (from === to) return "same";
  const rules = matrix.find((r) => r.to === to)?.rules ?? [];
  return rules.some((r) => r.from === from && r.by === "owner") ? "allowed" : "override";
}

export function columnLabel(id: string): string {
  const key = `kanban.col.${id}`;
  const label = t(key);
  if (label !== key) return label;
  const words = id.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Compact age for cards and lists ("card aging"). */
export function ago(then: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return t("time.justNow");
  if (s < 3600) return t("time.minutes", { n: Math.floor(s / 60) });
  if (s < 86400) return t("time.hours", { n: Math.floor(s / 3600) });
  return t("time.days", { n: Math.floor(s / 86400) });
}

/** Columns for the "All" board: every workspace's columns once; a new one goes before the next known one. */
export function unionColumns(lists: string[][]): string[] {
  const out: string[] = [];
  for (const list of lists) {
    list.forEach((col, i) => {
      if (out.includes(col)) return;
      const next = list.slice(i + 1).find((c) => out.includes(c));
      if (next === undefined) out.push(col);
      else out.splice(out.indexOf(next), 0, col);
    });
  }
  return out;
}
