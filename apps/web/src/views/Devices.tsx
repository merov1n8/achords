import { LogOut } from "lucide-preact";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { ago } from "../kanban.ts";
import { usePoll } from "../poll.ts";
import type { Device } from "../types.ts";

export function Devices({ onLogout }: { onLogout: () => void }) {
  const devices = usePoll(() => api<Device[]>("/api/devices"), 10000);
  const revoke = async (id: string) => {
    await api(`/api/devices/${id}`, { method: "DELETE" });
    devices.refresh();
  };
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
                    <button type="button" class="btn danger" onClick={() => revoke(d.id)}>
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
    </>
  );
}
