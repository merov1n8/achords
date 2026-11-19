import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { homePaths, openCoreDatabase, readLivePid, setSetting } from "@achords/core";
import { cliClaude } from "@achords/providers";
import { createRedactor, openHomeVault, type Vault } from "@achords/secrets";
import { createApiHandler } from "./http/api.ts";
import { createOrchestrator } from "./orchestrator/orchestrator.ts";
import { seedAgents } from "./orchestrator/seed.ts";
import { createTelegramChannel, type TelegramChannel } from "./telegram/telegram.ts";

export const HEARTBEAT_KEY = "gateway.heartbeat";
const TICK_MS = 1000;
// Upper bound for a cancelled run to finish killing its process group on shutdown.
const SHUTDOWN_WAIT_MS = 5000;
const SEED_AGENTS = new URL("../../../seed/agents/", import.meta.url).pathname;
const DEFAULT_PORT = 7420;
const TELEGRAM_TOKEN_ID = "telegram.bot-token";
const POLL_BACKOFF_MAX_MS = 60_000;

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

  const orchestrator = createOrchestrator({
    db,
    home,
    providers: { "cli-claude": cliClaude() },
    redact,
  });
  orchestrator.syncAgents();

  // Telegram runs only when its bot token is in the vault.
  let telegram: TelegramChannel | undefined;
  if (existsSync(paths.vaultDb) && getVault().status(TELEGRAM_TOKEN_ID).set) {
    telegram = createTelegramChannel({
      db,
      paths,
      token: getVault().resolve(TELEGRAM_TOKEN_ID, "gateway"),
      orchestrator,
      onEmergencyStop: (lines) => log(`emergency stop via Telegram: ${lines.join("; ")}`),
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
      if (telegram && !delivering) {
        delivering = true;
        telegram
          .deliver()
          .catch((err) => log((err as Error).message))
          .finally(() => {
            delivering = false;
          });
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
      server.on(
        "request",
        createApiHandler({
          db,
          orchestrator,
          vault: getVault,
          allowedHosts: [`127.0.0.1:${actual}`, `localhost:${actual}`],
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
