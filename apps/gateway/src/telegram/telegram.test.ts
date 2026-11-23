import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendMessage,
  createPairingCode,
  type Db,
  getSetting,
  getThread,
  homePaths,
  isPaused,
  listMessages,
  openCoreDatabase,
} from "@achords/core";
import { createProject } from "@achords/policy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Transcriber } from "../voice/transcribe.ts";
import { createTelegramChannel, type TelegramChannel } from "./telegram.ts";

const TOKEN = "123456789:AAH-TestTokenTestTokenTestToken0123";
const OWNER = 1001;

interface Sent {
  chat_id: number;
  text: string;
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
}

/** Minimal fake of the Bot API: queued updates for getUpdates, records sendMessage. */
function fakeTelegram() {
  const queue: unknown[] = [];
  const sent: Sent[] = [];
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let nextId = 1;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const multipart = (req.headers["content-type"] ?? "").startsWith("multipart/form-data");
    const body = multipart ? { multipart: raw } : chunks.length ? JSON.parse(raw) : {};
    const method = req.url?.split("/").pop();
    if (req.url === `/file/bot${TOKEN}/voice/file_1.oga`) {
      calls.push({ method: "download", body: {} });
      res.end("OGG-BYTES");
      return;
    }
    if (method === "getFile") {
      calls.push({ method, body });
      res.end(JSON.stringify({ ok: true, result: { file_path: "voice/file_1.oga" } }));
      return;
    }
    if (!req.url?.startsWith(`/bot${TOKEN}/`)) {
      res.writeHead(401).end(JSON.stringify({ ok: false }));
      return;
    }
    if (method === "getUpdates") {
      const offset = body.offset ?? 0;
      const ready = queue.filter((u) => (u as { update_id: number }).update_id >= offset);
      res.end(JSON.stringify({ ok: true, result: ready }));
      return;
    }
    if (
      method === "answerCallbackQuery" ||
      method === "editMessageReplyMarkup" ||
      method === "sendVoice"
    ) {
      calls.push({ method, body });
      res.end(JSON.stringify({ ok: true, result: true }));
      return;
    }
    if (method === "sendMessage") {
      sent.push({
        chat_id: body.chat_id,
        text: body.text,
        ...(body.reply_markup ? { reply_markup: body.reply_markup } : {}),
      });
      res.end(JSON.stringify({ ok: true, result: {} }));
      return;
    }
    res.writeHead(404).end();
  });
  const msg = (from: number, text: string, chatType = "private", chatId = from) => {
    queue.push({
      update_id: nextId++,
      message: {
        message_id: nextId,
        from: { id: from },
        chat: { id: chatId, type: chatType },
        text,
      },
    });
  };
  const voice = (from: number, duration = 5) => {
    queue.push({
      update_id: nextId++,
      message: {
        message_id: nextId,
        from: { id: from },
        chat: { id: from, type: "private" },
        voice: { file_id: "f1", duration, file_size: 9 },
      },
    });
  };
  const photo = (from: number, caption?: string, size = 9) => {
    queue.push({
      update_id: nextId++,
      message: {
        message_id: nextId,
        from: { id: from },
        chat: { id: from, type: "private" },
        ...(caption ? { caption } : {}),
        photo: [
          { file_id: "small", file_size: 1 },
          { file_id: "f1", file_size: size },
        ],
      },
    });
  };
  const press = (from: number, data: string, chatType = "private") => {
    queue.push({
      update_id: nextId++,
      callback_query: {
        id: `cb${nextId}`,
        from: { id: from },
        data,
        message: { message_id: 77, chat: { id: from, type: chatType } },
      },
    });
  };
  return { server, sent, msg, press, voice, photo, queue, calls };
}

describe("telegram channel", () => {
  let home: string;
  let db: Db;
  let tg: ReturnType<typeof fakeTelegram>;
  let channel: TelegramChannel;
  let logs: string[];
  let handled: { threadId: string; text: string }[];
  let stopped: string[];
  let decided: string[];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "achords-tg-"));
    db = openCoreDatabase(join(home, "core.db"));
    tg = fakeTelegram();
    await new Promise<void>((r) => tg.server.listen(0, "127.0.0.1", r));
    logs = [];
    handled = [];
    stopped = [];
    decided = [];
    channel = createTelegramChannel({
      db,
      paths: homePaths(home),
      token: TOKEN,
      apiBase: `http://127.0.0.1:${(tg.server.address() as AddressInfo).port}`,
      pollTimeoutS: 0,
      orchestrator: {
        // Same contract as the orchestrator: proposal:<verb>:<id> → message.
        runAction: (data) => {
          const m = /^proposal:(approve|reject):(.+)$/.exec(data);
          if (!m) return { ok: false, message: "Unknown action." };
          decided.push(`${m[2]}:${m[1] === "approve"}`);
          return m[2] === "abc123"
            ? {
                ok: true,
                message: `${m[1] === "approve" ? "Approved" : "Rejected"}: agent tester.`,
              }
            : { ok: false, message: "no pending proposal" };
        },
        handleMessage: async (threadId, text) => {
          handled.push({ threadId, text });
          appendMessage(db, {
            threadId,
            role: "agent",
            author: "boss",
            channel: "system",
            content: `re: ${text}`,
          });
          return "answer";
        },
      },
      onEmergencyStop: (lines) => stopped.push(...lines),
      log: (m) => logs.push(m),
    });
  });
  afterEach(async () => {
    await new Promise((r) => tg.server.close(r));
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const pairOwner = async () => {
    tg.msg(OWNER, `/pair ${createPairingCode(db, "telegram")}`);
    await channel.pollOnce();
  };

  it("pairs the owner by user id with a one-time code", async () => {
    await pairOwner();
    expect(getSetting(db, "telegram.owner_user_id")).toBe(String(OWNER));
    expect(tg.sent).toEqual([{ chat_id: OWNER, text: expect.stringMatching(/paired/i) }]);
  });

  it("silently ignores unknown users, wrong codes and group chats (log line only)", async () => {
    await pairOwner();
    tg.sent.length = 0;
    tg.msg(2002, "hello?");
    tg.msg(2002, "/pair AAAA-AAAA");
    tg.msg(OWNER, "in a group", "group", -500);
    await channel.pollOnce();
    expect(tg.sent).toEqual([]);
    expect(handled).toEqual([]);
    expect(getSetting(db, "telegram.owner_user_id")).toBe(String(OWNER));
    expect(logs.join("\n")).toMatch(/ignored.*2002/);
    expect(logs.join("\n")).toMatch(/ignored.*group/);
  });

  it("ignores everything, even from the owner's id, before pairing", async () => {
    tg.msg(OWNER, "hi");
    await channel.pollOnce();
    expect(handled).toEqual([]);
    expect(tg.sent).toEqual([]);
  });

  it("routes owner messages to the boss and delivers agent replies back (quiet: no echo of own text)", async () => {
    await pairOwner();
    tg.sent.length = 0;
    tg.msg(OWNER, "csinálj egy TODO-t");
    await channel.pollOnce();
    expect(handled).toHaveLength(1);
    await channel.deliver();
    expect(tg.sent).toEqual([{ chat_id: OWNER, text: "re: csinálj egy TODO-t" }]);
    await channel.deliver();
    expect(tg.sent).toHaveLength(1);

    // Same thread continues; /new starts a fresh one.
    tg.msg(OWNER, "és még valami");
    tg.msg(OWNER, "/new");
    tg.msg(OWNER, "új téma");
    await channel.pollOnce();
    expect(handled[1]?.threadId).toBe(handled[0]?.threadId);
    expect(handled[2]?.threadId).not.toBe(handled[0]?.threadId);
  });

  it("does not reprocess updates (offset persists)", async () => {
    await pairOwner();
    tg.msg(OWNER, "once");
    await channel.pollOnce();
    await channel.pollOnce();
    expect(handled.map((h) => h.text)).toEqual(["once"]);
  });

  it("/local makes the current thread local-only (one way)", async () => {
    await pairOwner();
    tg.sent.length = 0;
    tg.msg(OWNER, "x");
    tg.msg(OWNER, "/local");
    await channel.pollOnce();
    const threadId = getSetting(db, "telegram.thread_id") as string;
    expect(getThread(db, threadId)?.sensitivity).toBe("local-only");
    expect(tg.sent.at(-1)?.text).toMatch(/local-only/);
  });

  it("notify puts a note into the owner's thread; it is delivered like any agent message", async () => {
    await pairOwner();
    tg.sent.length = 0;
    channel.notify("Heads-up: quota at 82%");
    await channel.deliver();
    expect(tg.sent).toEqual([{ chat_id: OWNER, text: "Heads-up: quota at 82%" }]);
    const threadId = getSetting(db, "telegram.thread_id") as string;
    expect(listMessages(db, threadId).at(-1)).toMatchObject({
      author: "system",
      content: "Heads-up: quota at 82%",
    });
  });

  it("/project shows, sets and clears the current thread's project", async () => {
    createProject(join(home, "projects"), {
      slug: "acme",
      name: "Acme shop",
      workspace: "web-clients",
    });
    await pairOwner();
    tg.sent.length = 0;
    tg.msg(OWNER, "x");
    tg.msg(OWNER, "/project");
    tg.msg(OWNER, "/project acme");
    tg.msg(OWNER, "/project nope");
    await channel.pollOnce();
    const threadId = getSetting(db, "telegram.thread_id") as string;
    expect(getThread(db, threadId)?.project).toBe("acme");
    expect(tg.sent.map((s) => s.text)).toEqual([
      expect.stringMatching(/acme.*Acme shop[\s\S]*Current: none/),
      expect.stringMatching(/Acme shop \(acme\)/),
      expect.stringMatching(/No project nope/),
    ]);
    tg.msg(OWNER, "/project none");
    await channel.pollOnce();
    expect(getThread(db, threadId)?.project).toBeNull();
  });

  it("/approve and /reject decide agent proposals, for the owner only", async () => {
    await pairOwner();
    tg.sent.length = 0;
    tg.msg(2002, "/approve abc123");
    tg.msg(OWNER, "/approve abc123");
    tg.msg(OWNER, "/reject nope");
    await channel.pollOnce();
    expect(decided).toEqual(["abc123:true", "nope:false"]);
    expect(tg.sent.map((s) => s.text)).toEqual([
      expect.stringMatching(/approved.*tester/i),
      expect.stringMatching(/no pending proposal/),
    ]);
  });

  it("sends a long agent message in parts at line breaks, buttons on the last part only", async () => {
    await pairOwner();
    tg.sent.length = 0;
    const threadId = getSetting(db, "telegram.thread_id") as string;
    const para = `${"x".repeat(1500)}\n`;
    const content = `${para.repeat(6)}end`;
    appendMessage(db, {
      threadId,
      role: "agent",
      author: "dev",
      channel: "system",
      content,
      actions: [{ label: "OK", data: "proposal:approve:abc" }],
    });
    await channel.deliver();
    expect(tg.sent.length).toBeGreaterThan(1);
    for (const s of tg.sent) expect(s.text.length).toBeLessThanOrEqual(4000);
    expect(tg.sent.map((s) => s.text).join("\n")).toBe(content);
    expect(tg.sent.slice(0, -1).every((s) => !s.reply_markup)).toBe(true);
    expect(tg.sent.at(-1)?.reply_markup).toBeDefined();
  });

  it("delivers message actions as buttons and acts on the owner's press only", async () => {
    await pairOwner();
    tg.sent.length = 0;
    const threadId = getSetting(db, "telegram.thread_id") as string;
    appendMessage(db, {
      threadId,
      role: "agent",
      author: "dev",
      channel: "system",
      content: "dev proposes a new agent 'tester'",
      actions: [
        { label: "✅ Approve", data: "proposal:approve:abc123" },
        { label: "❌ Reject", data: "proposal:reject:abc123" },
      ],
    });
    await channel.deliver();
    expect(tg.sent[0]?.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: "proposal:approve:abc123" },
          { text: "❌ Reject", callback_data: "proposal:reject:abc123" },
        ],
      ],
    });

    tg.press(2002, "proposal:approve:abc123"); // someone else: ignored silently
    tg.press(OWNER, "proposal:approve:abc123");
    await channel.pollOnce();
    expect(decided).toEqual(["abc123:true"]);
    // The press is acknowledged and the buttons removed, so it cannot be pressed twice.
    expect(tg.calls.map((c) => c.method)).toEqual([
      "answerCallbackQuery",
      "editMessageReplyMarkup",
    ]);
    expect(tg.calls[1]?.body).toMatchObject({
      message_id: 77,
      reply_markup: { inline_keyboard: [] },
    });
    expect(tg.sent.at(-1)?.text).toMatch(/Approved: agent tester/);
  });

  it("read aloud: a button under agent messages answers with a voice note made locally", async () => {
    const spoken: string[] = [];
    const ch = createTelegramChannel({
      db,
      paths: homePaths(home),
      token: TOKEN,
      apiBase: `http://127.0.0.1:${(tg.server.address() as AddressInfo).port}`,
      pollTimeoutS: 0,
      orchestrator: {
        runAction: () => ({ ok: false, message: "-" }),
        handleMessage: async () => "answer" as const,
      },
      onEmergencyStop: () => {},
      log: () => {},
      speaker: {
        speak: async (text) => {
          spoken.push(text);
          const path = join(home, "reply.ogg");
          writeFileSync(path, "OPUS-BYTES");
          return { ok: true, path };
        },
      },
    });
    tg.msg(OWNER, `/pair ${createPairingCode(db, "telegram")}`);
    await ch.pollOnce();
    tg.sent.length = 0;
    const threadId = getSetting(db, "telegram.thread_id") as string;
    const msg = appendMessage(db, {
      threadId,
      role: "agent",
      author: "web-dev",
      channel: "system",
      content: "A commit elkészült.",
      actions: [{ label: "✅ This task", data: "cmd:task:ab12" }],
    });
    await ch.deliver();
    expect(tg.sent[0]?.reply_markup?.inline_keyboard).toEqual([
      [{ text: "✅ This task", callback_data: "cmd:task:ab12" }],
      [{ text: "🔊 Read aloud", callback_data: `tts:${msg.seq}` }],
    ]);
    tg.press(2002, `tts:${msg.seq}`); // someone else: nothing is made
    tg.press(OWNER, `tts:${msg.seq}`);
    await ch.pollOnce();
    expect(spoken).toEqual(["A commit elkészült."]);
    // Acknowledged, the voice note sent, the buttons kept (it is not a decision).
    expect(tg.calls.map((c) => c.method)).toEqual(["answerCallbackQuery", "sendVoice"]);
    expect(String(tg.calls[1]?.body.multipart)).toContain("OPUS-BYTES");
    expect(existsSync(join(home, "reply.ogg"))).toBe(false);
  });

  it("without a speaker there is no read-aloud button", async () => {
    await pairOwner();
    tg.sent.length = 0;
    const threadId = getSetting(db, "telegram.thread_id") as string;
    appendMessage(db, {
      threadId,
      role: "agent",
      author: "boss",
      channel: "system",
      content: "hi",
    });
    await channel.deliver();
    expect(tg.sent[0]?.reply_markup).toBeUndefined();
  });

  it("photos: stored for the chat, the caption and an image line go to the orchestrator", async () => {
    await pairOwner();
    tg.photo(2002, "not the owner"); // nothing is downloaded for strangers
    tg.photo(OWNER, "Ez a hiba a pénztárban");
    await channel.pollOnce();
    expect(tg.calls.filter((c) => c.method === "getFile").map((c) => c.body.file_id)).toEqual([
      "f1",
    ]);
    const last = handled.at(-1)?.text ?? "";
    const path = /\[image: (\S+)\]$/.exec(last)?.[1] as string;
    expect(last.startsWith("Ez a hiba a pénztárban\n\n[image: ")).toBe(true);
    expect(path.startsWith(join(home, "attachments"))).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("OGG-BYTES");
    expect(path.endsWith(".jpg")).toBe(true);
  });

  describe("voice notes", () => {
    const withTranscriber = (t: Transcriber | undefined) =>
      createTelegramChannel({
        db,
        paths: homePaths(home),
        token: TOKEN,
        apiBase: `http://127.0.0.1:${(tg.server.address() as AddressInfo).port}`,
        pollTimeoutS: 0,
        orchestrator: {
          runAction: () => ({ ok: false, message: "x" }),
          handleMessage: async (threadId, text) => {
            handled.push({ threadId, text });
            return "answer";
          },
        },
        onEmergencyStop: () => {},
        log: (m) => logs.push(m),
        ...(t ? { transcriber: t } : {}),
      });

    it("transcribes the owner's voice note locally and handles it like text", async () => {
      await pairOwner();
      const seenFiles: string[] = [];
      const ch = withTranscriber({
        available: () => ({ ok: true }),
        transcribe: async (path) => {
          seenFiles.push(readFileSync(path, "utf8"));
          return { ok: true, text: "csinálj egy listát" };
        },
      });
      tg.voice(OWNER);
      await ch.pollOnce().catch((e) => logs.push(`ERR ${e.message}`));
      console.log(
        "DEBUG",
        logs,
        tg.calls.map((c) => c.method),
      );
      expect(seenFiles).toEqual(["OGG-BYTES"]);
      expect(handled.map((h) => h.text)).toEqual(["csinálj egy listát"]);
      // The downloaded audio does not stay on disk.
      expect(readdirSync(homePaths(home).runDir).filter((f) => f.startsWith("voice-"))).toEqual([]);
    });

    it("never downloads voice notes from anyone else", async () => {
      await pairOwner();
      tg.calls.length = 0;
      const ch = withTranscriber({
        available: () => ({ ok: true }),
        transcribe: async () => ({ ok: true, text: "x" }),
      });
      tg.voice(2002);
      await ch.pollOnce();
      expect(tg.calls.filter((c) => c.method === "getFile" || c.method === "download")).toEqual([]);
      expect(handled).toEqual([]);
    });

    it("explains when Whisper is missing, the note is too long, or nothing was recognised", async () => {
      await pairOwner();
      tg.sent.length = 0;
      tg.voice(OWNER);
      await withTranscriber(undefined).pollOnce();
      tg.voice(OWNER, 700);
      await withTranscriber({
        available: () => ({ ok: true }),
        transcribe: async () => ({ ok: true, text: "x" }),
      }).pollOnce();
      tg.voice(OWNER);
      await withTranscriber({
        available: () => ({ ok: true }),
        transcribe: async () => ({ ok: false, reason: "no speech recognised" }),
      }).pollOnce();
      expect(tg.sent.map((s) => s.text)).toEqual([
        expect.stringMatching(/local Whisper.*achords doctor/),
        expect.stringMatching(/too long.*10 min/),
        expect.stringMatching(/no speech recognised/),
      ]);
      expect(handled).toEqual([]);
    });
  });

  it("/stop from the owner performs the emergency stop", async () => {
    await pairOwner();
    tg.sent.length = 0;
    tg.msg(OWNER, "/stop");
    await channel.pollOnce();
    expect(existsSync(homePaths(home).stopFile)).toBe(true);
    expect(isPaused(db)).toBe(true);
    expect(stopped).toContain("queue paused");
    expect(tg.sent[0]?.text).toMatch(/emergency stop/i);
  });

  it("/stop from anyone else does nothing", async () => {
    await pairOwner();
    tg.msg(2002, "/stop");
    await channel.pollOnce();
    expect(existsSync(homePaths(home).stopFile)).toBe(false);
    expect(isPaused(db)).toBe(false);
  });

  it("never logs the bot token, even on network errors", async () => {
    const broken = createTelegramChannel({
      db,
      paths: homePaths(home),
      token: TOKEN,
      apiBase: "http://127.0.0.1:1",
      pollTimeoutS: 0,
      orchestrator: {
        handleMessage: async () => "answer",
        runAction: () => ({ ok: false, message: "x" }),
      },
      onEmergencyStop: () => {},
      log: (m) => logs.push(m),
    });
    await expect(broken.pollOnce()).rejects.toThrow();
    await broken.pollOnce().catch((err: Error) => logs.push(err.message));
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(TOKEN.split(":")[1]);
  });

  it("keeps a single thread mapping in the core thread model", async () => {
    await pairOwner();
    tg.msg(OWNER, "x");
    await channel.pollOnce();
    const threadId = getSetting(db, "telegram.thread_id") as string;
    expect(handled[0]?.threadId).toBe(threadId);
    // The boss reply lands in that same core thread (visible on the web too).
    expect(listMessages(db, threadId).map((m) => m.content)).toContain("re: x");
  });
});
