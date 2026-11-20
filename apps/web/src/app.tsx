import {
  Activity,
  Bot,
  CalendarClock,
  ChevronDown,
  CircleCheck,
  Columns3,
  FolderKanban,
  Gauge,
  Menu,
  MessageSquare,
  Plus,
  Settings as SettingsIcon,
} from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ApiError, api, loadSession, logout } from "./api.ts";
import { t } from "./i18n.ts";
import { usePoll } from "./poll.ts";
import type { Thread } from "./types.ts";
import { Agents } from "./views/Agents.tsx";
import { Appearance } from "./views/Appearance.tsx";
import { Chat } from "./views/Chat.tsx";
import { Devices } from "./views/Devices.tsx";
import { Integrations } from "./views/Integrations.tsx";
import { Kanban } from "./views/Kanban.tsx";
import { LiveBar } from "./views/LiveBar.tsx";
import { Monitors } from "./views/Monitors.tsx";
import { Pair } from "./views/Pair.tsx";
import { Projects } from "./views/Projects.tsx";
import { Rooms } from "./views/Rooms.tsx";
import { Schedules } from "./views/Schedules.tsx";
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
  const [drawer, setDrawer] = useState(false);

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
      setDrawer(false);
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
  const doLogout = async () => {
    await logout();
    setState("unpaired");
  };

  return (
    <div class="layout">
      <div class="topbar">
        <button
          type="button"
          class="btn ghost"
          onClick={() => setDrawer(!drawer)}
          aria-label={t("nav.menu")}
        >
          <Menu class="icon" />
        </button>
        <strong>achords</strong>
      </div>
      <Sidebar section={section} sub={sub} open={drawer} device={device} />
      <main>
        {/* Pages scroll here; the live bar sits below them and never covers the chat box. */}
        <div class="page">
          {section === "chat" && <Chat threadId={sub} onThread={(id) => go(`chat/${id}`)} />}
          {section === "kanban" && <Kanban />}
          {section === "agents" && <Agents />}
          {section === "projects" && <Projects />}
          {section === "usage" && <Usage />}
          {section === "schedules" && <Schedules />}
          {section === "monitors" && <Monitors />}
          {section === "settings" && sub === "vault" && <Vault />}
          {section === "settings" && sub === "integrations" && <Integrations />}
          {section === "settings" && sub === "rooms" && <Rooms />}
          {section === "settings" && sub === "devices" && <Devices onLogout={doLogout} />}
          {section === "settings" && (sub === "appearance" || !sub) && <Appearance />}
        </div>
        <LiveBar />
      </main>
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
      <summary class={`nav ${props.active ? "active" : ""}`}>
        {props.icon}
        {props.label}
        <ChevronDown class="icon chev" />
      </summary>
      {props.children}
    </details>
  );
}

function Sidebar(props: {
  section: string;
  sub?: string | undefined;
  open: boolean;
  device?: string | undefined;
}) {
  const threads = usePoll(() => api<Thread[]>("/api/threads"), 5000);
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
    <nav class={`side ${props.open ? "open" : ""}`} aria-label={t("nav.main")}>
      <div class="brand">
        <span class="logo">a</span>achords
      </div>
      <Group
        icon={<MessageSquare class="icon" />}
        label={t("nav.chat")}
        active={section === "chat"}
      >
        {threads.data
          ?.slice(0, 12)
          .map((th) =>
            subLink(
              `#/chat/${th.id}`,
              th.title ?? t("chat.untitled"),
              section === "chat" && sub === th.id,
            ),
          )}
        <button type="button" class="sub as-link" onClick={newThread}>
          <Plus class="icon" /> {t("chat.newThread")}
        </button>
      </Group>
      <a class={`nav ${section === "kanban" ? "active" : ""}`} href="#/kanban">
        <Columns3 class="icon" />
        {t("nav.kanban")}
      </a>
      <a class={`nav ${section === "projects" ? "active" : ""}`} href="#/projects">
        <FolderKanban class="icon" />
        {t("nav.projects")}
      </a>
      <a class={`nav ${section === "agents" ? "active" : ""}`} href="#/agents">
        <Bot class="icon" />
        {t("nav.agents")}
      </a>
      <a class={`nav ${section === "schedules" ? "active" : ""}`} href="#/schedules">
        <CalendarClock class="icon" />
        {t("nav.schedules")}
      </a>
      <a class={`nav ${section === "monitors" ? "active" : ""}`} href="#/monitors">
        <Activity class="icon" />
        {t("nav.monitors")}
      </a>
      <a class={`nav ${section === "usage" ? "active" : ""}`} href="#/usage">
        <Gauge class="icon" />
        {t("nav.usage")}
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
        {subLink("#/settings/vault", t("nav.vault"), sub === "vault")}
        {subLink("#/settings/devices", t("nav.devices"), sub === "devices")}
        {subLink("#/settings/rooms", t("nav.rooms"), sub === "rooms")}
      </Group>
      <div class="foot muted">
        <CircleCheck class="icon" />
        {t("nav.connected", { device: props.device ?? "" })}
      </div>
    </nav>
  );
}
