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
}

export interface TelegramChannel {
  /** One getUpdates round. Throws on network/API errors (message never contains the token). */
  pollOnce(signal?: AbortSignal): Promise<void>;
  /** Sends agent messages from the owner's thread that were not delivered yet. */
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
    message?: { message_id: number; chat: { id: number; type: string } };
  };
  message?: {
    from?: { id: number };
    chat: { id: number; type: string };
    text?: string;
    voice?: { file_id: string; duration: number; file_size?: number };
    caption?: string;
    photo?: { file_id: string; file_size?: number }[];
    document?: { file_id: string; mime_type?: string; file_size?: number };
  };
}

export function createTelegramChannel(deps: TelegramDeps): TelegramChannel {
  const { db } = deps;
  const base = deps.apiBase ?? "https://api.telegram.org";

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
  ) => {
    const rows = [
      ...(actions?.length ? [actions.map((a) => ({ text: a.label, callback_data: a.data }))] : []),
      ...(speak && deps.speaker
        ? [[{ text: t("telegram.readAloud"), callback_data: `tts:${speak}` }]]
        : []),
    ];
    const parts = splitText(text, MAX_TEXT);
    for (const [i, part] of parts.entries()) {
      await call("sendMessage", {
        chat_id: chatId,
        text: part,
        ...(rows.length && i === parts.length - 1
          ? { reply_markup: { inline_keyboard: rows } }
          : {}),
      });
    }
  };

  /** The read-aloud button: the message as a voice note, made on this Mac. */
  async function readAloud(chatId: number, seq: number) {
    const msg = getMessage(db, seq);
    if (!msg || !deps.speaker) return;
    const out = await deps.speaker.speak(msg.content);
    if (!out.ok) {
      await send(chatId, t("telegram.readAloudFailed", { reason: out.reason }));
      return;
    }
    try {
      await upload(
        "sendVoice",
        { chat_id: chatId },
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
      await readAloud(chat.id, Number(tts[1]));
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
    await send(chat.id, reply);
  }

  /** /project: list (no argument), set (slug) or clear (none) the current thread's project. */
  const projectCommand = (arg: string | undefined): string => {
    const all = loadProjects(deps.paths.projectsDir);
    const list = [...all.values()].map((p) => `${p.slug} (${p.name})`).join(", ") || "-";
    const threadId = currentThread();
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
    if (!fileId || (doc && !photo && (doc.file_size ?? 0) > MAX_IMAGE_BYTES)) {
      await send(m.chat.id, t("telegram.imageTooLarge"));
      return;
    }
    const threadId = currentThread();
    let path: string;
    try {
      path = saveImage(deps.paths.home, threadId, type, await download(fileId, "image"));
    } catch (err) {
      await send(m.chat.id, t("telegram.imageFailed", { reason: (err as Error).message }));
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
  ) {
    const stt = deps.transcriber;
    if (!stt?.available().ok) {
      await send(chatId, t("telegram.voiceNoWhisper"));
      return undefined;
    }
    if (voice.duration > MAX_VOICE_S) {
      await send(chatId, t("telegram.voiceTooLong", { minutes: MAX_VOICE_S / 60 }));
      return undefined;
    }
    const bytes = await download(voice.file_id, "voice");
    mkdirSync(deps.paths.runDir, { recursive: true, mode: 0o700 });
    const path = join(deps.paths.runDir, `voice-${randomUUID()}.oga`);
    writeFileSync(path, bytes, { mode: 0o600 });
    try {
      const out = await stt.transcribe(path);
      if (!out.ok) {
        await send(chatId, t("telegram.voiceFailed", { reason: out.reason }));
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
    if (!m?.from || (!m.text && !m.voice && !image)) return;
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

    if (image) {
      // Only after the owner check: nobody else can make the host download anything.
      await imageMessage(m);
      return;
    }

    if (m.voice) {
      // Only now, after the owner check: nobody else can make the host download anything.
      const spoken = await voiceToText(m.chat.id, m.voice);
      if (spoken) await deps.orchestrator.handleMessage(currentThread(), spoken, "telegram");
      return;
    }

    if (text === "/stop") {
      writeStopMarker(deps.paths);
      const lines = killActiveRuns(db);
      deps.onEmergencyStop(lines);
      await send(m.chat.id, t("telegram.stopped", { runs: lines.length - 1 }));
      return;
    }
    const decision = /^\/(approve|reject)\s+([\w-]{1,32})$/.exec(text);
    if (decision) {
      await send(m.chat.id, runAction(`proposal:${decision[1]}:${decision[2]}`));
      return;
    }
    if (text === "/local") {
      makeThreadLocalOnly(db, currentThread());
      await send(m.chat.id, t("telegram.localOnly"));
      return;
    }
    const project = /^\/project(?:\s+([\w-]{1,64}))?$/.exec(text);
    if (project) {
      await send(m.chat.id, projectCommand(project[1]));
      return;
    }
    if (text === "/new") {
      currentThread(true);
      await send(m.chat.id, t("telegram.newThread"));
      return;
    }
    await deps.orchestrator.handleMessage(currentThread(), text, "telegram");
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
      const cursor = Number(getSetting(db, CURSOR) ?? 0);
      for (const msg of listMessagesAfter(db, threadId, cursor)) {
        // Quiet output: only agent messages go out; the owner's own words are not echoed.
        if (msg.role === "agent") await send(chatId, msg.content, msg.actions, msg.seq);
        setSetting(db, CURSOR, String(msg.seq));
      }
    },
  };
}
