#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// achords CLI. Control commands work without a running gateway.
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPairingCode, homePaths, openCoreDatabase, resolveHome } from "@achords/core";
import { openHomeVault } from "@achords/secrets";
import { type ControlContext, kill, resume, start, status, stop } from "./control.ts";
import { launchdService, protectedFolderOf, unsupportedService } from "./launchd.ts";
import { readSecret } from "./secret-input.ts";
import { systemdService } from "./systemd.ts";

const USAGE = `usage: achords <command>

  start    start the gateway as a background service
  stop     graceful stop (queue state is kept)
  kill     EMERGENCY STOP: unload service, kill gateway and all agent runs, pause queue
  resume   clear an emergency stop (then run: achords start)
  status   show service, gateway, queue and run state

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

async function run(command: string | undefined, args: string[]): Promise<number> {
  const ctx = context();
  switch (command) {
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
