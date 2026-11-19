#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// achords CLI. Control commands work without a running gateway.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPairingCode, homePaths, openCoreDatabase, resolveHome } from "@achords/core";
import { openHomeVault } from "@achords/secrets";
import { type ControlContext, kill, resume, start, status, stop } from "./control.ts";
import { runDoctor, systemDoctorEnv } from "./doctor.ts";
import { runInit } from "./init.ts";
import { launchdService, protectedFolderOf, unsupportedService } from "./launchd.ts";
import { createPrompter, readSecret } from "./secret-input.ts";
import { systemdService } from "./systemd.ts";
import { exportHome, importHome } from "./transfer.ts";

const USAGE = `usage: achords <command>

  init     first-time setup (checks, Telegram token, service, pairing codes); re-runnable
  doctor   check prerequisites and the running system
  start    start the gateway as a background service
  stop     graceful stop (queue state is kept)
  kill     EMERGENCY STOP: unload service, kill gateway and all agent runs, pause queue
  resume   clear an emergency stop (then run: achords start)
  status   show service, gateway, queue and run state

  export <file>          encrypted backup / move to another machine (gateway must be stopped)
  import <file>          restore an export into an empty data folder (starts paused)
  pair web               print a one-time code to pair a browser (valid 10 minutes)
  pair telegram          print a one-time code; send "/pair <code>" to your bot
  secret set <id>        store a secret; the value is read from stdin (hidden when typing)
  secret list            list stored secrets (never their values)
  secret rm <id>         delete a secret

Data root: $ACHORDS_HOME (default ~/.achords)`;

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
        })
      : process.platform === "linux"
        ? systemdService({ nodePath: process.execPath, gatewayEntry, home: paths.home })
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

async function run(command: string | undefined, args: string[]): Promise<number> {
  const ctx = context();
  const doctorEnv = () =>
    systemDoctorEnv(ctx.paths, gatewayEntry, () => ctx.service.isLoaded(), vaultStatus(ctx.paths));
  switch (command) {
    case "export": {
      const file = args[0];
      if (!file) throw new Error("usage: achords export <file>");
      const ask = createPrompter();
      const pass = await ask("Passphrase for the export (12+ characters, hidden):", {
        secret: true,
      });
      if ((await ask("Repeat the passphrase:", { secret: true })) !== pass) {
        throw new Error("passphrases do not match");
      }
      const r = exportHome(ctx.paths.home, file, pass);
      console.log(
        `Exported ${r.files} files and ${r.secrets} secrets to ${file} (encrypted, 0600).`,
      );
      console.log(
        "This machine's queue is now paused. Keep the passphrase: without it the export is unreadable.",
      );
      return 0;
    }
    case "import": {
      const file = args[0];
      if (!file) throw new Error("usage: achords import <file>");
      const pass = await createPrompter()("Passphrase of the export (hidden):", { secret: true });
      const r = importHome(ctx.paths.home, file, pass);
      console.log(`Imported ${r.files} files and ${r.secrets} secrets into ${ctx.paths.home}.`);
      console.log("Next steps on this machine:");
      console.log("  1. log in to the claude CLI (`claude`), logins do not travel");
      console.log("  2. achords doctor");
      console.log("  3. achords resume && achords start   (the queue starts paused)");
      console.log(
        "  4. achords pair web   (browser sessions do not travel; Telegram pairing does)",
      );
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
        throw new Error("usage: achords pair web|telegram");
      }
      const db = openCoreDatabase(ctx.paths.db);
      const code = createPairingCode(db, purpose);
      db.close();
      console.log(`Pairing code: ${code}  (single use, valid 10 minutes)`);
      console.log(
        purpose === "web"
          ? "Enter it in the web UI on the device you want to pair."
          : `Send this to your bot in a private chat:  /pair ${code}`,
      );
      return 0;
    }
    case "secret": {
      const [sub, id] = args;
      const vault = openHomeVault(ctx.paths.home);
      try {
        if (sub === "set" && id) {
          const value = await readSecret(`Value for ${id} (hidden): `);
          if (!value) throw new Error("empty value, nothing stored");
          vault.set(id, value, "cli");
          console.log(`stored ${id}`);
        } else if (sub === "list") {
          for (const s of vault.list()) {
            const when = new Date(s.updatedAt ?? 0).toISOString().slice(0, 16).replace("T", " ");
            console.log(`${s.id.padEnd(32)} ${s.last4 ? `…${s.last4}` : "(set)"}  ${when}`);
          }
        } else if (sub === "rm" && id) {
          if (!vault.delete(id, "cli")) throw new Error(`${id} is not set`);
          console.log(`deleted ${id}`);
        } else {
          throw new Error("usage: achords secret set <id> | list | rm <id>");
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
          console.error(
            `hint: the code is in ~/${folder}, which macOS blocks for background services.\n` +
              "  Move the checkout (e.g. ~/Code/achords) or grant node access under\n" +
              "  System Settings > Privacy & Security > Files and Folders.",
          );
        }
        throw err;
      }
    }
    case "stop":
      console.log(stop(ctx));
      return 0;
    case "kill": {
      const report = kill(ctx);
      for (const s of report.steps) console.log(`  ${s}`);
      for (const e of report.errors) console.error(`  FAILED ${e}`);
      console.log(
        report.errors.length ? "emergency stop finished WITH ERRORS" : "emergency stop done",
      );
      return report.errors.length ? 1 : 0;
    }
    case "resume":
      console.log(resume(ctx));
      return 0;
    case "status": {
      const s = status(ctx);
      console.log(`home            ${ctx.paths.home}`);
      console.log(`service         ${ctx.service.kind}: ${s.service}`);
      console.log(
        `gateway         ${s.gatewayPid ? `running (pid ${s.gatewayPid})` : "not running"}`,
      );
      console.log(
        `heartbeat       ${s.heartbeatAgeMs === null ? "never" : `${Math.round(s.heartbeatAgeMs / 1000)}s ago`}`,
      );
      console.log(`queue           ${s.paused ? "PAUSED" : "active"}`);
      console.log(`emergency stop  ${s.emergencyStop ? "ACTIVE" : "no"}`);
      console.log(`active runs     ${s.activeRuns}`);
      return 0;
    }
    default:
      console.log(USAGE);
      return command === undefined || command === "help" ? 0 : 2;
  }
}

const { positionals } = parseArgs({ allowPositionals: true, strict: false });
try {
  process.exitCode = await run(positionals[0], positionals.slice(1));
} catch (err) {
  console.error(`achords: ${(err as Error).message}`);
  process.exitCode = 1;
}
