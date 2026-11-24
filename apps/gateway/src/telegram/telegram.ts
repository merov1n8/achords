import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuthError,
  appendMessage,
  createThread,
  type Db,
  getMessage,
  getSetting,
  getThread,
  type HomePaths,
  IMAGE_TYPES,
  killActiveRuns,
  listMessagesAfter,
  MAX_IMAGE_BYTES,
  makeThreadLocalOnly,
  redeemPairingCode,
  saveImage,
  setSetting,
  setThreadProject,
  type Thread,
  updateThread,
  withImages,
  writeStopMarker,
} from "@achords/core";
import { t } from "@achords/i18n";
import { loadProjects } from "@achords/policy";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import type { Speaker } from "../voice/speak.ts";
import type { Transcriber } from "../voice/transcribe.ts";

const OWNER_USER = "telegram.owner_user_id";
const OWNER_CHAT = "telegram.owner_chat_id";
const OFFSET = "telegram.offset";
const THREAD = "telegram.thread_id";
const CURSOR = "telegram.delivered_seq";
const MAX_TEXT = 4000; // Bot API limit is 4096
const MAX_VOICE_S = 600;
// Topics (ADR-0063). One cursor over all chats; idle topics are deleted after this many days
// unless the owner sets otherwise (empty keeps them).
const TOPICS_SEQ = "telegram.topics_seq";
export const TOPIC_DAYS_KEY = "telegram.topic_days";
export const DEFAULT_TOPIC_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;
const TOPICS_RECHECK_MS = 10 * 60_000;
const TOPICS_TIDY_MS = 60 * 60_000;
const TOPIC_NAME_MAX = 128; // Bot API limit
// Chats that get a topic at once when the mode is turned on: the most recently active ones.
const TOPICS_AT_START = 20;

/** Days an idle topic is kept, or undefined when topics are never deleted. */
export function topicKeepDays(db: Db): number | undefined {
  const v = getSetting(db, TOPIC_DAYS_KEY);
  if (v === undefined) return DEFAULT_TOPIC_DAYS;
  const n = Number(v);
  return v.trim() && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Cuts text into parts of at most `max` chars, at a paragraph or line break when there is one. */
export function splitText(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = window.lastIndexOf("\n\n");
    let gap = 2;
    if (cut < max / 2) {
      cut = window.lastIndexOf("\n");
      gap = 1;
    }
    if (cut < max / 2) {
      parts.push(rest.slice(0, max));
      rest = rest.slice(max);
      continue;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut + gap);
  }
  parts.push(rest);
  return parts;
}

export interface TelegramDeps {
  db: Db;
  paths: HomePaths;
  token: string;
  apiBase?: string;
  /** Long-poll timeout in seconds (0 in tests). */
  pollTimeoutS?: number;
  orchestrator: Pick<Orchestrator, "handleMessage" | "runAction">;
  /** Local speech-to-text for voice notes (ADR-0014); without it voice notes get a hint. */
  transcriber?: Transcriber;
  /** Local text-to-speech: agent messages get a read-aloud button that answers with a voice note. */
  speaker?: Speaker;
  /** Called after an owner-issued /stop has paused the queue and killed runs. */
  onEmergencyStop: (lines: string[]) => void;
  log: (msg: string) => void;
  now?: () => number;
}

export interface TelegramChannel {
  /** One getUpdates round. Throws on network/API errors (message never contains the token). */
  pollOnce(signal?: AbortSignal): Promise<void>;
  /**
   * Sends agent messages that were not delivered yet: from the owner's thread, or, with the
   * bot's forum topic mode on, from every chat into its own topic (ADR-0063).
   */
  deliver(): Promise<void>;
  /** A note for the owner (e.g. a quota warning) in the owner's thread; deliver() sends it. */
  notify(text: string): void;
}

interface Update {
  update_id: number;
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: {
      message_id: number;
      message_thread_id?: number;
      chat: { id: number; type: string };
    };
  };
  message?: {
    from?: { id: number };
    chat: { id: number; type: string };
    text?: string;
    voice?: { file_id: string; duration: number; file_size?: number };
    caption?: string;
    photo?: { file_id: string; file_size?: number }[];
    document?: { file_id: string; mime_type?: string; file_size?: number };
    /** Set in a topic of the private chat (forum topic mode, Bot API 9.3). */
    message_thread_id?: number;
    forum_topic_created?: { name: string };
    forum_topic_edited?: { name?: string };
    reply_to_message?: { forum_topic_created?: { name: string } };
  };
}

/**
 * Inline keyboard rows for a message's actions: one row, or rows of two from four buttons on
 * (Once / For this card / Always / Reject would be cut off side by side on a phone).
 */
export function actionRows(
  actions: { label: string; data: string }[],
): { text: string; callback_data: string }[][] {
  const buttons = actions.map((a) => ({ text: a.label, callback_data: a.data }));
  if (buttons.length <= 3) return buttons.length ? [buttons] : [];
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
}

export function createTelegramChannel(deps: TelegramDeps): TelegramChannel {
  const { db } = deps;
  const base = deps.apiBase ?? "https://api.telegram.org";
  const now = deps.now ?? Date.now;

  // The token is part of the URL; errors are rethrown without it so it never reaches logs.
  async function call<T>(method: string, body: object, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${base}/bot${deps.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw new Error(`telegram ${method}: network error (${(err as Error).name})`);
    }
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T };
    if (!res.ok || !json.ok) throw new Error(`telegram ${method}: HTTP ${res.status}`);
    return json.result as T;
  }

  // Files (voice notes) go up as multipart; same token rule as call().
  async function upload(
    method: string,
    fields: Record<string, string | number>,
    file: { field: string; path: string; name: string; type: string },
  ): Promise<void> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
    form.append(file.field, new Blob([readFileSync(file.path)], { type: file.type }), file.name);
    let res: Response;
    try {
      res = await fetch(`${base}/bot${deps.token}/${method}`, { method: "POST", body: form });
    } catch (err) {
      throw new Error(`telegram ${method}: network error (${(err as Error).name})`);
    }
    if (!res.ok) throw new Error(`telegram ${method}: HTTP ${res.status}`);
  }

  // Long messages go out in parts; buttons belong to the last part. `speak`: the message's seq,
  // for a read-aloud button under it.
  const send = async (
    chatId: number,
    text: string,
    actions?: { label: string; data: string }[] | null,
    speak?: number,
    topic?: number,
  ) => {
    const rows = [
      ...actionRows(actions ?? []),
      ...(speak && deps.speaker
        ? [[{ text: t("telegram.readAloud"), callback_data: `tts:${speak}` }]]
        : []),
    ];
    const parts = splitText(text, MAX_TEXT);
    for (const [i, part] of parts.entries()) {
      await call("sendMessage", {
        chat_id: chatId,
        text: part,
        ...(topic ? { message_thread_id: topic } : {}),
        ...(rows.length && i === parts.length - 1
          ? { reply_markup: { inline_keyboard: rows } }
          : {}),
      });
    }
  };

  /** The read-aloud button: the message as a voice note, made on this Mac. */
  async function readAloud(chatId: number, seq: number, topic?: number) {
    const msg = getMessage(db, seq);
    if (!msg || !deps.speaker) return;
    const out = await deps.speaker.speak(msg.content);
    if (!out.ok) {
      await send(
        chatId,
        t("telegram.readAloudFailed", { reason: out.reason }),
        null,
        undefined,
        topic,
      );
      return;
    }
    try {
      await upload(
        "sendVoice",
        { chat_id: chatId, ...(topic ? { message_thread_id: topic } : {}) },
        { field: "voice", path: out.path, name: "reply.ogg", type: "audio/ogg" },
      );
    } finally {
      rmSync(out.path, { force: true });
    }
  }

  /** Runs a button action; same effect as the matching text command. */
  const runAction = (data: string): string => deps.orchestrator.runAction(data).message;

  async function handlePress(q: NonNullable<Update["callback_query"]>) {
    const chat = q.message?.chat;
    // Same rule as messages: the paired owner, in a private chat; anyone else is ignored silently.
    if (chat?.type !== "private" || q.from.id !== ownerUser()) {
      deps.log(`telegram: ignored button press from user ${q.from.id}`);
      return;
    }
    const tts = /^tts:(\d{1,12})$/.exec(q.data ?? "");
    if (tts) {
      // Not a decision: the buttons stay, the voice note follows.
      await call("answerCallbackQuery", {
        callback_query_id: q.id,
        text: t("telegram.readAloudWorking"),
      });
      await readAloud(chat.id, Number(tts[1]), q.message?.message_thread_id);
      return;
    }
    const reply = runAction(q.data ?? "");
    await call("answerCallbackQuery", { callback_query_id: q.id, text: reply.slice(0, 190) });
    // Remove the buttons so the decision cannot be pressed twice.
    await call("editMessageReplyMarkup", {
      chat_id: chat.id,
      message_id: q.message?.message_id,
      reply_markup: { inline_keyboard: [] },
    });
    await send(chat.id, reply, null, undefined, q.message?.message_thread_id);
  }

  /** /project: list (no argument), set (slug) or clear (none) the current thread's project. */
  const projectCommand = (arg: string | undefined, threadId: string): string => {
    const all = loadProjects(deps.paths.projectsDir);
    const list = [...all.values()].map((p) => `${p.slug} (${p.name})`).join(", ") || "-";
    if (!arg) {
      return t("telegram.projectList", {
        list,
        current: getThread(db, threadId)?.project ?? "none",
      });
    }
    if (arg === "none") {
      setThreadProject(db, threadId, null);
      return t("telegram.projectCleared");
    }
    const p = all.get(arg);
    if (!p) return t("telegram.projectUnknown", { slug: arg, list });
    setThreadProject(db, threadId, p.slug);
    return t("telegram.projectSet", { name: p.name, slug: p.slug });
  };

  const ownerUser = () => Number(getSetting(db, OWNER_USER) ?? 0) || undefined;

  const currentThread = (fresh = false): string => {
    const existing = getSetting(db, THREAD);
    if (!fresh && existing && getThread(db, existing)) return existing;
    const thread = createThread(db, { title: "Telegram" });
    setSetting(db, THREAD, thread.id);
    // Start delivery after anything already in the new thread.
    setSetting(db, CURSOR, "0");
    return thread.id;
  };

  // ---- topics (ADR-0063) ------------------------------------------------------------------

  const topicOf = (threadId: string) =>
    db.prepare("SELECT topic_id FROM telegram_topics WHERE thread_id = ?").get(threadId)
      ?.topic_id as number | undefined;
  const linkTopic = (threadId: string, topic: number) =>
    db
      .prepare(
        "INSERT OR REPLACE INTO telegram_topics (thread_id, topic_id, active_at) VALUES (?, ?, ?)",
      )
      .run(threadId, topic, now());
  const unlinkTopic = (threadId: string) =>
    db.prepare("DELETE FROM telegram_topics WHERE thread_id = ?").run(threadId);
  const touchTopic = (threadId: string) =>
    db.prepare("UPDATE telegram_topics SET active_at = ? WHERE thread_id = ?").run(now(), threadId);

  /**
   * The chat a message belongs to: the topic's own chat, else the one chat outside topics. A
   * topic the bot has not seen was opened by the owner in Telegram: it starts a new chat.
   */
  const threadFor = (m: NonNullable<Update["message"]>): string => {
    const topic = m.message_thread_id;
    if (!topic) return currentThread();
    const known = db.prepare("SELECT thread_id FROM telegram_topics WHERE topic_id = ?").get(topic)
      ?.thread_id as string | undefined;
    if (known && getThread(db, known)) {
      touchTopic(known);
      return known;
    }
    const name = m.forum_topic_created?.name ?? m.reply_to_message?.forum_topic_created?.name;
    const thread = createThread(db, { title: name?.trim() || "Telegram" });
    linkTopic(thread.id, topic);
    return thread.id;
  };

  let mode: { on: boolean; at: number } | undefined;
  /** Whether the bot's forum topic mode is on (a BotFather setting); asked again now and then. */
  async function topicMode(): Promise<boolean> {
    if (mode && now() - mode.at < TOPICS_RECHECK_MS) return mode.on;
    let on = mode?.on ?? false;
    try {
      on = (await call<{ has_topics_enabled?: boolean }>("getMe", {})).has_topics_enabled === true;
    } catch {
      // Unreachable just now: keep what was known.
    }
    mode = { on, at: now() };
    return on;
  }

  /** The chat's topic, made if it has none. Undefined when Telegram refuses to make one. */
  async function ensureTopic(chatId: number, thread: Thread): Promise<number | undefined> {
    const known = topicOf(thread.id);
    if (known) return known;
    let topic: number;
    try {
      const made = await call<{ message_thread_id: number }>("createForumTopic", {
        chat_id: chatId,
        name: (thread.title?.trim() || t("telegram.topicUntitled")).slice(0, TOPIC_NAME_MAX),
      });
      topic = made.message_thread_id;
    } catch (err) {
      deps.log(`telegram: no topic for a chat (${(err as Error).message})`);
      return undefined;
    }
    linkTopic(thread.id, topic);
    // Telegram shows only what is sent from now on; the rest of the chat is on the web.
    const earlier = db
      .prepare("SELECT 1 FROM messages WHERE thread_id = ? AND role = 'user' LIMIT 1")
      .get(thread.id);
    if (earlier) await send(chatId, t("telegram.topicContinues"), null, undefined, topic);
    return topic;
  }

  /** A chat that may show in Telegram: local-only chats never leave this Mac. */
  const mayHaveTopic = (th: Thread) => th.sensitivity !== "local-only" && !th.archived;

  /** Deletes topics idle past the owner's limit; a topic that still offers a decision stays. */
  let tidied = 0;
  async function tidyTopics(chatId: number) {
    if (now() - tidied < TOPICS_TIDY_MS) return;
    tidied = now();
    const days = topicKeepDays(db);
    if (!days) return;
    const idle = db
      .prepare("SELECT thread_id, topic_id FROM telegram_topics WHERE active_at < ?")
      .all(now() - days * DAY_MS);
    for (const row of idle) {
      const threadId = String(row.thread_id);
      const open = db
        .prepare("SELECT 1 FROM messages WHERE thread_id = ? AND actions IS NOT NULL LIMIT 1")
        .get(threadId);
      if (open) continue;
      await call("deleteForumTopic", {
        chat_id: chatId,
        message_thread_id: Number(row.topic_id),
      }).catch(() => {}); // already gone in Telegram: the row goes all the same
      unlinkTopic(threadId);
    }
  }

  /** The one chat outside topics: its agent messages that were not delivered yet. */
  async function deliverOwn(chatId: number, threadId: string) {
    const cursor = Number(getSetting(db, CURSOR) ?? 0);
    for (const msg of listMessagesAfter(db, threadId, cursor)) {
      // Quiet output: only agent messages go out; the owner's own words are not echoed.
      if (msg.role === "agent") await send(chatId, msg.content, msg.actions, msg.seq);
      setSetting(db, CURSOR, String(msg.seq));
    }
  }

  /** Topic mode: every chat's new agent messages go into the chat's own topic. */
  async function deliverTopics(chatId: number) {
    const own = getSetting(db, THREAD);
    if (getSetting(db, TOPICS_SEQ) === undefined) {
      // Turned on just now: what the one chat still owed goes out first, nothing older is
      // replayed, and the chats in use get their topic.
      if (own) await deliverOwn(chatId, own);
      const max = db.prepare("SELECT MAX(rowid) AS seq FROM messages").get()?.seq;
      setSetting(db, TOPICS_SEQ, String(Number(max ?? 0)));
      const recent = db
        .prepare(
          `SELECT id FROM threads WHERE kind = 'chat' AND archived = 0 AND updated_at > ?
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(now() - (topicKeepDays(db) ?? DEFAULT_TOPIC_DAYS) * DAY_MS, TOPICS_AT_START);
      for (const row of recent.reverse()) {
        const th = getThread(db, String(row.id));
        if (th && th.id !== own && mayHaveTopic(th)) await ensureTopic(chatId, th);
      }
    }
    const rows = db
      .prepare(
        `SELECT m.rowid AS seq, m.thread_id, m.role FROM messages m
         JOIN threads th ON th.id = m.thread_id
         WHERE m.rowid > ? AND m.visibility = 'normal' AND th.kind = 'chat' ORDER BY m.rowid`,
      )
      .all(Number(getSetting(db, TOPICS_SEQ) ?? 0));
    for (const row of rows) {
      const seq = Number(row.seq);
      const threadId = String(row.thread_id);
      const msg = row.role === "agent" ? getMessage(db, seq) : undefined;
      if (threadId === own) {
        // The chat outside topics, as before.
        if (msg) await send(chatId, msg.content, msg.actions, seq);
        setSetting(db, CURSOR, String(seq));
      } else {
        const th = getThread(db, threadId);
        // Any new message keeps a chat's topic alive; only the agents' words are sent.
        const wanted = !!th && (topicOf(threadId) !== undefined || mayHaveTopic(th));
        let topic = th && wanted ? await ensureTopic(chatId, th) : undefined;
        if (th && msg && topic) {
          try {
            await send(chatId, msg.content, msg.actions, seq, topic);
          } catch (err) {
            // A refused message means the topic is gone (deleted by hand in Telegram): the chat
            // gets a new one. Anything else (the network) is retried on the next round.
            if (!/HTTP 400/.test((err as Error).message)) throw err;
            unlinkTopic(threadId);
            topic = await ensureTopic(chatId, th);
            if (topic) await send(chatId, msg.content, msg.actions, seq, topic);
          }
        }
        // No topic could be made: outside topics under the chat's name, rather than not at all.
        if (th && msg && wanted && !topic) {
          await send(
            chatId,
            `${th.title?.trim() || t("telegram.topicUntitled")}:\n${msg.content}`,
            msg.actions,
            seq,
          );
        }
        if (topic) touchTopic(threadId);
      }
      setSetting(db, TOPICS_SEQ, String(seq));
    }
    await tidyTopics(chatId);
  }

  async function download(fileId: string, what: string): Promise<Buffer> {
    const file = await call<{ file_path: string }>("getFile", { file_id: fileId });
    try {
      const res = await fetch(`${base}/file/bot${deps.token}/${file.file_path}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      // Never log the URL: it contains the bot token.
      throw new Error(`telegram ${what} download failed (${(err as Error).name})`);
    }
  }

  /** A photo or image file from the owner: stored for the chat, the caption is the message. */
  async function imageMessage(m: NonNullable<Update["message"]>) {
    // Photos come in several sizes, largest last; take the largest a model can still look at.
    const photo = m.photo?.filter((p) => (p.file_size ?? 0) <= MAX_IMAGE_BYTES).at(-1);
    const doc = m.document;
    const type = photo ? "image/jpeg" : (doc?.mime_type ?? "");
    const fileId = photo?.file_id ?? doc?.file_id;
    const say = (text: string) => send(m.chat.id, text, null, undefined, m.message_thread_id);
    if (!fileId || (doc && !photo && (doc.file_size ?? 0) > MAX_IMAGE_BYTES)) {
      await say(t("telegram.imageTooLarge"));
      return;
    }
    const threadId = threadFor(m);
    let path: string;
    try {
      path = saveImage(deps.paths.home, threadId, type, await download(fileId, "image"));
    } catch (err) {
      await say(t("telegram.imageFailed", { reason: (err as Error).message }));
      return;
    }
    await deps.orchestrator.handleMessage(
      threadId,
      withImages(m.caption ?? "", [path]),
      "telegram",
    );
  }

  /** Downloads the owner's voice note and transcribes it locally; undefined if it failed. */
  async function voiceToText(
    chatId: number,
    voice: NonNullable<NonNullable<Update["message"]>["voice"]>,
    topic?: number,
  ) {
    const say = (text: string) => send(chatId, text, null, undefined, topic);
    const stt = deps.transcriber;
    if (!stt?.available().ok) {
      await say(t("telegram.voiceNoWhisper"));
      return undefined;
    }
    if (voice.duration > MAX_VOICE_S) {
      await say(t("telegram.voiceTooLong", { minutes: MAX_VOICE_S / 60 }));
      return undefined;
    }
    const bytes = await download(voice.file_id, "voice");
    mkdirSync(deps.paths.runDir, { recursive: true, mode: 0o700 });
    const path = join(deps.paths.runDir, `voice-${randomUUID()}.oga`);
    writeFileSync(path, bytes, { mode: 0o600 });
    try {
      const out = await stt.transcribe(path);
      if (!out.ok) {
        await say(t("telegram.voiceFailed", { reason: out.reason }));
        return undefined;
      }
      return out.text;
    } finally {
      rmSync(path, { force: true });
    }
  }

  async function handle(update: Update) {
    const m = update.message;
    const image = !!m?.photo?.length || !!IMAGE_TYPES[m?.document?.mime_type ?? ""];
    const topicEvent = !!m?.forum_topic_created || !!m?.forum_topic_edited;
    if (!m?.from || (!m.text && !m.voice && !image && !topicEvent)) return;
    if (m.chat.type !== "private") {
      deps.log(`telegram: ignored message from a ${m.chat.type} chat`);
      return;
    }
    const text = (m.text ?? "").trim();
    const owner = ownerUser();

    if (text.startsWith("/pair ")) {
      try {
        redeemPairingCode(db, "telegram", text.slice(6).trim());
      } catch (err) {
        if (!(err instanceof AuthError)) throw err;
        // Silent: no reply, so the bot does not confirm it exists or that pairing is possible.
        deps.log(`telegram: ignored pairing attempt from user ${m.from.id} (${err.message})`);
        return;
      }
      setSetting(db, OWNER_USER, String(m.from.id));
      setSetting(db, OWNER_CHAT, String(m.chat.id));

      currentThread(true);
      deps.log(`telegram: paired owner user ${m.from.id}`);
      await send(m.chat.id, t("telegram.paired"));
      return;
    }

    if (owner === undefined || m.from.id !== owner) {
      deps.log(`telegram: ignored message from unknown user ${m.from.id}`);
      return;
    }
    setSetting(db, OWNER_CHAT, String(m.chat.id));
    const say = (reply: string) => send(m.chat.id, reply, null, undefined, m.message_thread_id);

    if (topicEvent) {
      // The owner opened or renamed a topic: its chat starts, or follows the name.
      const threadId = threadFor(m);
      const name = m.forum_topic_edited?.name?.trim();
      if (name) updateThread(db, threadId, { title: name });
      return;
    }

    if (image) {
      // Only after the owner check: nobody else can make the host download anything.
      await imageMessage(m);
      return;
    }

    if (m.voice) {
      // Only now, after the owner check: nobody else can make the host download anything.
      const spoken = await voiceToText(m.chat.id, m.voice, m.message_thread_id);
      if (spoken) await deps.orchestrator.handleMessage(threadFor(m), spoken, "telegram");
      return;
    }

    if (text === "/stop") {
      writeStopMarker(deps.paths);
      const lines = killActiveRuns(db);
      deps.onEmergencyStop(lines);
      await say(t("telegram.stopped", { runs: lines.length - 1 }));
      return;
    }
    const decision = /^\/(approve|reject)\s+([\w-]{1,32})$/.exec(text);
    if (decision) {
      await say(runAction(`proposal:${decision[1]}:${decision[2]}`));
      return;
    }
    if (text === "/local") {
      makeThreadLocalOnly(db, threadFor(m));
      await say(t("telegram.localOnly"));
      return;
    }
    const project = /^\/project(?:\s+([\w-]{1,64}))?$/.exec(text);
    if (project) {
      await say(projectCommand(project[1], threadFor(m)));
      return;
    }
    if (text === "/new") {
      currentThread(true);
      await say(t("telegram.newThread"));
      return;
    }
    await deps.orchestrator.handleMessage(threadFor(m), text, "telegram");
  }

  return {
    async pollOnce(signal) {
      const offset = Number(getSetting(db, OFFSET) ?? 0);
      const updates = await call<Update[]>(
        "getUpdates",
        {
          offset,
          timeout: deps.pollTimeoutS ?? 25,
          allowed_updates: ["message", "callback_query"],
        },
        signal,
      );
      for (const u of updates) {
        // Advance first: a message that crashes the handler must not be replayed forever.
        setSetting(db, OFFSET, String(u.update_id + 1));
        if (u.callback_query) await handlePress(u.callback_query);
        else await handle(u);
      }
    },

    notify(text) {
      appendMessage(db, {
        threadId: currentThread(),
        role: "agent",
        author: "system",
        channel: "system",
        content: text,
      });
    },

    async deliver() {
      const chatId = Number(getSetting(db, OWNER_CHAT) ?? 0);
      const threadId = getSetting(db, THREAD);
      if (!chatId || !threadId) return;
      if (await topicMode()) return deliverTopics(chatId);
      await deliverOwn(chatId, threadId);
    },
  };
}
