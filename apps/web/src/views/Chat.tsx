import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.ts";
import { ago } from "../kanban.ts";
import { usePoll } from "../poll.ts";
import type { Message, Thread } from "../types.ts";

export function Chat() {
  const threads = usePoll(() => api<Thread[]>("/api/threads"), 5000);
  const [selected, setSelected] = useState<string>();
  const current = selected ?? threads.data?.[0]?.id;

  const newThread = async () => {
    const t = await api<Thread>("/api/threads", { method: "POST", body: {} });
    threads.refresh();
    setSelected(t.id);
  };

  return (
    <div class="chat">
      <aside class="threads">
        <button type="button" onClick={newThread}>
          + New thread
        </button>
        <ul>
          {threads.data?.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                class={t.id === current ? "active" : ""}
                onClick={() => setSelected(t.id)}
              >
                {t.title ?? "Untitled"} <span class="muted">{ago(t.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      {current ? (
        <Conversation key={current} threadId={current} />
      ) : (
        <p class="muted">No threads yet.</p>
      )}
    </div>
  );
}

function Conversation({ threadId }: { threadId: string }) {
  const messages = usePoll(() => api<Message[]>(`/api/threads/${threadId}/messages`), 2000, [
    threadId,
  ]);
  const [text, setText] = useState("");
  const [waitingAfter, setWaitingAfter] = useState<number>();
  const [error, setError] = useState<string>();
  const end = useRef<HTMLDivElement>(null);

  const list = messages.data ?? [];
  const lastSeq = list.at(-1)?.seq ?? 0;
  // "Thinking" until an agent message newer than the one we sent shows up.
  const waiting =
    waitingAfter !== undefined && !list.some((m) => m.role === "agent" && m.seq > waitingAfter);

  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [list.length, waiting]);

  const send = async (e: Event) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setError(undefined);
    try {
      await api(`/api/threads/${threadId}/messages`, { method: "POST", body: { text: body } });
      setText("");
      setWaitingAfter(lastSeq);
      messages.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section class="conversation">
      <div class="messages">
        {list.map((m) => (
          <div key={m.id} class={`message ${m.role}`}>
            <div class="meta">
              {m.role === "user" ? "you" : (m.author ?? m.role)} · {m.channel} · {ago(m.createdAt)}
            </div>
            <div class="content">{m.content}</div>
          </div>
        ))}
        {waiting && <div class="message agent muted">boss is thinking…</div>}
        <div ref={end} />
      </div>
      <form class="composer" onSubmit={send}>
        <textarea
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) send(e);
          }}
          placeholder="Message the boss (Enter to send, Shift+Enter for a new line)"
          rows={3}
        />
        <button type="submit">Send</button>
      </form>
      {error && <p class="error">{error}</p>}
    </section>
  );
}
