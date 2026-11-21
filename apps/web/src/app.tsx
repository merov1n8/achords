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
import { ApiError, api, loadSession, logout } from "./api.ts";
import { Mark } from "./components/Mark.tsx";
import { MoreSheet, TabBar, TopBar } from "./components/MobileNav.tsx";
import { t } from "./i18n.ts";
import { loadCollapsed, saveCollapsed } from "./theme.ts";
import type { Thread } from "./types.ts";
import { Agents } from "./views/Agents.tsx";
import { AllChats } from "./views/AllChats.tsx";
import { Appearance } from "./views/Appearance.tsx";
import { Chat } from "./views/Chat.tsx";
import { ChatList } from "./views/ChatList.tsx";
import { Devices } from "./views/Devices.tsx";
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
import { Updates } from "./views/Updates.tsx";
import { Usage } from "./views/Usage.tsx";
import { Vault } from "./views/Vault.tsx";

/** Hash routes: #/chat/<threadId>, #/kanban, #/projects, #/agents, #/settings/<section>. */
function parseRoute(): string[] {
  return location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
}
const go = (path: string) => {
  location.hash = `#/${path}`;
};

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
    addEventListener("hashchange", onHash);
    // A revoked or expired session surfaces as a 401 from any view: back to pairing.
    const onReject = (e: PromiseRejectionEvent) => {
      if (e.reason instanceof ApiError && e.reason.status === 401) setState("unpaired");
    };
    addEventListener("unhandledrejection", onReject);
    return () => {
      removeEventListener("hashchange", onHash);
      removeEventListener("unhandledrejection", onReject);
    };
  }, []);

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
    <div class={`layout ${collapsed ? "collapsed" : ""}`}>
      <TopBar section={section} sub={sub} onNewChat={newThread} />
      <Sidebar
        section={section}
        sub={sub}
        device={device}
        collapsed={collapsed}
        onCollapse={toggleCollapsed}
      />
      <main>
        {/* Pages scroll here; the live bar sits below them and never covers the chat box. */}
        <div class="page">
          {section === "chat" && <Chat threadId={sub} onThread={(id) => go(`chat/${id}`)} />}
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
          {section === "settings" && sub === "devices" && <Devices onLogout={doLogout} />}
          {section === "settings" && (sub === "appearance" || !sub) && <Appearance />}
        </div>
        <LiveBar />
      </main>
      <TabBar
        section={section}
        chatHref={section === "chat" && sub ? `#/chat/${sub}` : "#/chats"}
        moreOpen={more}
        onMore={() => setMore(true)}
      />
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
  const newThread = async () => {
    const thread = await api<Thread>("/api/threads", { method: "POST", body: {} });
    go(`chat/${thread.id}`);
  };
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
        <span class="lbl">achords</span>
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
      <Group
        icon={<MessageSquare class="icon" />}
        label={t("nav.chat")}
        active={section === "chat" || section === "chats"}
      >
        <ChatList activeId={section === "chat" ? sub : undefined} onNew={newThread} />
      </Group>
      <a
        class={`nav ${section === "kanban" ? "active" : ""}`}
        href="#/kanban"
        title={t("nav.kanban")}
      >
        <Columns3 class="icon" />
        <span class="lbl">{t("nav.kanban")}</span>
      </a>
      <a
        class={`nav ${section === "projects" ? "active" : ""}`}
        href="#/projects"
        title={t("nav.projects")}
      >
        <FolderKanban class="icon" />
        <span class="lbl">{t("nav.projects")}</span>
      </a>
      <a
        class={`nav ${section === "agents" ? "active" : ""}`}
        href="#/agents"
        title={t("nav.agents")}
      >
        <Bot class="icon" />
        <span class="lbl">{t("nav.agents")}</span>
      </a>
      <a
        class={`nav ${section === "skills" ? "active" : ""}`}
        href="#/skills"
        title={t("nav.skills")}
      >
        <BookOpen class="icon" />
        <span class="lbl">{t("nav.skills")}</span>
      </a>
      <a
        class={`nav ${section === "schedules" ? "active" : ""}`}
        href="#/schedules"
        title={t("nav.schedules")}
      >
        <CalendarClock class="icon" />
        <span class="lbl">{t("nav.schedules")}</span>
      </a>
      <a
        class={`nav ${section === "monitors" ? "active" : ""}`}
        href="#/monitors"
        title={t("nav.monitors")}
      >
        <Activity class="icon" />
        <span class="lbl">{t("nav.monitors")}</span>
      </a>
      <a class={`nav ${section === "usage" ? "active" : ""}`} href="#/usage" title={t("nav.usage")}>
        <Gauge class="icon" />
        <span class="lbl">{t("nav.usage")}</span>
      </a>
      <Group
        icon={<SettingsIcon class="icon" />}
        label={t("nav.settings")}
        active={section === "settings"}
      >
        {subLink(
          "#/settings/appearance",
          t("nav.appearance"),
          section === "settings" && (sub === "appearance" || !sub),
        )}
        {subLink("#/settings/integrations", t("nav.integrations"), sub === "integrations")}
        {subLink("#/settings/access", t("nav.modelAccess"), sub === "access")}
        {subLink("#/settings/vault", t("nav.vault"), sub === "vault")}
        {subLink("#/settings/updates", t("nav.updates"), sub === "updates")}
        {subLink("#/settings/devices", t("nav.devices"), sub === "devices")}
        {subLink("#/settings/rooms", t("nav.rooms"), sub === "rooms")}
      </Group>
      <div class="foot muted" title={t("nav.connected", { device: props.device ?? "" })}>
        <span class="dot" />
        <span>{t("nav.connected", { device: props.device ?? "" })}</span>
      </div>
    </nav>
  );
}
