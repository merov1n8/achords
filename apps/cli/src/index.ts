#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// achords CLI. Control commands work without a running gateway.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createPairingCode,
  homePaths,
  openCoreDatabase,
  resolveHome,
  setDraining,
} from "@achords/core";
import { t } from "@achords/i18n";
import { openHomeVault } from "@achords/secrets";
import { connectGoogle, parseClientJson } from "./connect-google.ts";
import { type ControlContext, kill, resume, start, status, stop } from "./control.ts";
import { runDoctor, systemDoctorEnv } from "./doctor.ts";
import { runInit } from "./init.ts";
import { launchdService, protectedFolderOf, unsupportedService } from "./launchd.ts";
import { createPrompter, readSecret } from "./secret-input.ts";
import { systemdService } from "./systemd.ts";
import { exportHome, importHome } from "./transfer.ts";

const USAGE = () => t("cli.usage");

// Dev install: the service runs the gateway straight from this checkout.
const gatewayEntry = fileURLToPath(new URL("../../gateway/src/main.ts", import.meta.url));

function context(): ControlContext {
  const paths = homePaths(resolveHome());
  const service =
    process.platform === "darwin"
      ? launchdService({
          nodePath: process.execPath,
          gatewayEntry,
          home: paths.home,
          logFile: `${paths.logDir}/gateway.log`,
          path: process.env.PATH ?? "/usr/bin:/bin",
        })
      : process.platform === "linux"
        ? systemdService({
            nodePath: process.execPath,
            gatewayEntry,
            home: paths.home,
            path: process.env.PATH ?? "/usr/bin:/bin",
          })
        : unsupportedService;
  return { paths, service };
}

// Opening the vault needs the master key; doctor only does that once secrets exist.
function vaultStatus(paths: ControlContext["paths"]) {
  return () => {
    if (!existsSync(paths.vaultDb)) return { ok: true as const, telegram: false };
    try {
      const v = openHomeVault(paths.home);
      const telegram = v.status("telegram.bot-token").set;
      v.close();
      return { ok: true as const, telegram };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  };
}

/** "30m", "90s", "1h" or minutes as a bare number. */
function parseDuration(text: string): number {
  const m = /^(\d+)(s|m|h)?$/.exec(text.trim());
  if (!m) throw new Error(t("cli.stop.badWait", { value: text }));
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? "m") as "s" | "m" | "h"];
}

function withDraining(ctx: ControlContext, on: boolean) {
  const db = openCoreDatabase(ctx.paths.db);
  setDraining(db, on);
  db.close();
}

async function run(
  command: string | undefined,
  args: string[],
  options: Record<string, string | boolean | undefined> = {},
): Promise<number> {
  const ctx = context();
  const doctorEnv = () =>
    systemDoctorEnv(ctx.paths, gatewayEntry, () => ctx.service.isLoaded(), vaultStatus(ctx.paths));
  switch (command) {
    case "export": {
      const file = args[0];
      if (!file) throw new Error(t("cli.export.usage"));
      const ask = createPrompter();
      const pass = await ask(t("cli.export.passphrase"), {
        secret: true,
      });
      if ((await ask(t("cli.export.repeat"), { secret: true })) !== pass) {
        throw new Error(t("cli.export.mismatch"));
      }
      const r = exportHome(ctx.paths.home, file, pass);
      console.log(t("cli.export.done", { files: r.files, secrets: r.secrets, file }));
      console.log(t("cli.export.paused"));
      return 0;
    }
    case "import": {
      const file = args[0];
      if (!file) throw new Error(t("cli.import.usage"));
      const pass = await createPrompter()(t("cli.import.passphrase"), { secret: true });
      const r = importHome(ctx.paths.home, file, pass);
      console.log(
        t("cli.import.done", { files: r.files, secrets: r.secrets, home: ctx.paths.home }),
      );
      console.log(t("cli.import.next"));
      return 0;
    }
    case "doctor": {
      const icon = { ok: "✓", info: "·", warn: "!", fail: "✗" } as const;
      const checks = await runDoctor(doctorEnv());
      for (const c of checks) {
        console.log(`${icon[c.level]} ${c.name.padEnd(20)} ${c.detail}`);
        if (c.fix && c.level !== "ok") console.log(`  ${"".padEnd(20)} → ${c.fix}`);
      }
      return checks.some((c) => c.level === "fail") ? 1 : 0;
    }
    case "init": {
      const ask = createPrompter();
      return runInit({
        paths: ctx.paths,
        io: { ask, print: (line) => console.log(line) },
        doctor: () => runDoctor(doctorEnv()),
        openVault: () => openHomeVault(ctx.paths.home),
        start: () => start(ctx),
      });
    }
    case "pair": {
      const purpose = args[0];
      if (purpose !== "web" && purpose !== "telegram") {
        throw new Error(t("cli.pair.usage"));
      }
      const db = openCoreDatabase(ctx.paths.db);
      const code = createPairingCode(db, purpose);
      db.close();
      console.log(t("cli.pair.code", { code }));
      console.log(purpose === "web" ? t("cli.pair.web") : t("cli.pair.telegram", { code }));
      return 0;
    }
    case "connect": {
      const [service, file] = args;
      if (service !== "google" || !file) throw new Error(t("cli.connect.usage"));
      const client = parseClientJson(readFileSync(file, "utf8"));
      const vault = openHomeVault(ctx.paths.home);
      try {
        await connectGoogle({
          client,
          store: (id, value) => vault.set(id, value, "cli:connect-google"),
          openUrl: (url) => {
            const opener = process.platform === "darwin" ? "open" : "xdg-open";
            execFile(opener, [url], () => {});
          },
          print: (line) => console.log(line),
        });
      } finally {
        vault.close();
      }
      console.log(t("cli.connect.done", { file }));
      return 0;
    }
    case "secret": {
      const [sub, id] = args;
      const vault = openHomeVault(ctx.paths.home);
      try {
        if (sub === "set" && id) {
          const value = await readSecret(t("cli.secret.prompt", { id }));
          if (!value) throw new Error(t("cli.secret.empty"));
          vault.set(id, value, "cli");
          console.log(t("cli.secret.stored", { id }));
        } else if (sub === "list") {
          for (const s of vault.list()) {
            const when = new Date(s.updatedAt ?? 0).toISOString().slice(0, 16).replace("T", " ");
            console.log(`${s.id.padEnd(32)} ${s.last4 ? `…${s.last4}` : "(set)"}  ${when}`);
          }
        } else if (sub === "rm" && id) {
          if (!vault.delete(id, "cli")) throw new Error(t("cli.secret.notSet", { id }));
          console.log(t("cli.secret.deleted", { id }));
        } else {
          throw new Error(t("cli.secret.usage"));
        }
      } finally {
        vault.close();
      }
      return 0;
    }
    case "start": {
      try {
        console.log(start(ctx));
        return 0;
      } catch (err) {
        // Access may have been granted, so only mention privacy folders when the start failed.
        const folder = process.platform === "darwin" ? protectedFolderOf(gatewayEntry) : undefined;
        if (folder) {
          console.error(t("cli.start.folderHint", { folder }));
        }
        throw err;
      }
    }
    case "stop": {
      const waitMs = options.wait === undefined ? undefined : parseDuration(String(options.wait));
      // Ctrl+C while waiting: no stop after all, the gateway goes on working.
      const onInt = () => {
        withDraining(ctx, false);
        console.log(t("cli.stop.cancelled"));
        process.exit(130);
      };
      process.once("SIGINT", onInt);
      try {
        console.log(
          await stop(ctx, {
            now: options.now === true,
            ...(waitMs !== undefined ? { waitMs } : {}),
            print: (line) => console.log(line),
          }),
        );
      } finally {
        process.off("SIGINT", onInt);
      }
      return 0;
    }
    case "kill": {
      const report = kill(ctx);
      for (const s of report.steps) console.log(`  ${s}`);
      for (const e of report.errors) console.error(t("cli.kill.failed", { error: e }));
      console.log(report.errors.length ? t("cli.kill.withErrors") : t("cli.kill.done"));
      return report.errors.length ? 1 : 0;
    }
    case "resume":
      console.log(resume(ctx));
      return 0;
    case "status": {
      const s = status(ctx);
      const row = (key: string, value: string | number) =>
        console.log(`${t(key).padEnd(16)}${value}`);
      row("cli.status.home", ctx.paths.home);
      row(
        "cli.status.service",
        `${ctx.service.kind}: ${t(s.service === "loaded" ? "cli.status.loaded" : "cli.status.notLoaded")}`,
      );
      row(
        "cli.status.gateway",
        s.gatewayPid ? t("cli.status.running", { pid: s.gatewayPid }) : t("cli.status.notRunning"),
      );
      row(
        "cli.status.heartbeat",
        s.heartbeatAgeMs === null
          ? t("cli.status.never")
          : t("cli.status.secondsAgo", { s: Math.round(s.heartbeatAgeMs / 1000) }),
      );
      row("cli.status.queue", s.paused ? t("cli.status.paused") : t("cli.status.active"));
      row(
        "cli.status.emergency",
        s.emergencyStop ? t("cli.status.emergencyActive") : t("cli.status.no"),
      );
      row("cli.status.runs", s.activeRuns);
      return 0;
    }
    default:
      console.log(USAGE());
      return command === undefined || command === "help" ? 0 : 2;
  }
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: { now: { type: "boolean" }, wait: { type: "string" } },
});
try {
  process.exitCode = await run(positionals[0], positionals.slice(1), values);
} catch (err) {
  console.error(`achords: ${(err as Error).message}`);
  process.exitCode = 1;
}
