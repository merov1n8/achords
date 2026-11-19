import { api } from "../api.ts";
import { ago, groupTasks } from "../kanban.ts";
import { usePoll } from "../poll.ts";
import type { Task } from "../types.ts";

export function Kanban() {
  const tasks = usePoll(() => api<Task[]>("/api/tasks"), 3000);
  return (
    <div class="kanban">
      {groupTasks(tasks.data ?? []).map((col) => (
        <section key={col.title} class="column">
          <h2>
            {col.title} <span class="muted">{col.tasks.length}</span>
          </h2>
          {col.tasks.map((t) => (
            <article key={t.id} class={`card ${t.status}`}>
              <div class="title">{t.title}</div>
              <div class="meta">
                {t.assigneeAgentId ?? "unassigned"} · {ago(t.updatedAt)}
              </div>
              {t.error && t.status !== "done" && <div class="error">{t.error}</div>}
            </article>
          ))}
        </section>
      ))}
      {tasks.error && <p class="error">{tasks.error}</p>}
    </div>
  );
}
