import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Single root for all runtime state (ADR-0021), kept outside the code checkout. */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ACHORDS_HOME;
  return override ? resolve(override) : resolve(homedir(), ".achords");
}

export function homePaths(home: string) {
  const runDir = join(home, "run");
  return {
    home,
    db: join(home, "core.db"),
    vaultDb: join(home, "vault.db"),
    memoryDb: join(home, "memory.db"),
    // Linux fallback only; on macOS the master key lives in the Keychain.
    masterKeyFile: join(home, "master.key"),
    runDir,
    pidFile: join(runDir, "gateway.pid"),
    // Emergency stop marker: while it exists the gateway refuses to start (`achords resume` clears).
    stopFile: join(runDir, "STOP"),
    logDir: join(home, "logs"),
  };
}

export type HomePaths = ReturnType<typeof homePaths>;
