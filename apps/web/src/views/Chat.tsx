import { ChevronLeft, Info, LoaderCircle, Mic, Send, Square } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.ts";
import { formatUsd, mention, type ThreadSummary } from "../chat.ts";
import { Confirm } from "../components/Modal.tsx";
import { t } from "../i18n.ts";
import { ago } from "../kanban.ts";
import { usePoll } from "../poll.ts";
import { useRecorder } from "../recorder.ts";
import type { Message, Project, Thread } from "../types.ts";
import { ChatList } from "./ChatList.tsx";
import { RunDetails, RunSheet } from "./RunDetails.tsx";

const phone = () => matchMedia("(max-width: 767.98px)").matches;

/** Chat page: chat list | conversation | run details. Phones show the list or one chat. */
export function Chat(props: {
  threadId?: string | undefined;
  onThread: (id: string) => void;
  onNew: () => void;
}) {
  const threads = usePoll(() => api<Thread[]>("/api/threads"), 5000);
  const first = threads.data?.[0]?.id;
  // No thread in the URL: open the most recent one (phones stay on the list).
  useEffect(() => {
    if (!props.threadId && first && !phone()) props.onThread(first);
  }, [props.threadId, first]);

  const thread = threads.data?.find((x) => x.id === props.threadId);
  return (
    <div class={`chatpage ${props.threadId ? "has-thread" : ""}`}>
      <aside class="chatcol" aria-label={t("nav.chat")}>
        <ChatList activeId={props.threadId} onNew={props.onNew} />
      </aside>
      {props.threadId ? (
        <ThreadView key={props.threadId} threadId={props.threadId} thread={thread} />
      ) : (
        <p class="muted chat-empty">
          {threads.data?.length === 0 ? t("chat.empty") : t("app.loading")}
        </p>
      )}
    </div>
  );
}

function ThreadView({ threadId, thread }: { threadId: string; thread?: Thread | undefined }) {
  const summary = usePoll(() => api<ThreadSummary>(`/api/threads/${threadId}/summary`), 3000, [
    threadId,
  ]);
  const [info, setInfo] = useState(false);
  const [stop, setStop] = useState(false);
  const [error, setError] = useState<string>();
  const s = summary.data;
  return (
    <>
      <Conversation
        threadId={threadId}
        thread={thread}
        summary={s}
        onInfo={() => setInfo(true)}
        error={error}
        onError={setError}
      />
      <aside class="runcol" aria-label={t("chat.details")}>
        {s && <RunDetails summary={s} onStop={() => setStop(true)} />}
      </aside>
      <RunSheet open={info} onClose={() => setInfo(false)}>
        {s && <RunDetails summary={s} onStop={() => setStop(true)} />}
        <div class="phone-only">
          <ProjectPicker threadId={threadId} current={thread?.project ?? null} onError={setError} />
        </div>
      </RunSheet>
      {stop && (
        <Confirm
          title={t("chat.stopTitle")}
          message={t("chat.stopConfirm")}
          confirmLabel={t("chat.stop")}
          danger
          onConfirm={async () => {
            await api(`/api/threads/${threadId}/stop`, { method: "POST" });
            summary.refresh();
          }}
          onClose={() => setStop(false)}
        />
      )}
    </>
  );
}

function Conversation(props: {
  threadId: string;
  thread?: Thread | undefined;
  summary?: ThreadSummary | undefined;
  onInfo: () => void;
  error?: string | undefined;
  onError: (m: string | undefined) => void;
}) {
  const { threadId, thread, summary: s, error } = props;
  const setError = props.onError;
  const messages = usePoll(() => api<Message[]>(`/api/threads/${threadId}/messages`), 2000, [
    threadId,
  ]);
  const [text, setText] = useState("");
  const [waitingAfter, setWaitingAfter] = useState<number>();
  const mic = useRecorder(
    (spoken) => setText((cur) => (cur ? `${cur} ${spoken}` : spoken)),
    (msg) => setError(msg),
  );
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const list = messages.data ?? [];
  const lastSeq = list.at(-1)?.seq ?? 0;
  // "Thinking" until an agent message newer than the one we sent shows up.
  const waiting =
    waitingAfter !== undefined && !list.some((m) => m.role === "agent" && m.seq > waitingAfter);

  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [list.length, waiting]);

  const runAction = async (data: string) => {
    setError(undefined);
    try {
      await api("/api/actions", { method: "POST", body: { data } });
      messages.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

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
      <header class="thread-head">
        <a class="iconbtn touch back" href="#/chat" aria-label={t("chat.back")}>
          <ChevronLeft class="icon" />
        </a>
        <div class="grow">
          <h1>
            <span class="crumb">
              {t("nav.chat")}
              <span aria-hidden="true"> / </span>
            </span>
            {thread?.title ?? t("chat.untitled")}
          </h1>
          {s && (
            <div class="status muted small">
              <span class={`dot ${s.agentsWorking ? "" : "off"}`} />
              {t("chat.statusLine", {
                n: s.agentsWorking,
                total: s.agentsTotal,
                usd: formatUsd(s.costUsd),
              })}
            </div>
          )}
        </div>
        <div class="row head-tools">
          {thread?.sensitivity === "local-only" && (
            <span class="chip local">{t("chat.localOnly")}</span>
          )}
          <ProjectPicker threadId={threadId} current={thread?.project ?? null} onError={setError} />
        </div>
        <button
          type="button"
          class="iconbtn touch info"
          onClick={props.onInfo}
          aria-label={t("chat.details")}
          aria-haspopup="dialog"
          title={t("chat.details")}
        >
          <Info class="icon" />
        </button>
      </header>
      {s && (
        <progress
          class="thread-progress"
          max={Math.max(s.agentsTotal, 1)}
          value={s.agentsWorking}
        />
      )}
      <div class="messages">
        {list.map((m) => (
          <div key={m.id} class={`msg ${m.role}`}>
            <div class="meta">
              {m.role === "user" ? t("chat.you") : (m.author ?? m.role)} · {m.channel} ·{" "}
              {ago(m.createdAt)}
            </div>
            <div class="content">{m.content}</div>
            {m.actions && (
              <div class="actions">
                {m.actions.map((a, i) => (
                  <button
                    key={a.data}
                    type="button"
                    class={`btn ${i === 0 ? "primary" : ""}`}
                    onClick={() => runAction(a.data)}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {waiting && <div class="msg agent muted">{t("chat.thinking")}</div>}
        <div ref={end} />
      </div>
      {s && s.participants.length > 0 && (
        <div class="mentions">
          {s.participants.map((p) => (
            <button
              key={p.agent}
              type="button"
              class="chip"
              aria-pressed={text.startsWith(`@${p.agent} `)}
              title={t("chat.mention", { name: p.name })}
              onClick={() => {
                setText((cur) => mention(cur, p.agent));
                input.current?.focus();
              }}
            >
              @{p.name}
            </button>
          ))}
        </div>
      )}
      <form class="composer" onSubmit={send}>
        <textarea
          ref={input}
          class="input"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) send(e);
          }}
          placeholder={t("chat.placeholder")}
          rows={2}
        />
        <button
          type="button"
          class={`btn ${mic.state === "recording" ? "danger" : ""}`}
          title={t(mic.state === "recording" ? "chat.micStop" : "chat.mic")}
          aria-label={t(mic.state === "recording" ? "chat.micStop" : "chat.mic")}
          disabled={mic.state === "transcribing"}
          onClick={() => {
            setError(undefined);
            if (mic.state === "recording") mic.stop();
            else mic.start();
          }}
        >
          {mic.state === "recording" ? (
            <Square class="icon" />
          ) : mic.state === "transcribing" ? (
            <LoaderCircle class="icon spin" />
          ) : (
            <Mic class="icon" />
          )}
        </button>
        <button type="submit" class="btn primary">
          <Send class="icon" />
          <span class="send-lbl">{t("chat.send")}</span>
        </button>
      </form>
      {error && <p class="error">{error}</p>}
    </section>
  );
}

/** The thread's project: its PROJECT.md and folder apply to work started from here on. */
function ProjectPicker(props: {
  threadId: string;
  current: string | null;
  onError: (m: string) => void;
}) {
  const projects = usePoll(() => api<Project[]>("/api/projects"), 30000);
  const [value, setValue] = useState(props.current);
  useEffect(() => setValue(props.current), [props.current]);
  if (!projects.data?.length && !value) return null;
  const pick = async (slug: string) => {
    const project = slug || null;
    try {
      await api(`/api/threads/${props.threadId}/project`, { method: "PUT", body: { project } });
      setValue(project);
    } catch (err) {
      props.onError((err as Error).message);
    }
  };
  return (
    <label class="row" title={t("chat.projectHelp")}>
      <span class="muted">{t("chat.project")}</span>
      <select class="input" value={value ?? ""} onChange={(e) => pick(e.currentTarget.value)}>
        <option value="">{t("chat.noProject")}</option>
        {projects.data?.map((p) => (
          <option key={p.slug} value={p.slug}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}
