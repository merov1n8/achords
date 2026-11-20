import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuthError,
  createThread,
  type Db,
  getSetting,
  getThread,
  type HomePaths,
  killActiveRuns,
  listMessagesAfter,
  makeThreadLocalOnly,
  redeemPairingCode,
  setSetting,
  writeStopMarker,
} from "@achords/core";
import { t } from "@achords/i18n";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import type { Transcriber } from "../voice/transcribe.ts";

const OWNER_USER = "telegram.owner_user_id";
const OWNER_CHAT = "telegram.owner_chat_id";
const OFFSET = "telegram.offset";
const THREAD = "telegram.thread_id";
const CURSOR = "telegram.delivered_seq";
const MAX_TEXT = 4000; // Bot API limit is 4096
const MAX_VOICE_S = 600;

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
  /** Called after an owner-issued /stop has paused the queue and killed runs. */
  onEmergencyStop: (lines: string[]) => void;
  log: (msg: string) => void;
}

export interface TelegramChannel {
  /** One getUpdates round. Throws on network/API errors (message never contains the token). */
  pollOnce(signal?: AbortSignal): Promise<void>;
  /** Sends agent messages from the owner's thread that were not delivered yet. */
  deliver(): Promise<void>;
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

  const send = (chatId: number, text: string, actions?: { label: string; data: string }[] | null) =>
    call("sendMessage", {
      chat_id: chatId,
      text: text.slice(0, MAX_TEXT),
      ...(actions?.length
        ? {
            reply_markup: {
              inline_keyboard: [actions.map((a) => ({ text: a.label, callback_data: a.data }))],
            },
          }
        : {}),
    });

  /** Runs a button action; same effect as the matching text command. */
  const runAction = (data: string): string => deps.orchestrator.runAction(data).message;

  async function handlePress(q: NonNullable<Update["callback_query"]>) {
    const chat = q.message?.chat;
    // Same rule as messages: the paired owner, in a private chat; anyone else is ignored silently.
    if (chat?.type !== "private" || q.from.id !== ownerUser()) {
      deps.log(`telegram: ignored button press from user ${q.from.id}`);
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
    const file = await call<{ file_path: string }>("getFile", { file_id: voice.file_id });
    let bytes: Buffer;
    try {
      const res = await fetch(`${base}/file/bot${deps.token}/${file.file_path}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      // Never log the URL: it contains the bot token.
      throw new Error(`telegram voice download failed (${(err as Error).name})`);
    }
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
    if (!m?.from || (!m.text && !m.voice)) return;
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

    async deliver() {
      const chatId = Number(getSetting(db, OWNER_CHAT) ?? 0);
      const threadId = getSetting(db, THREAD);
      if (!chatId || !threadId) return;
      const cursor = Number(getSetting(db, CURSOR) ?? 0);
      for (const msg of listMessagesAfter(db, threadId, cursor)) {
        // Quiet output: only agent messages go out; the owner's own words are not echoed.
        if (msg.role === "agent") await send(chatId, msg.content, msg.actions);
        setSetting(db, CURSOR, String(msg.seq));
      }
    },
  };
}
