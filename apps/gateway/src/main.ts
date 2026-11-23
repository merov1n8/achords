// Gateway entrypoint (launchd ProgramArguments points here). Kept tiny and stable: it loads the
// gateway lazily, so code from an update that fails to load is rolled back instead of looping.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSetting, homePaths, openCoreDatabase, resolveHome, setSetting } from "@achords/core";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");

if (process.argv.includes("--self-test")) {
  // Used by the updater after a build: the new code must at least load.
  await import("./gateway.ts");
  process.exit(0);
}

try {
  const { runGateway } = await import("./gateway.ts");
  // Exit now: a leftover handle must not keep a stopped gateway alive next to its successor.
  process.exit(await runGateway(resolveHome()));
} catch (err) {
  // Crash right after an update: back to the previous commit, then let launchd restart us.
  const db = openCoreDatabase(homePaths(resolveHome()).db);
  const raw = getSetting(db, "update.pending");
  if (raw) {
    const { prev } = JSON.parse(raw) as { prev: string };
    const pnpm = join(dirname(process.execPath), "pnpm");
    const run = (cmd: string, args: string[]) => {
      try {
        execFileSync(cmd, args, { stdio: "ignore", timeout: 600_000 });
      } catch {}
    };
    run("git", ["-C", repo, "reset", "--hard", "--quiet", prev]);
    run(pnpm, ["--dir", repo, "install", "--frozen-lockfile"]);
    run(pnpm, ["--dir", repo, "build"]);
    setSetting(db, "update.pending", "");
    setSetting(
      db,
      "update.last",
      JSON.stringify({
        at: Date.now(),
        ok: false,
        text: `the new version did not start (${(err as Error).message.slice(0, 200)}); rolled back to ${prev.slice(0, 7)}`,
      }),
    );
  }
  db.close();
  throw err;
}
