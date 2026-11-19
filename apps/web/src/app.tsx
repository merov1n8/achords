import { useEffect, useState } from "preact/hooks";
import { ApiError, loadSession, logout } from "./api.ts";
import { Agents } from "./views/Agents.tsx";
import { Chat } from "./views/Chat.tsx";
import { Devices } from "./views/Devices.tsx";
import { Kanban } from "./views/Kanban.tsx";
import { Pair } from "./views/Pair.tsx";
import { Settings } from "./views/Settings.tsx";
import { Vault } from "./views/Vault.tsx";

const ROUTES = ["chat", "kanban", "agents", "vault", "devices", "settings"] as const;
type Route = (typeof ROUTES)[number];

const routeFromHash = (): Route => {
  const r = location.hash.replace(/^#\/?/, "");
  return (ROUTES as readonly string[]).includes(r) ? (r as Route) : "chat";
};

export function App() {
  const [state, setState] = useState<"loading" | "unpaired" | "ready" | "error">("loading");
  const [device, setDevice] = useState<string>();
  const [route, setRoute] = useState<Route>(routeFromHash());

  const check = () =>
    loadSession()
      .then((name) => {
        setDevice(name);
        setState(name ? "ready" : "unpaired");
      })
      .catch(() => setState("error"));

  useEffect(() => {
    check();
    const onHash = () => setRoute(routeFromHash());
    addEventListener("hashchange", onHash);
    // A revoked or expired session surfaces as a 401 from any view: go back to pairing.
    const onReject = (e: PromiseRejectionEvent) => {
      if (e.reason instanceof ApiError && e.reason.status === 401) setState("unpaired");
    };
    addEventListener("unhandledrejection", onReject);
    return () => {
      removeEventListener("hashchange", onHash);
      removeEventListener("unhandledrejection", onReject);
    };
  }, []);

  if (state === "loading") return <p class="muted center">Loading…</p>;
  if (state === "error") return <p class="error center">Cannot reach the gateway.</p>;
  if (state === "unpaired") return <Pair onPaired={check} />;

  const doLogout = async () => {
    await logout();
    setState("unpaired");
  };

  return (
    <div class="layout">
      <nav>
        <strong>achords</strong>
        {ROUTES.map((r) => (
          <a key={r} href={`#/${r}`} class={r === route ? "active" : ""}>
            {r[0]?.toUpperCase() + r.slice(1)}
          </a>
        ))}
        <span class="muted device">{device}</span>
      </nav>
      <main>
        {route === "chat" && <Chat />}
        {route === "kanban" && <Kanban />}
        {route === "agents" && <Agents />}
        {route === "vault" && <Vault />}
        {route === "devices" && <Devices onLogout={doLogout} />}
        {route === "settings" && <Settings />}
      </main>
    </div>
  );
}
