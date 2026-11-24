import {
  ChevronLeft,
  Info,
  LoaderCircle,
  Mic,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Send,
  Square,
  Volume2,
  X,
} from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, uploadImage } from "../api.ts";
import { formatUsd, imageParts, mention, type ThreadSummary, withImages } from "../chat.ts";
import { Markdown } from "../components/Markdown.tsx";
import { Confirm } from "../components/Modal.tsx";
import { loadDraft, pruneDrafts, saveDraft } from "../drafts.ts";
import { t } from "../i18n.ts";
import { ago } from "../kanban.ts";
import { messageTags } from "../messageTags.ts";
import { usePoll } from "../poll.ts";
import { useRecorder } from "../recorder.ts";
import { canSpeak, speak, stopSpeaking } from "../speech.ts";
import { loadDetailsOpen, saveDetailsOpen } from "../theme.ts";
import type { Message, Project, Thread } from "../types.ts";
import { ChatList } from "./ChatList.tsx";
import { RunDetails, RunSheet } from "./RunDetails.tsx";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_IMAGES = 6;

/** One chat image; once deleted by the retention it says so instead of a broken picture. */
function ChatImage({ src }: { src: string }) {
  const [gone, setGone] = useState(false);
  if (gone) return <span class="muted small">{t("chat.imageGone")}</span>;
  return (
    <a href={src} target="_blank" rel="noreferrer">
      <img src={src} alt="" loading="lazy" onError={() => setGone(true)} />
    </a>
  );
}

/** A message's text, and the images of this chat it carries shown as pictures. */
function MessageBody(props: { threadId: string; content: string; markdown: boolean }) {
  const { text, images } = imageParts(props.content, props.threadId);
  return (
    <>
      {text && (props.markdown ? <Markdown text={text} /> : <div class="content">{text}</div>)}
      {images.length > 0 && (
        <div class="msg-images">
          {images.map((name) => (
            <ChatImage key={name} src={`/api/threads/${props.threadId}/images/${name}`} />
          ))}
        </div>
      )}
    </>
  );
}

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
  const [details, setDetails] = useState(loadDetailsOpen());
  useEffect(() => pruneDrafts(), []);
  const toggleDetails = () => {
    saveDetailsOpen(!details);
    setDetails(!details);
  };
  return (
    <div
      class={`chatpage ${props.threadId ? "has-thread" : ""} ${details ? "" : "details-closed"}`}
    >
      <aside class="chatcol" aria-label={t("nav.chat")}>
        <ChatList activeId={props.threadId} onNew={props.onNew} />
      </aside>
      {props.threadId ? (
        <ThreadView
          key={props.threadId}
          threadId={props.threadId}
          thread={thread}
          onToggleDetails={toggleDetails}
        />
      ) : (
        <p class="muted chat-empty">
          {threads.data?.length === 0 ? t("chat.empty") : t("app.loading")}
        </p>
      )}
    </div>
  );
}

function ThreadView({
  threadId,
  thread,
  onToggleDetails,
}: {
  threadId: string;
  thread?: Thread | undefined;
  onToggleDetails: () => void;
}) {
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
        onOpenDetails={onToggleDetails}
        error={error}
        onError={setError}
      />
      <aside class="runcol" aria-label={t("chat.details")}>
        <div class="runcol-head">
          <button
            type="button"
            class="iconbtn"
            onClick={onToggleDetails}
            aria-label={t("chat.hideDetails")}
            title={t("chat.hideDetails")}
          >
            <PanelRightClose class="icon" />
          </button>
        </div>
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
  onOpenDetails: () => void;
  error?: string | undefined;
  onError: (m: string | undefined) => void;
}) {
  const { threadId, thread, summary: s, error } = props;
  const setError = props.onError;
  const messages = usePoll(() => api<Message[]>(`/api/threads/${threadId}/messages`), 2000, [
    threadId,
  ]);
  // Unsent text survives switching chats or pages (kept per chat in this browser).
  const [text, setText] = useState(() => loadDraft(threadId));
  const [speaking, setSpeaking] = useState<string>();
  // Leaving the chat stops reading.
  useEffect(() => stopSpeaking, []);
  const [waitingAfter, setWaitingAfter] = useState<number>();
  // Images dropped or pasted, shown as thumbnails until the message is sent.
  const [pending, setPending] = useState<{ file: File; preview: string }[]>([]);
  const [dragging, setDragging] = useState(false);
  const addImages = (files: Iterable<File>) => {
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type)) continue;
      if (file.size > MAX_IMAGE) {
        setError(t("chat.imageTooLarge"));
        continue;
      }
      // A data: URL, because the page's CSP allows no blob: images.
      const reader = new FileReader();
      reader.onload = () =>
        setPending((cur) =>
          [...cur, { file, preview: String(reader.result) }].slice(0, MAX_IMAGES),
        );
      reader.readAsDataURL(file);
    }
  };
  const mic = useRecorder(
    (spoken) => setText((cur) => (cur ? `${cur} ${spoken}` : spoken)),
    (msg) => setError(msg),
  );
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => saveDraft(threadId, text), [threadId, text]);
  // A restored draft gets its height back.
  useEffect(() => {
    if (input.current?.value) grow(input.current);
  }, []);

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
    if (!text.trim() && !pending.length) return;
    setError(undefined);
    try {
      const paths: string[] = [];
      for (const p of pending) paths.push(await uploadImage(threadId, p.file));
      const body = withImages(text, paths);
      await api(`/api/threads/${threadId}/messages`, { method: "POST", body: { text: body } });
      setText("");
      // The box grew with a long message; sent, it goes back to its normal size.
      if (input.current) input.current.style.height = "";
      setPending([]);
      setWaitingAfter(lastSeq);
      messages.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    // The whole conversation is a drop target for images; keyboard users paste them instead.
    <section
      aria-label={t("nav.chat")}
      class={`conversation ${dragging ? "dropping" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer?.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer?.files.length) return;
        e.preventDefault();
        setDragging(false);
        addImages(e.dataTransfer.files);
        input.current?.focus();
      }}
    >
      <header class="thread-head">
        <a class="iconbtn touch back" href="/chat" aria-label={t("chat.back")}>
          <ChevronLeft class="icon" />
        </a>
        <div class="grow">
          <h1>
            <span class="crumb">
              {t("nav.chat")}
              <span aria-hidden="true"> / </span>
            </span>
            <TitleEdit threadId={threadId} title={thread?.title ?? ""} onError={setError} />
          </h1>
          {s && (
            <div class="status muted small">
              <span class={`dot ${s.agentsWorking ? "" : "off"}`} />
              {s.waitingOwner
                ? t("chat.statusWaiting", { usd: formatUsd(s.costUsd) })
                : t("chat.statusLine", {
                    done: s.tasksDone,
                    total: s.tasksTotal,
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
        <button
          type="button"
          class="iconbtn open-details"
          onClick={props.onOpenDetails}
          aria-label={t("chat.showDetails")}
          title={t("chat.showDetails")}
        >
          <PanelRightOpen class="icon" />
        </button>
      </header>
      {s && (
        <progress class="thread-progress" max={Math.max(s.tasksTotal, 1)} value={s.tasksDone} />
      )}
      <div class="messages">
        {list.map((m) => {
          const tags = messageTags(m);
          return (
            <div
              key={m.id}
              class={`msg ${m.role}`}
              title={m.role === "user" ? `${m.channel} · ${ago(m.createdAt)}` : undefined}
            >
              {/* Your own bubble shows only the text (design); the time is in its tooltip. */}
              {m.role !== "user" && (
                <div class="meta">
                  <span class="chip agent-tag">{tags.agent}</span>
                  {tags.kind && (
                    <span class={`chip kind-tag ${tags.kind}`}>{t(`chat.tag.${tags.kind}`)}</span>
                  )}
                  {m.channel} · {ago(m.createdAt)}
                  {canSpeak() && (
                    <button
                      type="button"
                      class="iconbtn speak"
                      onClick={() => {
                        if (speaking === m.id) {
                          stopSpeaking();
                          setSpeaking(undefined);
                        } else {
                          setSpeaking(m.id);
                          speak(m.content, () => setSpeaking((s) => (s === m.id ? undefined : s)));
                        }
                      }}
                      aria-label={t(speaking === m.id ? "chat.stopReading" : "chat.readAloud")}
                      title={t(speaking === m.id ? "chat.stopReading" : "chat.readAloud")}
                    >
                      {speaking === m.id ? <Square class="icon" /> : <Volume2 class="icon" />}
                    </button>
                  )}
                </div>
              )}
              {/* Agents answer in Markdown; the owner's own words stay as typed. */}
              <MessageBody
                threadId={threadId}
                content={tags.content}
                markdown={m.role === "agent"}
              />
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
          );
        })}
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
      {pending.length > 0 && (
        <div class="pending-images">
          {pending.map((p, i) => (
            <div key={p.preview} class="thumb">
              <img src={p.preview} alt={p.file.name} />
              <button
                type="button"
                class="iconbtn"
                aria-label={t("chat.removeImage")}
                title={t("chat.removeImage")}
                onClick={() => setPending((cur) => cur.filter((_, j) => j !== i))}
              >
                <X class="icon" />
              </button>
            </div>
          ))}
        </div>
      )}
      <form class="composer" onSubmit={send}>
        <textarea
          ref={input}
          class="input"
          value={text}
          onInput={(e) => {
            setText(e.currentTarget.value);
            grow(e.currentTarget);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) send(e);
          }}
          onPaste={(e) => {
            const files = [...(e.clipboardData?.files ?? [])].filter((f) =>
              f.type.startsWith("image/"),
            );
            if (!files.length) return;
            e.preventDefault();
            addImages(files);
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

/** The chat title in the header: click to rename in place (Enter saves, Escape cancels). */
function TitleEdit(props: {
  threadId: string;
  title: string;
  onError: (m: string | undefined) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(props.title);
  const [shown, setShown] = useState<string>();
  const title = shown ?? props.title;
  const save = async () => {
    setEditing(false);
    const next = value.trim();
    if (!next || next === title) return;
    try {
      await api(`/api/threads/${props.threadId}`, { method: "PUT", body: { title: next } });
      setShown(next);
    } catch (err) {
      props.onError((err as Error).message);
    }
  };
  if (!editing) {
    return (
      <button
        type="button"
        class="title-edit"
        title={t("chat.renameHint")}
        onClick={() => {
          setValue(title);
          setEditing(true);
        }}
      >
        <span class="grow-text">{title || t("chat.untitled")}</span>
        <Pencil class="icon pencil" aria-hidden="true" />
      </button>
    );
  }
  return (
    <input
      class="input title-input"
      // biome-ignore lint/a11y/noAutofocus: the owner just clicked the title to edit it
      autoFocus
      maxLength={200}
      value={value}
      aria-label={t("chat.rename")}
      placeholder={t("chat.titlePlaceholder")}
      onInput={(e) => setValue(e.currentTarget.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setValue(title);
          setEditing(false);
        }
      }}
    />
  );
}

/**
 * The composer grows with what is typed (up to half the screen), like the Claude apps; the owner
 * can also drag it taller. Emptied after sending, it goes back to its small size.
 */
function grow(el: HTMLTextAreaElement): void {
  if (!el.value) {
    el.style.height = "";
    return;
  }
  const max = Math.round(window.innerHeight * 0.5);
  const manual = el.offsetHeight;
  el.style.height = "auto";
  el.style.height = `${Math.min(Math.max(el.scrollHeight, manual), max)}px`;
}
