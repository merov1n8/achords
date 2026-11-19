#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// achords CLI. Control commands work without a running gateway.
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { homePaths, resolveHome } from "@achords/core";
import { type ControlContext, kill, resume, start, status, stop } from "./control.ts";
import { launchdService, protectedFolderOf, unsupportedService } from "./launchd.ts";

const USAGE = `usage: achords <command>

  start    start the gateway as a background service
  stop     graceful stop (queue state is kept)
  kill     EMERGENCY STOP: unload service, kill gateway and all agent runs, pause queue
  resume   clear an emergency stop (then run: achords start)
  status   show service, gateway, queue and run state

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
      : unsupportedService;
  return { paths, service };
}

function run(command: string | undefined): number {
  const ctx = context();
  switch (command) {
    case "start": {
      const folder = process.platform === "darwin" ? protectedFolderOf(gatewayEntry) : undefined;
      if (folder) {
        console.warn(
          `warning: the code is in ~/${folder}, which macOS blocks for background services.\n` +
            "  Move the checkout (e.g. ~/Code/achords) or grant node access under\n" +
            "  System Settings > Privacy & Security > Files and Folders.",
        );
      }
      console.log(start(ctx));
      return 0;
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
  process.exitCode = run(positionals[0]);
} catch (err) {
  console.error(`achords: ${(err as Error).message}`);
  process.exitCode = 1;
}
