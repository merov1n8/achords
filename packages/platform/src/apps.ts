// Apps on this Mac that integrations talk to (ADR-0054): is one running, open it, quit it.
// Names are passed as arguments only, never spliced into a shell or AppleScript source.
import { execFile } from "node:child_process";
import { connect } from "node:net";

export interface AppControl {
  /** Pid of the running process with exactly this name, or undefined. */
  pid(process: string): Promise<number | undefined>;
  /** macOS `open` with these arguments; rejects when the app cannot be found or started. */
  open(args: string[]): Promise<void>;
  /** Asks the app to quit, as the Quit menu item does (it may still ask to save). */
  quit(name: string): Promise<void>;
  /** Something accepts connections on 127.0.0.1 at this port. */
  listening(port: number): Promise<boolean>;
}

export type Run = (cmd: string, args: string[]) => Promise<string>;

const execRun: Run = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    );
  });

const tcpOpen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 1000 });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });

export function macApps(run: Run = execRun, listening = tcpOpen): AppControl {
  return {
    async pid(process) {
      // pgrep exits 1 when nothing matches.
      const out = await run("/usr/bin/pgrep", ["-x", process]).catch(() => "");
      const pid = Number.parseInt(out.split("\n")[0] ?? "", 10);
      return Number.isFinite(pid) && pid > 0 ? pid : undefined;
    },
    async open(args) {
      await run("/usr/bin/open", args);
    },
    async quit(name) {
      await run("/usr/bin/osascript", [
        "-e",
        "on run argv",
        "-e",
        "tell application (item 1 of argv) to quit",
        "-e",
        "end run",
        name,
      ]);
    },
    listening,
  };
}
