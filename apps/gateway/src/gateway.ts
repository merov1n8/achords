import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendMessage,
  getSetting,
  homePaths,
  isPaused,
  listActiveRuns,
  listThreads,
  openCoreDatabase,
  readLivePid,
  setDraining,
  setSetting,
} from "@achords/core";
import { ollamaEmbedder, openMemory } from "@achords/memory";
import {
  integrationStatus,
  loadAgents,
  loadCatalog,
  loadProjects,
  ownProject,
} from "@achords/policy";
import { CODEX_API_KEY_ENV, cliClaude, cliCodex, localOpenAI } from "@achords/providers";
import { createRedactor, openHomeVault, type Vault } from "@achords/secrets";
import { createApiHandler } from "./http/api.ts";
import { callTool } from "./mcp/call.ts";
import { createMcpTickets, createRunTokens } from "./mcp/tokens.ts";
import { runMonitors } from "./monitors.ts";
import { createOrchestrator } from "./orchestrator/orchestrator.ts";
import { seedAgents, seedSchedules } from "./orchestrator/seed.ts";
import { createTelegramChannel, type TelegramChannel } from "./telegram/telegram.ts";
import {
  AUTO_KEY,
  autoUpdate,
  LAST_KEY,
  READY_KEY,
  reportAfterRestart,
  type UpdaterDeps,
  updateTick,
} from "./updater.ts";
import { whisperTranscriber } from "./voice/transcribe.ts";

export const HEARTBEAT_KEY = "gateway.heartbeat";
const TICK_MS = 1000;
// Upper bound for a cancelled run to finish killing its process group on shutdown.
const SHUTDOWN_WAIT_MS = 5000;
const SEED_AGENTS = new URL("../../../seed/agents/", import.meta.url).pathname;
const SEED_SCHEDULES = new URL("../../../seed/schedules/", import.meta.url).pathname;
const HUB_MCP_SERVER = new URL("./mcp/server.ts", import.meta.url).pathname;
const MCP_LAUNCHER = new URL("./mcp/launch.ts", import.meta.url).pathname;
const BUILTIN_MCP = { wordpress: new URL("./mcp/wordpress.ts", import.meta.url).pathname };
const SEED_CATALOG = new URL("../../../seed/catalog/", import.meta.url).pathname;
// Phase 4 providers: vault key and the variable each official CLI reads in API mode.
export const BILLING: Record<string, { label: string; key: string; env: string }> = {
  "cli-claude": { label: "Claude", key: "anthropic-api-key", env: "ANTHROPIC_API_KEY" },
  "cli-codex": { label: "OpenAI", key: "openai-api-key", env: CODEX_API_KEY_ENV },
  "cli-gemini": { label: "Google Gemini", key: "gemini-api-key", env: "GEMINI_API_KEY" },
};

// launchd names the job in XPC_SERVICE_NAME, our systemd unit sets ACHORDS_SERVICE: only the
// installed service auto-updates (never tests, CI or a gateway started by hand).
const AS_SERVICE =
  process.env.XPC_SERVICE_NAME === "dev.achords.gateway" || process.env.ACHORDS_SERVICE === "1";
// The git checkout this gateway runs from (auto-update pulls into it).
const REPO = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
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
  const mcpTickets = createMcpTickets();

  // Quota warnings, monitors etc.: the owner's Telegram thread (web shows it too), else the
  // latest chat. `telegram` is assigned below, before the first tick.
  const notifyOwner = (text: string) => {
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
  };

  const updaterDeps: UpdaterDeps = {
    db,
    repo: REPO,
    running: (() => {
      try {
        return execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      } catch {
        return undefined;
      }
    })(),
    // pnpm next to this Node (the service PATH may not have it), git from the system.
    pnpm: join(dirname(process.execPath), "pnpm"),
    node: process.execPath,
    exec: (cmd, args, opts) =>
      new Promise((done) => {
        execFile(
          cmd,
          args,
          {
            timeout: opts?.timeoutMs ?? 60_000,
            maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
          },
          (err, stdout, stderr) =>
            done({
              code: err ? Number((err as { code?: number }).code ?? 1) || 1 : 0,
              out: `${stdout}${stderr}`,
            }),
        );
      }),
    fetchJson: async (url) => {
      const res = await fetch(url, {
        headers: { accept: "application/vnd.github+json", "user-agent": "achords-updater" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      return res.json();
    },
    isIdle: () =>
      listActiveRuns(db).length === 0 &&
      !db.prepare("SELECT 1 FROM tasks WHERE status = 'claimed' LIMIT 1").get(),
    notify: (text) => notifyOwner(text),
    exit: (code) => {
      void stopForUpdate?.(code);
    },
  };
  let stopForUpdate: ((code: number) => Promise<void>) | undefined;

  // Phase 4: subscription or API key per provider; the key goes only to that run's CLI.
  const billing = (provider: string) => {
    const p = BILLING[provider];
    if (!p || getSetting(db, `billing.${provider}`) !== "api")
      return { mode: "subscription" as const };
    if (!existsSync(paths.vaultDb) || !getVault().status(p.key).set) {
      throw new Error(`API mode for ${p.label} needs its API key (Settings → Model access)`);
    }
    return {
      mode: "api" as const,
      env: { [p.env]: getVault().resolve(p.key, `provider:${provider}`) },
    };
  };

  const orchestrator = createOrchestrator({
    billing,
    db,
    home,
    hub,
    integrations: {
      // Read per run: catalog edits apply to the next run without a restart.
      catalog: () => loadCatalog(SEED_CATALOG, join(home, "catalog")),
      tickets: mcpTickets,
      launcherEntry: MCP_LAUNCHER,
      builtins: BUILTIN_MCP,
      resolveSecret: (ref, actor) => getVault().resolveRef(ref, actor),
      // Owner-approved publishing: the same launcher, with a fresh one-time ticket.
      call: (launch, tool, args) => {
        const { ticket, revoke } = mcpTickets.issue(launch);
        return callTool(
          {
            command: process.execPath,
            args: ["--disable-warning=ExperimentalWarning", MCP_LAUNCHER],
            env: { ACHORDS_HUB_URL: hub.url, ACHORDS_MCP_TICKET: ticket },
          },
          tool,
          args,
        ).finally(revoke);
      },
    },
    memory,
    embedder,
    providers: {
      "cli-claude": cliClaude(),
      // Manifest models "local/<name>" (ADR-0006); ACHORDS_LOCAL_URL points at mlx-lm etc.
      // OpenAI models through the official codex CLI (ADR-0040).
      "cli-codex": cliCodex(),
      local: localOpenAI(
        process.env.ACHORDS_LOCAL_URL ? { baseUrl: process.env.ACHORDS_LOCAL_URL } : {},
      ),
    },
    redact,
    notify: (text) => notifyOwner(text),
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
    let monitoring = false;
    let updating = false;
    let ticks = 0;
    const cancel = new AbortController();
    const shutdown = async (reason: string, code = 0) => {
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
      resolve(code);
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
      // Auto-update from main (owner decision): hourly check, applied when nothing is running.
      // Only the installed service updates itself; tests and manual runs never touch the repo.
      if (AS_SERVICE && !updating) {
        updating = true;
        updateTick(updaterDeps)
          .catch((err) => log(`update error: ${(err as Error).message}`))
          .finally(() => {
            updating = false;
          });
      }
      // Heartbeat monitors (ADR-0039): cheap checks, one pass at a time.
      if (!monitoring) {
        monitoring = true;
        runMonitors({
          db,
          notify: notifyOwner,
          checkIntegration: (m) => orchestrator.checkIntegration(m, m.lastResult),
        })
          .catch((err) => log(`monitor error: ${(err as Error).message}`))
          .finally(() => {
            monitoring = false;
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
    stopForUpdate = (code) => shutdown("update", code);
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
          mcpTickets,
          agentsDir: join(home, "agents"),
          projectsDir: paths.projectsDir,
          home,
          billing: {
            list: () =>
              Object.entries(BILLING).map(([provider, p]) => ({
                provider,
                label: p.label,
                mode: getSetting(db, `billing.${provider}`) === "api" ? "api" : "subscription",
                keyId: p.key,
                keySet: existsSync(paths.vaultDb) && getVault().status(p.key).set,
              })),
            setMode: (provider, mode) => {
              if (!BILLING[provider]) throw new Error(`unknown provider ${provider}`);
              setSetting(db, `billing.${provider}`, mode);
            },
          },
          update: {
            status: async () => {
              const parse = (key: string) => {
                const raw = getSetting(db, key);
                return raw ? (JSON.parse(raw) as unknown) : null;
              };
              const head = await updaterDeps.exec("git", [
                "-C",
                REPO,
                "log",
                "-1",
                "--format=%h %s",
              ]);
              return {
                auto: autoUpdate(db),
                service: AS_SERVICE,
                current: head.out.trim(),
                check: parse("update.check"),
                ready: parse(READY_KEY),
                last: parse(LAST_KEY),
              };
            },
            setAuto: (on) => setSetting(db, AUTO_KEY, on ? "1" : "0"),
            checkNow: async () => {
              if (!AS_SERVICE)
                return { status: "blocked", reason: "only the installed service updates itself" };
              return updateTick(updaterDeps, true);
            },
          },
          // The codex CLI's own model list (no login data in it); missing file: no suggestions.
          codexModels: () => {
            try {
              const cache = JSON.parse(
                readFileSync(join(homedir(), ".codex", "models_cache.json"), "utf8"),
              ) as { models?: { slug?: string; visibility?: string }[] };
              return (cache.models ?? [])
                .filter((m) => m.slug && m.visibility === "list")
                .map((m) => `cli-codex/${m.slug}`);
            } catch {
              return [];
            }
          },
          integrations: () => {
            const ids = new Set(
              existsSync(paths.vaultDb)
                ? getVault()
                    .list()
                    .map((s) => s.id)
                : [],
            );
            // The gateway's own PATH is the one agent runs and MCP servers get.
            const path = (process.env.PATH ?? "").split(":");
            return integrationStatus(
              loadCatalog(SEED_CATALOG, join(home, "catalog")),
              loadAgents(join(home, "agents")).values(),
              // Own accounts count like a project named "own" (ADR-0042).
              [...loadProjects(paths.projectsDir).values(), ownProject(home)],
              (id) => ids.has(id),
              (bin) => path.some((dir) => dir && existsSync(join(dir, bin))),
            );
          },
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
      // Fully up: an update that led here succeeded.
      reportAfterRestart(updaterDeps);
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
