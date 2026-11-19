import { api } from "../api.ts";
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
    <div>
      <table>
        <thead>
          <tr>
            <th>Device</th>
            <th>Paired</th>
            <th>Last seen</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {devices.data?.map((d) => (
            <tr key={d.id}>
              <td>
                {d.deviceName} {d.current && <span class="badge">this device</span>}
              </td>
              <td class="muted">{ago(d.createdAt)}</td>
              <td class="muted">{ago(d.lastSeenAt)}</td>
              <td>
                {d.current ? (
                  <button type="button" onClick={onLogout}>
                    Log out
                  </button>
                ) : (
                  <button type="button" class="danger" onClick={() => revoke(d.id)}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="muted">
        Pair another device: run <code>achords pair web</code> on the host.
      </p>
    </div>
  );
}
