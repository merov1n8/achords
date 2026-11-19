import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { ago, groupTasks } from "../kanban.ts";
import { usePoll } from "../poll.ts";
import type { Task } from "../types.ts";

const CHIP: Record<Task["status"], string> = {
  queued: "todo",
  claimed: "progress",
  done: "done",
  failed: "failed",
  cancelled: "failed",
};

export function Kanban() {
  const tasks = usePoll(() => api<Task[]>("/api/tasks"), 3000);
  return (
    <>
      <div class="page-head">
        <h1>{t("nav.kanban")}</h1>
      </div>
      <div class="kanban">
        {groupTasks(tasks.data ?? []).map((col) => (
          <section key={col.title} class="column">
            <h2>
              {col.title} <span class="muted">{col.tasks.length}</span>
            </h2>
            {col.tasks.map((task) => (
              <article key={task.id} class="card kcard">
                <div class="t">{task.title}</div>
                <div class="m">
                  <span class={`chip ${CHIP[task.status]}`}>{t(`status.${task.status}`)}</span>
                  {task.assigneeAgentId ?? t("kanban.unassigned")} · {ago(task.updatedAt)}
                </div>
                {task.error && task.status !== "done" && <div class="error">{task.error}</div>}
              </article>
            ))}
          </section>
        ))}
      </div>
      {tasks.error && <p class="error">{tasks.error}</p>}
    </>
  );
}
