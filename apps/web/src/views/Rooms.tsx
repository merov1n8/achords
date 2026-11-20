import { useState } from "preact/hooks";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { ago } from "../kanban.ts";
import { usePoll } from "../poll.ts";
import type { Message } from "../types.ts";

type Room = {
  id: string;
  topic: string;
  openerAgentId: string;
  participants: string[];
  rounds: number;
  turnsDone: number;
  createdAt: number;
  closedAt: number | null;
};

/** Read-only audit view of agent discussions (ADR-0032); they never appear among chats. */
export function Rooms() {
  const rooms = usePoll(() => api<Room[]>("/api/rooms"), 15000);
  const [open, setOpen] = useState<string>();
  return (
    <>
      <div class="page-head">
        <h1>{t("nav.rooms")}</h1>
      </div>
      <p class="muted">{t("rooms.help")}</p>
      <div class="panel">
        {rooms.data?.length === 0 ? (
          <p class="muted">{t("rooms.empty")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("rooms.topic")}</th>
                <th>{t("rooms.people")}</th>
                <th>{t("rooms.turns")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rooms.data?.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.topic} <span class="muted">· {ago(r.createdAt)}</span>
                  </td>
                  <td>
                    <code>{r.openerAgentId}</code> →{" "}
                    {r.participants.map((p) => (
                      <code key={p}>{p} </code>
                    ))}
                  </td>
                  <td>
                    {r.turnsDone}/{r.participants.length * r.rounds}{" "}
                    <span class={`chip ${r.closedAt ? "done" : "progress"}`}>
                      {t(r.closedAt ? "rooms.closed" : "rooms.open")}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      class="btn ghost"
                      onClick={() => setOpen(open === r.id ? undefined : r.id)}
                    >
                      {t("rooms.read")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && <Transcript key={open} id={open} />}
      {rooms.error && <p class="error">{rooms.error}</p>}
    </>
  );
}

function Transcript({ id }: { id: string }) {
  const messages = usePoll(() => api<Message[]>(`/api/rooms/${id}/messages`), 10000, [id]);
  return (
    <div class="panel gap-top messages">
      {messages.data?.map((m) => (
        <div key={m.id} class="msg agent">
          <div class="meta">{m.author}</div>
          <div class="content">{m.content}</div>
        </div>
      ))}
    </div>
  );
}
