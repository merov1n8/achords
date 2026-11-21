import {
  Archive,
  ArchiveRestore,
  Ellipsis,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
} from "lucide-preact";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.ts";
import { Confirm, Modal } from "../components/Modal.tsx";
import { t } from "../i18n.ts";
import { usePoll } from "../poll.ts";
import type { Project, Thread } from "../types.ts";

const RECENT = 10;
const PER_PROJECT = 5;

/**
 * The … button of one chat and its menu: pin, rename, archive, delete. A small popover anchored
 * to the button (fixed, so the scrolling sidebar does not clip it); rename and delete open modals.
 */
export function ThreadMenu(props: { thread: Thread; onChange: () => void }) {
  const th = props.thread;
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number }>();
  const [dialog, setDialog] = useState<"rename" | "delete">();
  const [title, setTitle] = useState(th.title ?? "");
  const [error, setError] = useState<string>();
  const open = pos !== undefined;

  const close = (refocus = true) => {
    setPos(undefined);
    if (refocus) trigger.current?.focus();
  };
  const toggle = () => {
    const r = trigger.current?.getBoundingClientRect();
    if (open || !r) return close(false);
    setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  useLayoutEffect(() => {
    const m = menu.current;
    const r = trigger.current?.getBoundingClientRect();
    if (!open || !m || !r) return;
    // No room below: open upwards.
    if (r.bottom + 4 + m.offsetHeight > window.innerHeight - 8) {
      setPos({ top: Math.max(8, r.top - 4 - m.offsetHeight), right: window.innerWidth - r.right });
    }
    items()[0]?.focus();
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!m.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    // The menu is placed once; scrolling or resizing would leave it floating elsewhere.
    const away = (e: Event) => {
      if (!m.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => list[(n + list.length) % list.length]?.focus();
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "Escape") close();
    else if (e.key === "Tab") close(false);
    else return;
    if (e.key !== "Tab") e.preventDefault();
  };

  const put = async (body: object) => {
    setError(undefined);
    try {
      await api(`/api/threads/${th.id}`, { method: "PUT", body });
      props.onChange();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };
  const item = (Icon: typeof Pin, label: string, run: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      class={`menuitem ${danger ? "danger" : ""}`}
      onClick={() => {
        close();
        run();
      }}
    >
      <Icon class="icon" />
      {label}
    </button>
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="btn ghost icon-btn"
        aria-label={t("chats.actions")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
      >
        <Ellipsis class="icon" />
      </button>
      {pos && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={th.title ?? t("chat.untitled")}
          class="menu"
          style={{ top: `${pos.top}px`, right: `${pos.right}px` }}
          onKeyDown={onKey}
        >
          {th.pinned
            ? item(PinOff, t("chats.unpin"), () => put({ pinned: false }))
            : item(Pin, t("chats.pin"), () => put({ pinned: true }))}
          {item(Pencil, t("chats.rename"), () => {
            setTitle(th.title ?? "");
            setDialog("rename");
          })}
          {th.archived
            ? item(ArchiveRestore, t("chats.unarchive"), () => put({ archived: false }))
            : item(Archive, t("chats.archive"), () => put({ archived: true }))}
          {item(Trash2, t("chats.delete"), () => setDialog("delete"), true)}
        </div>
      )}
      {error && !dialog && <span class="error small">{error}</span>}
      {dialog === "rename" && (
        <Modal
          title={t("chats.renameTitle")}
          onClose={() => {
            setDialog(undefined);
            setError(undefined);
          }}
          footer={
            <>
              <button type="button" class="btn ghost" onClick={() => setDialog(undefined)}>
                {t("common.cancel")}
              </button>
              <button type="submit" form={`${menuId}-rename`} class="btn primary">
                {t("common.save")}
              </button>
            </>
          }
        >
          <form
            id={`${menuId}-rename`}
            onSubmit={async (e) => {
              e.preventDefault();
              if (title.trim() && (await put({ title: title.trim() }))) setDialog(undefined);
            }}
          >
            <input
              class="input"
              aria-label={t("chats.rename")}
              value={title}
              onInput={(e) => setTitle(e.currentTarget.value)}
            />
            {error && <p class="error">{error}</p>}
          </form>
        </Modal>
      )}
      {dialog === "delete" && (
        <Confirm
          title={t("chats.deleteTitle")}
          message={t("chats.deleteConfirm", { title: th.title ?? t("chat.untitled") })}
          confirmLabel={t("chats.delete")}
          danger
          onConfirm={async () => {
            await api(`/api/threads/${th.id}`, { method: "DELETE" });
            props.onChange();
          }}
          onClose={() => setDialog(undefined)}
        />
      )}
    </>
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
        <ThreadMenu thread={th} onChange={threads.refresh} />
      </div>
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
