import {
  Activity,
  BookOpen,
  Bot,
  CalendarClock,
  Columns3,
  Ellipsis,
  FolderKanban,
  Gauge,
  List,
  MessageSquare,
  Plus,
  Settings as SettingsIcon,
} from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { t } from "../i18n.ts";
import { useBackdropClose } from "./backdrop.ts";
import { Mark } from "./Mark.tsx";

// Phones (< 768px): a sticky top bar, a bottom tab bar with four sections + More, and a bottom
// sheet for the rest (achords-design mobile handoff). The desktop sidebar is hidden there.

export const SETTINGS_PAGES: [string, string][] = [
  ["appearance", "nav.appearance"],
  ["guide", "nav.guide"],
  ["integrations", "nav.integrations"],
  ["access", "nav.modelAccess"],
  ["vault", "nav.vault"],
  ["updates", "nav.updates"],
  ["storage", "nav.storage"],
  ["devices", "nav.devices"],
  ["rooms", "nav.rooms"],
];

const TITLES: Record<string, string> = {
  chat: "nav.chat",
  chats: "nav.chat",
  kanban: "nav.kanban",
  agents: "nav.agents",
  monitors: "nav.monitors",
  projects: "nav.projects",
  schedules: "nav.schedules",
  skills: "nav.skills",
  usage: "nav.usage",
};

export function TopBar(props: {
  section: string;
  sub?: string | undefined;
  onNewChat: () => void;
}) {
  const settings = SETTINGS_PAGES.find(([id]) => id === (props.sub ?? "appearance"));
  const title =
    props.section === "settings"
      ? t(settings?.[1] ?? "nav.settings")
      : t(TITLES[props.section] ?? "nav.chat");
  const chat = props.section === "chat" || props.section === "chats";
  return (
    <header class="topbar">
      <Mark />
      <h1>{title}</h1>
      <span class="grow" />
      {chat && (
        <>
          <a class="iconbtn touch" href="/chats" aria-label={t("chats.all")} title={t("chats.all")}>
            <List class="icon" />
          </a>
          <button
            type="button"
            class="btn primary square"
            onClick={props.onNewChat}
            aria-label={t("chat.newThread")}
            title={t("chat.newThread")}
          >
            <Plus class="icon" />
          </button>
        </>
      )}
    </header>
  );
}

function Tab(props: {
  href?: string;
  label: string;
  active: boolean;
  icon: ComponentChildren;
  onClick?: () => void;
  expanded?: boolean;
}) {
  const inner = (
    <>
      <span class="pill">{props.icon}</span>
      {props.label}
    </>
  );
  return props.href ? (
    <a href={props.href} aria-current={props.active ? "page" : undefined}>
      {inner}
    </a>
  ) : (
    <button
      type="button"
      onClick={props.onClick}
      aria-expanded={props.expanded}
      aria-haspopup="dialog"
    >
      {inner}
    </button>
  );
}

export function TabBar(props: {
  section: string;
  chatHref: string;
  moreOpen: boolean;
  onMore: () => void;
}) {
  const s = props.section;
  return (
    <nav class="tabbar" aria-label={t("nav.main")}>
      <Tab
        href={props.chatHref}
        label={t("nav.chat")}
        active={s === "chat" || s === "chats"}
        icon={<MessageSquare class="icon" />}
      />
      <Tab
        href="/kanban"
        label={t("nav.kanban")}
        active={s === "kanban"}
        icon={<Columns3 class="icon" />}
      />
      <Tab
        href="/agents"
        label={t("nav.agents")}
        active={s === "agents"}
        icon={<Bot class="icon" />}
      />
      <Tab
        href="/monitors"
        label={t("nav.monitors")}
        active={s === "monitors"}
        icon={<Activity class="icon" />}
      />
      <Tab
        label={t("nav.more")}
        active={false}
        expanded={props.moreOpen}
        onClick={props.onMore}
        icon={<Ellipsis class="icon" />}
      />
    </nav>
  );
}

export function MoreSheet(props: {
  open: boolean;
  onClose: () => void;
  sub?: string | undefined;
  section: string;
  device?: string | undefined;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const backdrop = useBackdropClose(ref, props.onClose);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) d.showModal();
    if (!props.open && d.open) d.close();
  }, [props.open]);
  const tile = (href: string, label: string, icon: ComponentChildren) => (
    <a href={href} onClick={props.onClose}>
      {icon}
      {label}
    </a>
  );
  return (
    <dialog
      ref={ref}
      class="more-sheet"
      aria-label={t("nav.more")}
      onClose={props.onClose}
      {...backdrop}
    >
      <span class="grabber" />
      <div class="grid">
        {tile("/projects", t("nav.projects"), <FolderKanban class="icon" />)}
        {tile("/skills", t("nav.skills"), <BookOpen class="icon" />)}
        {tile("/schedules", t("nav.schedules"), <CalendarClock class="icon" />)}
        {tile("/usage", t("nav.usage"), <Gauge class="icon" />)}
        {tile("/settings/appearance", t("nav.settings"), <SettingsIcon class="icon" />)}
      </div>
      <div>
        <div class="sheet-sec">{t("nav.settings")}</div>
        {SETTINGS_PAGES.map(([id, key]) => (
          <a
            key={id}
            class={`nav ${props.section === "settings" && (props.sub ?? "appearance") === id ? "active" : ""}`}
            href={`/settings/${id}`}
            onClick={props.onClose}
          >
            {t(key)}
          </a>
        ))}
      </div>
      <div class="foot muted">
        <span class="dot" />
        {t("nav.connected", { device: props.device ?? "" })}
      </div>
    </dialog>
  );
}
