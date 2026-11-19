import type { Task } from "./types.ts";

export interface Column {
  title: string;
  tasks: Task[];
}

const COLUMNS: [string, Task["status"][]][] = [
  ["To do", ["queued"]],
  ["In progress", ["claimed"]],
  ["Done", ["done"]],
  ["Failed", ["failed", "cancelled"]],
];

export function groupTasks(tasks: Task[]): Column[] {
  return COLUMNS.map(([title, statuses]) => ({
    title,
    tasks: tasks
      .filter((t) => statuses.includes(t.status))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  }));
}

/** Compact age for cards and lists ("card aging"). */
export function ago(then: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
