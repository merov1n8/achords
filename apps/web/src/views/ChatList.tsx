import { Ellipsis, Plus } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { usePoll } from "../poll.ts";
import type { Project, Thread } from "../types.ts";

const RECENT = 10;
const PER_PROJECT = 5;

/** Pin, rename, archive or delete one chat (owner request: many chats). */
export function ThreadMenu(props: { thread: Thread; onChange: () => void; onClose: () => void }) {
  const th = props.thread;
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(th.title ?? "");
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      props.onChange();
      props.onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const put = (body: object) => api(`/api/threads/${th.id}`, { method: "PUT", body });
  if (renaming) {
    return (
      <form
        class="threadmenu"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) void act(() => put({ title: title.trim() }));
        }}
      >
        <input
          class="input"
          aria-label={t("chats.rename")}
          value={title}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
        <button type="submit" class="btn">
          {t("common.save")}
        </button>
      </form>
    );
  }
  return (
    <div class="threadmenu">
      <button
        type="button"
        class="btn ghost"
        onClick={() => act(() => put({ pinned: !th.pinned }))}
      >
        {th.pinned ? t("chats.unpin") : t("chats.pin")}
      </button>
      <button type="button" class="btn ghost" onClick={() => setRenaming(true)}>
        {t("chats.rename")}
      </button>
      <button
        type="button"
        class="btn ghost"
        onClick={() => act(() => put({ archived: !th.archived }))}
      >
        {th.archived ? t("chats.unarchive") : t("chats.archive")}
      </button>
      {confirm ? (
        <button
          type="button"
          class="btn danger"
          onClick={() => act(() => api(`/api/threads/${th.id}`, { method: "DELETE" }))}
        >
          {t("chats.confirmDelete")}
        </button>
      ) : (
        <button type="button" class="btn ghost" onClick={() => setConfirm(true)}>
          {t("chats.delete")}
        </button>
      )}
      {error && <span class="error small">{error}</span>}
    </div>
  );
}

/**
 * The chat part of the sidebar: search, pinned, recent and scheduled chats, or the latest few
 * per project; scrolls on its own so the rest of the menu stays put.
 */
export function ChatList(props: { activeId?: string | undefined; onNew: () => void }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [byProject, setByProject] = useState(false);
  const [menu, setMenu] = useState<string>();
  // Typing settles for a moment before the search runs.
  useEffect(() => {
    const id = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);
  const threads = usePoll(
    () => api<Thread[]>(`/api/threads?limit=200${query ? `&q=${encodeURIComponent(query)}` : ""}`),
    5000,
    [query],
  );
  const projects = usePoll(() => api<Project[]>("/api/projects"), 60000);
  const all = threads.data ?? [];

  const item = (th: Thread) => (
    <div key={th.id} class="threadrow">
      <div class="row">
        <a class={`sub grow ${th.id === props.activeId ? "active" : ""}`} href={`#/chat/${th.id}`}>
          {th.pinned ? "📌 " : ""}
          {th.title ?? t("chat.untitled")}
        </a>
        <button
          type="button"
          class="btn ghost icon-btn"
          aria-label={t("chats.actions")}
          onClick={() => setMenu(menu === th.id ? undefined : th.id)}
        >
          <Ellipsis class="icon" />
        </button>
      </div>
      {menu === th.id && (
        <ThreadMenu thread={th} onChange={threads.refresh} onClose={() => setMenu(undefined)} />
      )}
    </div>
  );
  const heading = (text: string) => <div class="sub-heading">{text}</div>;

  let body: preact.ComponentChildren;
  if (query) {
    body = all.length ? all.map(item) : <p class="muted small sub-pad">{t("chats.none")}</p>;
  } else if (byProject) {
    const groups = [
      ...(projects.data ?? []).map((p) => ({ key: p.slug, name: p.name })),
      { key: "", name: t("chats.noProject") },
    ];
    body = groups.map((g) => {
      const list = all.filter((th) => (th.project ?? "") === g.key);
      if (!list.length) return null;
      return (
        <div key={g.key || "none"}>
          {heading(g.name)}
          {list.slice(0, PER_PROJECT).map(item)}
          {list.length > PER_PROJECT && (
            <a class="sub muted" href={`#/chats/${g.key ? encodeURIComponent(g.key) : "-"}`}>
              {t("chats.more", { n: list.length - PER_PROJECT })}
            </a>
          )}
        </div>
      );
    });
  } else {
    const pinned = all.filter((th) => th.pinned);
    const recent = all.filter((th) => !th.pinned && !th.scheduled).slice(0, RECENT);
    const scheduled = all.filter((th) => !th.pinned && th.scheduled);
    body = (
      <>
        {pinned.length > 0 && heading(t("chats.pinned"))}
        {pinned.map(item)}
        {pinned.length > 0 && heading(t("chats.recent"))}
        {recent.map(item)}
        {scheduled.length > 0 && (
          <details class="subgroup">
            <summary class="sub-heading">{t("chats.scheduled", { n: scheduled.length })}</summary>
            {scheduled.map(item)}
          </details>
        )}
      </>
    );
  }

  return (
    <div class="chatlist">
      <div class="chatlist-tools">
        <input
          class="input small"
          type="search"
          placeholder={t("chats.search")}
          aria-label={t("chats.search")}
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
        />
        <div class="row small">
          <button
            type="button"
            class={`btn ghost ${byProject ? "" : "active"}`}
            onClick={() => setByProject(false)}
          >
            {t("chats.viewRecent")}
          </button>
          <button
            type="button"
            class={`btn ghost ${byProject ? "active" : ""}`}
            onClick={() => setByProject(true)}
          >
            {t("chats.viewProjects")}
          </button>
        </div>
      </div>
      <div class="chatlist-items">{body}</div>
      <button type="button" class="sub as-link" onClick={props.onNew}>
        <Plus class="icon" /> {t("chat.newThread")}
      </button>
      <a class="sub" href="#/chats">
        {t("chats.all")}
      </a>
    </div>
  );
}
