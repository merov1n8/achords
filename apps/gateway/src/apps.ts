// Local apps integrations need (ADR-0054): achords opens one for a run when it is not running
// and quits only the ones it opened itself, once no active task needs them for a grace period.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppControl } from "@achords/platform";
import type { CatalogApp } from "@achords/policy";

export type Ensured = { ok: true; opened: boolean } | { ok: false; reason: string };

export interface Apps {
  /** Before a run: the app is running (and ready if achords opened it now), or why not. */
  ensure(app: CatalogApp, workdir: string): Promise<Ensured>;
  /** Quits apps achords opened that `inUse` has not named for the grace period. */
  sweep(inUse: () => Set<string>): Promise<void>;
}

const OPEN_TIMEOUT_S = 60;

export function createApps(opts: {
  control: AppControl;
  log: (msg: string) => void;
  graceMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Apps {
  const { control, log } = opts;
  const graceMs = opts.graceMs ?? 3 * 60_000;
  const pollMs = opts.pollMs ?? 1000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  // Apps achords opened, by name: the pid tells them apart from one the owner opens later.
  const opened = new Map<string, { pid: number; process: string; idleSince?: number }>();

  return {
    async ensure(app, workdir) {
      const proc = app.process ?? app.name;
      if (await control.pid(proc)) return { ok: true, opened: false };
      if (app.requires && !existsSync(join(workdir, app.requires))) {
        log(`apps: not opening ${app.name}: ${workdir} has no ${app.requires}`);
        return { ok: false, reason: `not opened: ${workdir} has no ${app.requires}` };
      }
      const args = app.open.map((a) => a.replaceAll("{workdir}", workdir));
      try {
        await control.open(args);
      } catch (err) {
        log(`apps: could not open ${app.name}: ${(err as Error).message}`);
        return { ok: false, reason: "could not be opened" };
      }
      log(`apps: opened ${app.name} (open ${args.join(" ")})`);
      const timeoutS = app.ready?.timeout_s ?? OPEN_TIMEOUT_S;
      const deadline = now() + timeoutS * 1000;
      let pid: number | undefined;
      for (;;) {
        pid ??= await control.pid(proc);
        if (pid && !opened.has(app.name)) opened.set(app.name, { pid, process: proc });
        if (pid && (!app.ready || (await control.listening(app.ready.port)))) break;
        if (now() >= deadline) {
          const reason = pid
            ? `opened, but did not answer within ${timeoutS} s`
            : "could not be opened";
          log(`apps: ${app.name} ${reason}`);
          return { ok: false, reason };
        }
        await sleep(pollMs);
      }
      log(`apps: ${app.name} is ready (pid ${pid})`);
      return { ok: true, opened: true };
    },

    async sweep(inUse) {
      if (!opened.size) return;
      const needed = inUse();
      for (const [name, o] of opened) {
        if (needed.has(name)) {
          delete o.idleSince;
          continue;
        }
        o.idleSince ??= now();
        if (now() - o.idleSince < graceMs) continue;
        opened.delete(name);
        // Quit or reopened by the owner meanwhile: no longer ours to close.
        if ((await control.pid(o.process)) !== o.pid) {
          log(`apps: ${name} was closed or reopened outside achords; leaving it alone`);
          continue;
        }
        try {
          await control.quit(name);
          log(`apps: closed ${name} (no active task needs it)`);
        } catch (err) {
          log(`apps: could not close ${name}, left open: ${(err as Error).message}`);
        }
      }
    },
  };
}
