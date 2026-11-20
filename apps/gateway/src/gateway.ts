import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  appendMessage,
  homePaths,
  isPaused,
  listThreads,
  openCoreDatabase,
  readLivePid,
  setDraining,
  setSetting,
} from "@achords/core";
import { ollamaEmbedder, openMemory } from "@achords/memory";
import { cliClaude, localOpenAI } from "@achords/providers";
import { createRedactor, openHomeVault, type Vault } from "@achords/secrets";
import { createApiHandler } from "./http/api.ts";
import { createRunTokens } from "./mcp/tokens.ts";
import { createOrchestrator } from "./orchestrator/orchestrator.ts";
import { seedAgents, seedSchedules } from "./orchestrator/seed.ts";
import { createTelegramChannel, type TelegramChannel } from "./telegram/telegram.ts";
import { whisperTranscriber } from "./voice/transcribe.ts";

export const HEARTBEAT_KEY = "gateway.heartbeat";
const TICK_MS = 1000;
// Upper bound for a cancelled run to finish killing its process group on shutdown.
const SHUTDOWN_WAIT_MS = 5000;
const SEED_AGENTS = new URL("../../../seed/agents/", import.meta.url).pathname;
const SEED_SCHEDULES = new URL("../../../seed/schedules/", import.meta.url).pathname;
const HUB_MCP_SERVER = new URL("./mcp/server.ts", import.meta.url).pathname;
const WEB_DIST = new URL("../../web/dist/", import.meta.url).pathname;
const DEFAULT_PORT = 7420;
const TELEGRAM_TOKEN_ID = "telegram.bot-token";
const POLL_BACKOFF_MAX_MS = 60_000;
const BACKFILL_EVERY_TICKS = 60;

const log = (msg: string) => console.log(`${new Date().toISOString()} gateway: ${msg}`);

/**
 * Runs until SIGTERM/SIGINT or until the STOP marker appears. Every "won't run" path exits 0:
 * the launchd job uses KeepAlive.SuccessfulExit=false, so only crashes are respawned.
 */
export function runGateway(home: string): Promise<number> {
  const paths = homePaths(home);
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });

  if (existsSync(paths.stopFile)) {
    log("emergency stop is active; run `achords resume` to clear it");
    return Promise.resolve(0);
  }
  const other = readLivePid(paths.pidFile);
  if (other !== undefined && other !== process.pid) {
    log(`already running (pid ${other})`);
    return Promise.resolve(0);
  }
  const db = openCoreDatabase(paths.db);
  const seeded = seedAgents(SEED_AGENTS, join(home, "agents"), home);
  if (seeded.length) log(`seeded agents: ${seeded.join(", ")}`);
  // Lazy: the master key (Keychain) is only touched once a secret is stored or needed.
  let vault: Vault | undefined;
  const getVault = () => {
    vault ??= openHomeVault(home);
    return vault;
  };
  const patternsOnly = createRedactor([]);
  const redact = (text: string) =>
    existsSync(paths.vaultDb) ? getVault().redactor()(text) : patternsOnly(text);

  // Embeddings come from the local Ollama only; without it memory falls back to keyword search.
  const embedder = ollamaEmbedder();
  const memory = openMemory(paths.memoryDb, { dims: embedder.dims });

  // The hub MCP server's URL is known once the API listens (port 0 in tests).
  const runTokens = createRunTokens();
  const hub = { url: "", tokens: runTokens, serverEntry: HUB_MCP_SERVER };

  const orchestrator = createOrchestrator({
    db,
    home,
    hub,
    memory,
    embedder,
    providers: {
      "cli-claude": cliClaude(),
      // Manifest models "local/<name>" (ADR-0006); ACHORDS_LOCAL_URL points at mlx-lm etc.
      local: localOpenAI(
        process.env.ACHORDS_LOCAL_URL ? { baseUrl: process.env.ACHORDS_LOCAL_URL } : {},
      ),
    },
    redact,
    // Quota warnings etc.: the owner's Telegram thread (web shows it too), else the latest chat.
    notify: (text) => {
      log(`notify: ${text}`);
      if (telegram) return telegram.notify(text);
      const latest = listThreads(db, 1)[0];
      if (latest) {
        appendMessage(db, {
          threadId: latest.id,
          role: "agent",
          author: "system",
          channel: "system",
          content: text,
        });
      }
    },
  });
  // A previous `achords stop` may have left the drain flag; a new gateway works normally.
  setDraining(db, false);
  orchestrator.syncAgents();
  const seededSchedules = seedSchedules(SEED_SCHEDULES, db);
  if (seededSchedules.length)
    log(`seeded schedules (off until enabled): ${seededSchedules.join(", ")}`);

  // Voice notes (Telegram and web) are transcribed on this machine (ADR-0014).
  const transcriber = whisperTranscriber({
    model: process.env.ACHORDS_WHISPER_MODEL ?? paths.whisperModel,
    workDir: paths.runDir,
  });

  // Telegram runs only when its bot token is in the vault.
  let telegram: TelegramChannel | undefined;
  if (existsSync(paths.vaultDb) && getVault().status(TELEGRAM_TOKEN_ID).set) {
    telegram = createTelegramChannel({
      db,
      paths,
      token: getVault().resolve(TELEGRAM_TOKEN_ID, "gateway"),
      orchestrator,
      onEmergencyStop: (lines) => log(`emergency stop via Telegram: ${lines.join("; ")}`),
      transcriber,
      log,
    });
  }

  // Loopback only; remote access goes through a local HTTPS proxy (tailscale serve).
  const port = Number(process.env.ACHORDS_PORT ?? DEFAULT_PORT);
  const server = createServer();

  return new Promise((resolve) => {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let working: Promise<unknown> | undefined;
    let delivering = false;
    let ticks = 0;
    const cancel = new AbortController();
    const shutdown = async (reason: string) => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      // Cancel the in-flight agent run and let it kill its process group before we exit.
      cancel.abort();
      if (working) {
        await Promise.race([working, new Promise((r) => setTimeout(r, SHUTDOWN_WAIT_MS))]);
      }
      server.close();
      vault?.close();
      memory.close();
      db.close();
      // Only remove our own pidfile; a successor may already have written its own.
      if (readLivePid(paths.pidFile) === process.pid) rmSync(paths.pidFile, { force: true });
      log(`stopped (${reason})`);
      resolve(0);
    };
    const tick = () => {
      if (stopped) return;
      if (existsSync(paths.stopFile)) return shutdown("stop marker");
      setSetting(db, HEARTBEAT_KEY, String(Date.now()));
      if (++ticks % BACKFILL_EVERY_TICKS === 0 && memory.pendingEmbeddings() > 0) {
        memory.backfill(embedder).catch(() => {});
      }
      if (telegram && !delivering) {
        delivering = true;
        telegram
          .deliver()
          .catch((err) => log((err as Error).message))
          .finally(() => {
            delivering = false;
          });
      }
      // Scheduler (ADR-0033): due schedules become queued tasks; the worker below runs them.
      if (!isPaused(db)) {
        try {
          orchestrator.runDueSchedules();
        } catch (err) {
          log(`scheduler error: ${(err as Error).message}`);
        }
      }
      if (!working) {
        working = orchestrator
          .workOnce(cancel.signal)
          .catch((err) => log(`worker error: ${(err as Error).message}`))
          .finally(() => {
            working = undefined;
          });
      }
    };
    const onTerm = () => shutdown("SIGTERM");
    const onInt = () => shutdown("SIGINT");
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    server.on("error", (err) => {
      log(`http server error: ${err.message}`);
      process.exitCode = 1;
      void shutdown("http server error");
    });
    server.listen(port, "127.0.0.1", () => {
      const actual = (server.address() as { port: number }).port;
      hub.url = `http://127.0.0.1:${actual}`;
      server.on(
        "request",
        createApiHandler({
          db,
          orchestrator,
          vault: getVault,
          runTokens,
          agentsDir: join(home, "agents"),
          projectsDir: paths.projectsDir,
          transcriber,
          runDir: paths.runDir,
          // Suggestions only: chat models pulled in Ollama (embedding models filtered out).
          localModels: async () => {
            const res = await fetch("http://127.0.0.1:11434/api/tags", {
              signal: AbortSignal.timeout(1500),
            });
            const body = (await res.json()) as { models?: { name: string }[] };
            return (body.models ?? [])
              .map((m) => m.name.replace(/:latest$/, ""))
              .filter((n) => !/embed|bge|minilm/i.test(n));
          },
          allowedHosts: [`127.0.0.1:${actual}`, `localhost:${actual}`],
          staticDir: WEB_DIST,
          log,
        }),
      );
      // Pidfile last: once it is visible, `achords stop` may SIGTERM us, so handlers must be ready.
      writeFileSync(paths.pidFile, String(process.pid), { mode: 0o600 });
      log(`started (pid ${process.pid}, home ${home}, http://127.0.0.1:${actual})`);
      timer = setInterval(tick, TICK_MS);
      tick();
      if (telegram) void pollLoop(telegram);
    });

    async function pollLoop(channel: TelegramChannel) {
      log("telegram: polling");
      let backoff = 1000;
      while (!stopped) {
        try {
          await channel.pollOnce(cancel.signal);
          backoff = 1000;
        } catch (err) {
          if (stopped) return;
          log((err as Error).message);
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, POLL_BACKOFF_MAX_MS);
        }
      }
    }
  });
}
