import { t } from "./i18n.ts";
import type { Task } from "./types.ts";

export interface Column {
  title: string;
  tasks: Task[];
}

const COLUMNS: [string, Task["status"][]][] = [
  ["kanban.todo", ["queued"]],
  ["kanban.inProgress", ["claimed"]],
  ["kanban.done", ["done"]],
  ["kanban.failed", ["failed", "cancelled"]],
];

export function groupTasks(tasks: Task[]): Column[] {
  return COLUMNS.map(([key, statuses]) => ({
    title: t(key),
    tasks: tasks
      .filter((task) => statuses.includes(task.status))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  }));
}

/** Compact age for cards and lists ("card aging"). */
export function ago(then: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return t("time.justNow");
  if (s < 3600) return t("time.minutes", { n: Math.floor(s / 60) });
  if (s < 86400) return t("time.hours", { n: Math.floor(s / 3600) });
  return t("time.days", { n: Math.floor(s / 86400) });
}
