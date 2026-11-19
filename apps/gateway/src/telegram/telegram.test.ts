import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTelegramChannel, type TelegramChannel } from "./telegram.ts";

const TOKEN = "123456789:AAH-TestTokenTestTokenTestToken0123";
const OWNER = 1001;

interface Sent {
  chat_id: number;
  text: string;
}

/** Minimal fake of the Bot API: queued updates for getUpdates, records sendMessage. */
function fakeTelegram() {
  const queue: unknown[] = [];
  const sent: Sent[] = [];
  let nextId = 1;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const method = req.url?.split("/").pop();
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
    if (method === "sendMessage") {
      sent.push({ chat_id: body.chat_id, text: body.text });
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
  return { server, sent, msg, queue };
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
        decideProposal: (id, approve) => {
          decided.push(`${id}:${approve}`);
          return id === "abc123"
            ? { ok: true, agentId: "tester" }
            : { ok: false, reason: "no pending proposal" };
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
        decideProposal: () => ({ ok: false, reason: "x" }),
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
