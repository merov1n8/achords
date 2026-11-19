import { homedir } from "node:os";
import { resolve } from "node:path";

/** Single root for all runtime state (ADR-0021), kept outside the code checkout. */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ACHORDS_HOME;
  return override ? resolve(override) : resolve(homedir(), ".achords");
}
