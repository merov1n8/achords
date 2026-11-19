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
import type { Orchestrator } from "../orchestrator/orchestrator.ts";

const OWNER_USER = "telegram.owner_user_id";
const OWNER_CHAT = "telegram.owner_chat_id";
const OFFSET = "telegram.offset";
const THREAD = "telegram.thread_id";
const CURSOR = "telegram.delivered_seq";
const MAX_TEXT = 4000; // Bot API limit is 4096

export interface TelegramDeps {
  db: Db;
  paths: HomePaths;
  token: string;
  apiBase?: string;
  /** Long-poll timeout in seconds (0 in tests). */
  pollTimeoutS?: number;
  orchestrator: Pick<Orchestrator, "handleMessage">;
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
  message?: {
    from?: { id: number };
    chat: { id: number; type: string };
    text?: string;
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

  const send = (chatId: number, text: string) =>
    call("sendMessage", { chat_id: chatId, text: text.slice(0, MAX_TEXT) });

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

  async function handle(update: Update) {
    const m = update.message;
    if (!m?.text || !m.from) return;
    if (m.chat.type !== "private") {
      deps.log(`telegram: ignored message from a ${m.chat.type} chat`);
      return;
    }
    const text = m.text.trim();
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
      await send(m.chat.id, "Paired. I only listen to you from now on.");
      return;
    }

    if (owner === undefined || m.from.id !== owner) {
      deps.log(`telegram: ignored message from unknown user ${m.from.id}`);
      return;
    }
    setSetting(db, OWNER_CHAT, String(m.chat.id));

    if (text === "/stop") {
      writeStopMarker(deps.paths);
      const lines = killActiveRuns(db);
      deps.onEmergencyStop(lines);
      await send(
        m.chat.id,
        `Emergency stop: ${lines.length - 1} run(s) killed, queue paused. The gateway is shutting down; run \`achords resume\` and \`achords start\` on the host to continue.`,
      );
      return;
    }
    if (text === "/local") {
      makeThreadLocalOnly(db, currentThread());
      await send(
        m.chat.id,
        "This thread is now local-only: it runs on local models only and never reaches a cloud model. This cannot be undone; use /new for normal work.",
      );
      return;
    }
    if (text === "/new") {
      currentThread(true);
      await send(m.chat.id, "New thread started.");
      return;
    }
    await deps.orchestrator.handleMessage(currentThread(), text, "telegram");
  }

  return {
    async pollOnce(signal) {
      const offset = Number(getSetting(db, OFFSET) ?? 0);
      const updates = await call<Update[]>(
        "getUpdates",
        { offset, timeout: deps.pollTimeoutS ?? 25, allowed_updates: ["message"] },
        signal,
      );
      for (const u of updates) {
        // Advance first: a message that crashes the handler must not be replayed forever.
        setSetting(db, OFFSET, String(u.update_id + 1));
        await handle(u);
      }
    },

    async deliver() {
      const chatId = Number(getSetting(db, OWNER_CHAT) ?? 0);
      const threadId = getSetting(db, THREAD);
      if (!chatId || !threadId) return;
      const cursor = Number(getSetting(db, CURSOR) ?? 0);
      for (const msg of listMessagesAfter(db, threadId, cursor)) {
        // Quiet output: only agent messages go out; the owner's own words are not echoed.
        if (msg.role === "agent") await send(chatId, msg.content);
        setSetting(db, CURSOR, String(msg.seq));
      }
    },
  };
}
