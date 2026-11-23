import {
  Activity,
  BookOpen,
  Bot,
  CalendarClock,
  ChevronDown,
  Columns3,
  FolderKanban,
  Gauge,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Settings as SettingsIcon,
} from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { watchReplies } from "./alerts.ts";
import { ApiError, api, loadSession, logout } from "./api.ts";
import { Mark } from "./components/Mark.tsx";
import { MoreSheet, TabBar, TopBar } from "./components/MobileNav.tsx";
import { t } from "./i18n.ts";
import { inAppPath, navigate, routeOf } from "./route.ts";
import { loadCollapsed, saveCollapsed } from "./theme.ts";
import type { Thread } from "./types.ts";
import { Agents } from "./views/Agents.tsx";
import { AllChats } from "./views/AllChats.tsx";
import { Appearance } from "./views/Appearance.tsx";
import { Chat } from "./views/Chat.tsx";
import { Devices } from "./views/Devices.tsx";
import { Guide } from "./views/Guide.tsx";
import { Integrations } from "./views/Integrations.tsx";
import { Kanban } from "./views/Kanban.tsx";
import { LiveBar } from "./views/LiveBar.tsx";
import { ModelAccess } from "./views/ModelAccess.tsx";
import { Monitors } from "./views/Monitors.tsx";
import { Pair } from "./views/Pair.tsx";
import { Projects } from "./views/Projects.tsx";
import { Rooms } from "./views/Rooms.tsx";
import { Schedules } from "./views/Schedules.tsx";
import { Skills } from "./views/Skills.tsx";
import { Storage } from "./views/Storage.tsx";
import { Updates } from "./views/Updates.tsx";
import { Usage } from "./views/Usage.tsx";
import { Vault } from "./views/Vault.tsx";

const parseRoute = () => routeOf(location.pathname);
const go = (path: string) => navigate(`/${path}`);

export function App() {
  const [state, setState] = useState<"loading" | "unpaired" | "ready" | "error">("loading");
  const [device, setDevice] = useState<string>();
  const [route, setRoute] = useState(parseRoute());
  const [more, setMore] = useState(false);
  const [collapsed, setCollapsed] = useState(loadCollapsed());
  const toggleCollapsed = () => {
    saveCollapsed(!collapsed);
    setCollapsed(!collapsed);
  };

  const check = () =>
    loadSession()
      .then((name) => {
        setDevice(name);
        setState(name ? "ready" : "unpaired");
      })
      .catch(() => setState("error"));

  useEffect(() => {
    check();
    const onHash = () => {
      setRoute(parseRoute());
      setMore(false);
    };
    addEventListener("popstate", onHash);
    // Own links open in the app without a reload.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a) return;
      const path = inAppPath(a.getAttribute("href"), location.origin, {
        target: a.target,
        download: a.hasAttribute("download"),
        modified: e.metaKey || e.ctrlKey || e.shiftKey || e.altKey,
      });
      if (!path) return;
      e.preventDefault();
      if (path !== location.pathname + location.search) navigate(path);
      else onHash();
    };
    document.addEventListener("click", onClick);
    // A revoked or expired session surfaces as a 401 from any view: back to pairing.
    const onReject = (e: PromiseRejectionEvent) => {
      if (e.reason instanceof ApiError && e.reason.status === 401) setState("unpaired");
    };
    addEventListener("unhandledrejection", onReject);
    return () => {
      removeEventListener("popstate", onHash);
      document.removeEventListener("click", onClick);
      removeEventListener("unhandledrejection", onReject);
    };
  }, []);

  // Chime and unread count in the title while the app is open (paired only).
  useEffect(() => {
    if (state !== "ready") return;
    return watchReplies(
      () => api<Thread[]>("/api/threads?limit=200"),
      () => {
        const [section, sub] = parseRoute();
        return section === "chat" || section === undefined ? sub : undefined;
      },
    );
  }, [state]);

  if (state === "loading") return <p class="muted pair">{t("app.loading")}</p>;
  if (state === "error") return <p class="error pair">{t("app.unreachable")}</p>;
  if (state === "unpaired") return <Pair onPaired={check} />;

  const [section = "chat", sub] = route;
  const newThread = async () => {
    const thread = await api<Thread>("/api/threads", { method: "POST", body: {} });
    go(`chat/${thread.id}`);
  };
  const doLogout = async () => {
    await logout();
    setState("unpaired");
  };

  return (
    <div
      class={`layout ${collapsed ? "collapsed" : ""} ${section === "chat" && sub ? "thread-open" : ""}`}
    >
      <TopBar section={section} sub={sub} onNewChat={newThread} />
      <Sidebar
        section={section}
        sub={sub}
        device={device}
        collapsed={collapsed}
        onCollapse={toggleCollapsed}
      />
      {/* The chat page brings its own columns, edge to edge. */}
      <main class={section === "chat" ? "flush" : undefined}>
        {/* Pages scroll here; the live bar sits below them and never covers the chat box. */}
        <div class="page">
          {section === "chat" && (
            <Chat threadId={sub} onThread={(id) => go(`chat/${id}`)} onNew={newThread} />
          )}
          {section === "kanban" && <Kanban />}
          {section === "agents" && <Agents />}
          {section === "projects" && <Projects />}
          {section === "usage" && <Usage />}
          {section === "skills" && <Skills />}
          {section === "schedules" && <Schedules />}
          {section === "monitors" && <Monitors />}
          {section === "chats" && <AllChats key={sub ?? ""} project={sub} />}
          {section === "settings" && sub === "vault" && <Vault />}
          {section === "settings" && sub === "integrations" && <Integrations />}
          {section === "settings" && sub === "updates" && <Updates />}
          {section === "settings" && sub === "access" && <ModelAccess />}
          {section === "settings" && sub === "rooms" && <Rooms />}
          {section === "settings" && sub === "guide" && <Guide />}
          {section === "settings" && sub === "storage" && <Storage />}
          {section === "settings" && sub === "devices" && <Devices onLogout={doLogout} />}
          {section === "settings" && (sub === "appearance" || !sub) && <Appearance />}
        </div>
        <LiveBar />
      </main>
      <TabBar section={section} chatHref="/chat" moreOpen={more} onMore={() => setMore(true)} />
      <MoreSheet
        open={more}
        onClose={() => setMore(false)}
        section={section}
        sub={sub}
        device={device}
      />
    </div>
  );
}

function Group(props: {
  icon: ComponentChildren;
  label: string;
  active: boolean;
  children: ComponentChildren;
}) {
  return (
    <details class="grp" open={props.active || undefined}>
      <summary class={`nav ${props.active ? "active" : ""}`} title={props.label}>
        {props.icon}
        <span class="lbl">{props.label}</span>
        <ChevronDown class="icon chev" />
      </summary>
      {props.children}
    </details>
  );
}

function Sidebar(props: {
  section: string;
  sub?: string | undefined;
  device?: string | undefined;
  collapsed: boolean;
  onCollapse: () => void;
}) {
  const subLink = (href: string, label: string, active: boolean) => (
    <a class={`sub ${active ? "active" : ""}`} href={href}>
      {label}
    </a>
  );
  const { section, sub } = props;
  return (
    <nav class="side" aria-label={t("nav.main")}>
      <div class="brand">
        <Mark />
        <span class="lbl">Achords</span>
        <button
          type="button"
          class="iconbtn collapse-btn"
          onClick={props.onCollapse}
          aria-label={t(props.collapsed ? "nav.expand" : "nav.collapse")}
          aria-expanded={!props.collapsed}
          title={t(props.collapsed ? "nav.expand" : "nav.collapse")}
        >
          {props.collapsed ? <PanelLeftOpen class="icon" /> : <PanelLeftClose class="icon" />}
        </button>
      </div>
      <a
        class={`nav ${section === "chat" || section === "chats" ? "active" : ""}`}
        href="/chat"
        title={t("nav.chat")}
      >
        <MessageSquare class="icon" />
        <span class="lbl">{t("nav.chat")}</span>
      </a>
      <a
        class={`nav ${section === "kanban" ? "active" : ""}`}
        href="/kanban"
        title={t("nav.kanban")}
      >
        <Columns3 class="icon" />
        <span class="lbl">{t("nav.kanban")}</span>
      </a>
      <a
        class={`nav ${section === "projects" ? "active" : ""}`}
        href="/projects"
        title={t("nav.projects")}
      >
        <FolderKanban class="icon" />
        <span class="lbl">{t("nav.projects")}</span>
      </a>
      <a
        class={`nav ${section === "agents" ? "active" : ""}`}
        href="/agents"
        title={t("nav.agents")}
      >
        <Bot class="icon" />
        <span class="lbl">{t("nav.agents")}</span>
      </a>
      <a
        class={`nav ${section === "skills" ? "active" : ""}`}
        href="/skills"
        title={t("nav.skills")}
      >
        <BookOpen class="icon" />
        <span class="lbl">{t("nav.skills")}</span>
      </a>
      <a
        class={`nav ${section === "schedules" ? "active" : ""}`}
        href="/schedules"
        title={t("nav.schedules")}
      >
        <CalendarClock class="icon" />
        <span class="lbl">{t("nav.schedules")}</span>
      </a>
      <a
        class={`nav ${section === "monitors" ? "active" : ""}`}
        href="/monitors"
        title={t("nav.monitors")}
      >
        <Activity class="icon" />
        <span class="lbl">{t("nav.monitors")}</span>
      </a>
      <a class={`nav ${section === "usage" ? "active" : ""}`} href="/usage" title={t("nav.usage")}>
        <Gauge class="icon" />
        <span class="lbl">{t("nav.usage")}</span>
      </a>
      <Group
        icon={<SettingsIcon class="icon" />}
        label={t("nav.settings")}
        active={section === "settings"}
      >
        {subLink(
          "/settings/appearance",
          t("nav.appearance"),
          section === "settings" && (sub === "appearance" || !sub),
        )}
        {subLink("/settings/guide", t("nav.guide"), sub === "guide")}
        {subLink("/settings/integrations", t("nav.integrations"), sub === "integrations")}
        {subLink("/settings/access", t("nav.modelAccess"), sub === "access")}
        {subLink("/settings/vault", t("nav.vault"), sub === "vault")}
        {subLink("/settings/updates", t("nav.updates"), sub === "updates")}
        {subLink("/settings/storage", t("nav.storage"), sub === "storage")}
        {subLink("/settings/devices", t("nav.devices"), sub === "devices")}
        {subLink("/settings/rooms", t("nav.rooms"), sub === "rooms")}
      </Group>
      <div class="foot muted" title={t("nav.connected", { device: props.device ?? "" })}>
        <span class="dot" />
        <span>{t("nav.connected", { device: props.device ?? "" })}</span>
      </div>
    </nav>
  );
}
