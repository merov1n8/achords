import { Send } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { ago } from "../kanban.ts";
import { usePoll } from "../poll.ts";
import type { Message, Thread } from "../types.ts";

export function Chat(props: { threadId?: string | undefined; onThread: (id: string) => void }) {
  const threads = usePoll(() => api<Thread[]>("/api/threads"), 5000);
  const first = threads.data?.[0]?.id;
  // No thread in the URL: open the most recent one.
  useEffect(() => {
    if (!props.threadId && first) props.onThread(first);
  }, [props.threadId, first]);

  if (!props.threadId) {
    return <p class="muted">{threads.data?.length === 0 ? t("chat.empty") : t("app.loading")}</p>;
  }
  const thread = threads.data?.find((x) => x.id === props.threadId);
  return <Conversation key={props.threadId} threadId={props.threadId} thread={thread} />;
}

function Conversation({ threadId, thread }: { threadId: string; thread?: Thread | undefined }) {
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
      <div class="page-head">
        <h1>{thread?.title ?? t("chat.untitled")}</h1>
        {thread?.sensitivity === "local-only" && (
          <span class="chip local">{t("chat.localOnly")}</span>
        )}
      </div>
      <div class="messages">
        {list.map((m) => (
          <div key={m.id} class={`msg ${m.role}`}>
            <div class="meta">
              {m.role === "user" ? t("chat.you") : (m.author ?? m.role)} · {m.channel} ·{" "}
              {ago(m.createdAt)}
            </div>
            <div class="content">{m.content}</div>
          </div>
        ))}
        {waiting && <div class="msg agent muted">{t("chat.thinking")}</div>}
        <div ref={end} />
      </div>
      <form class="composer" onSubmit={send}>
        <textarea
          class="input"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) send(e);
          }}
          placeholder={t("chat.placeholder")}
          rows={2}
        />
        <button type="submit" class="btn primary">
          <Send class="icon" />
          {t("chat.send")}
        </button>
      </form>
      {error && <p class="error">{error}</p>}
    </section>
  );
}
