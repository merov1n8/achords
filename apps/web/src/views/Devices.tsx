import { LogOut } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { Confirm } from "../components/Modal.tsx";
import { t } from "../i18n.ts";
import { ago } from "../kanban.ts";
import { usePoll } from "../poll.ts";
import type { Device } from "../types.ts";

export function Devices({ onLogout }: { onLogout: () => void }) {
  const devices = usePoll(() => api<Device[]>("/api/devices"), 10000);
  const [revoking, setRevoking] = useState<Device>();
  return (
    <>
      <div class="page-head">
        <h1>{t("nav.devices")}</h1>
      </div>
      <div class="panel">
        <table>
          <thead>
            <tr>
              <th>{t("devices.device")}</th>
              <th>{t("devices.paired")}</th>
              <th>{t("devices.lastSeen")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {devices.data?.map((d) => (
              <tr key={d.id}>
                <td>
                  {d.deviceName}{" "}
                  {d.current && <span class="chip done">{t("devices.thisDevice")}</span>}
                </td>
                <td class="muted">{ago(d.createdAt)}</td>
                <td class="muted">{ago(d.lastSeenAt)}</td>
                <td>
                  {d.current ? (
                    <button type="button" class="btn" onClick={onLogout}>
                      <LogOut class="icon" />
                      {t("devices.logout")}
                    </button>
                  ) : (
                    <button type="button" class="btn danger" onClick={() => setRevoking(d)}>
                      {t("devices.revoke")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="muted gap-top">{t("devices.pairHint")}</p>
      <RemoteAccess />
      {revoking && (
        <Confirm
          title={t("devices.revokeTitle")}
          message={t("devices.revokeConfirm", { device: revoking.deviceName })}
          confirmLabel={t("devices.revoke")}
          danger
          onConfirm={async () => {
            await api(`/api/devices/${revoking.id}`, { method: "DELETE" });
            devices.refresh();
          }}
          onClose={() => setRevoking(undefined)}
        />
      )}
    </>
  );
}

/** The address other devices use (Tailscale); editable because it changes with the machine. */
function RemoteAccess() {
  const [host, setHost] = useState("");
  const [suggested, setSuggested] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();
  useEffect(() => {
    api<{ host: string; suggested: string }>("/api/remote-access")
      .then((r) => {
        setHost(r.host);
        setSuggested(r.suggested);
      })
      .catch((err: Error) => setStatus({ ok: false, text: err.message }));
  }, []);
  const save = async (e: Event) => {
    e.preventDefault();
    try {
      const r = await api<{ host: string }>("/api/remote-access", {
        method: "PUT",
        body: { host },
      });
      setHost(r.host);
      setStatus({
        ok: true,
        text: r.host ? t("remote.saved", { url: `https://${r.host}` }) : t("remote.cleared"),
      });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  };
  return (
    <form class="panel gap-top" onSubmit={save}>
      <h2>{t("remote.title")}</h2>
      <p class="muted small">{t("remote.help")}</p>
      <div class="row">
        <input
          class="input"
          placeholder={suggested || "mini.tail1234.ts.net"}
          value={host}
          onInput={(e) => setHost(e.currentTarget.value)}
          aria-label={t("remote.title")}
        />
        {suggested && suggested !== host && (
          <button type="button" class="btn ghost" onClick={() => setHost(suggested)}>
            {t("remote.useSuggested")}
          </button>
        )}
        <button type="submit" class="btn primary">
          {t("common.save")}
        </button>
      </div>
      {status && <p class={status.ok ? "muted small" : "error small"}>{status.text}</p>}
    </form>
  );
}
