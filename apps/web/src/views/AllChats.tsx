import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { ago } from "../kanban.ts";
import { usePoll } from "../poll.ts";
import type { Project, Thread } from "../types.ts";
import { ThreadMenu } from "./ChatList.tsx";

/** Every chat with filters; archive several at once. `project` "-" means chats without one. */
export function AllChats(props: { project?: string | undefined }) {
  const [project, setProject] = useState(props.project ?? "");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const id = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);
  const params = new URLSearchParams({ limit: "500", ...(archived ? { archived: "1" } : {}) });
  if (project && project !== "-") params.set("project", project);
  if (query) params.set("q", query);
  const threads = usePoll(() => api<Thread[]>(`/api/threads?${params}`), 10000, [
    project,
    query,
    archived,
  ]);
  const projects = usePoll(() => api<Project[]>("/api/projects"), 60000);
  const names = new Map((projects.data ?? []).map((p) => [p.slug, p.name]));
  const list = (threads.data ?? []).filter((th) => project !== "-" || !th.project);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const bulk = async () => {
    setError(undefined);
    try {
      for (const id of selected) {
        await api(`/api/threads/${id}`, { method: "PUT", body: { archived: !archived } });
      }
      setSelected(new Set());
      threads.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <div class="page-head">
        <h1>{t("chats.all")}</h1>
      </div>
      <div class="row wrap">
        <input
          class="input"
          type="search"
          placeholder={t("chats.search")}
          aria-label={t("chats.search")}
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
        />
        <select
          class="input"
          aria-label={t("chats.project")}
          value={project}
          onChange={(e) => setProject(e.currentTarget.value)}
        >
          <option value="">{t("chats.allProjects")}</option>
          <option value="-">{t("chats.noProject")}</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
        <label class="row">
          <input
            type="checkbox"
            checked={archived}
            onChange={() => {
              setArchived(!archived);
              setSelected(new Set());
            }}
          />
          {t("chats.showArchived")}
        </label>
        {selected.size > 0 && (
          <button type="button" class="btn" onClick={bulk}>
            {archived
              ? t("chats.unarchiveN", { n: selected.size })
              : t("chats.archiveN", { n: selected.size })}
          </button>
        )}
      </div>
      <div class="panel gap-top">
        {list.length === 0 ? (
          <p class="muted">{t("chats.none")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label={t("chats.selectAll")}
                    checked={list.length > 0 && list.every((th) => selected.has(th.id))}
                    onChange={(e) =>
                      setSelected(
                        e.currentTarget.checked ? new Set(list.map((th) => th.id)) : new Set(),
                      )
                    }
                  />
                </th>
                <th>{t("chats.title")}</th>
                <th>{t("chats.project")}</th>
                <th>{t("chats.updated")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((th) => (
                <>
                  <tr key={th.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={t("chats.select")}
                        checked={selected.has(th.id)}
                        onChange={() => toggle(th.id)}
                      />
                    </td>
                    <td>
                      <a href={`#/chat/${th.id}`}>
                        {th.pinned ? "📌 " : ""}
                        {th.title ?? t("chat.untitled")}
                      </a>
                    </td>
                    <td>{th.project ? (names.get(th.project) ?? th.project) : "–"}</td>
                    <td class="muted small">{ago(th.updatedAt)}</td>
                    <td>
                      <button
                        type="button"
                        class="btn ghost"
                        onClick={() => setMenu(menu === th.id ? undefined : th.id)}
                      >
                        {t("chats.actions")}
                      </button>
                    </td>
                  </tr>
                  {menu === th.id && (
                    <tr key={`${th.id}-menu`}>
                      <td colSpan={5}>
                        <ThreadMenu
                          thread={th}
                          onChange={threads.refresh}
                          onClose={() => setMenu(undefined)}
                        />
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
        {error && <p class="error">{error}</p>}
      </div>
    </>
  );
}
