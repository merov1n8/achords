import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HomePaths } from "@achords/core";
import { protectedFolderOf } from "./launchd.ts";

export interface Check {
  name: string;
  level: "ok" | "info" | "warn" | "fail";
  detail: string;
  fix?: string;
}

/** Everything the checks read from the system, injectable for tests. */
export interface DoctorEnv {
  paths: HomePaths;
  nodeVersion: string;
  platform: NodeJS.Platform;
  gatewayEntry: string;
  userHome: string;
  webDist: string;
  which: (bin: string) => string | undefined;
  version: (bin: string) => string | undefined;
  serviceLoaded: () => boolean;
  gatewayResponds: () => Promise<boolean>;
  vaultStatus: () => { ok: true; telegram: boolean } | { ok: false; error: string };
}

// node:sqlite with extension loading needs 22.13+ (ADR-0022).
const MIN_NODE: [number, number] = [22, 13];

const atLeast = (v: string, [maj, min]: [number, number]) => {
  const [a = 0, b = 0] = v.split(".").map(Number);
  return a > maj || (a === maj && b >= min);
};

export async function runDoctor(env: DoctorEnv): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  add(
    atLeast(env.nodeVersion, MIN_NODE)
      ? { name: "node", level: "ok", detail: `v${env.nodeVersion}` }
      : {
          name: "node",
          level: "fail",
          detail: `v${env.nodeVersion}`,
          fix: `install Node ${MIN_NODE.join(".")} or newer (22 LTS)`,
        },
  );

  const claude = env.which("claude");
  add(
    claude
      ? { name: "claude CLI", level: "ok", detail: env.version("claude") ?? claude }
      : {
          name: "claude CLI",
          level: "fail",
          detail: "not found on PATH",
          fix: "install Claude Code (https://claude.com/claude-code) and log in with `claude`",
        },
  );

  add(
    env.which("git")
      ? { name: "git", level: "ok", detail: env.version("git") ?? "found" }
      : { name: "git", level: "warn", detail: "not found", fix: "install git (dev agents use it)" },
  );

  if (!existsSync(env.paths.home)) {
    add({
      name: "data folder",
      level: "info",
      detail: `${env.paths.home} does not exist yet`,
      fix: "run `achords init`",
    });
  } else {
    const mode = statSync(env.paths.home).mode & 0o777;
    add(
      mode & 0o077
        ? {
            name: "data folder",
            level: "warn",
            detail: `${env.paths.home} is readable by others (${mode.toString(8)})`,
            fix: `chmod 700 ${env.paths.home}`,
          }
        : { name: "data folder", level: "ok", detail: env.paths.home },
    );
  }

  add(
    existsSync(join(env.webDist, "index.html"))
      ? { name: "web UI", level: "ok", detail: "built" }
      : { name: "web UI", level: "warn", detail: "not built", fix: "run `pnpm build`" },
  );

  if (env.platform === "darwin") {
    const folder = protectedFolderOf(env.gatewayEntry, env.userHome);
    add(
      folder
        ? {
            name: "macOS folder access",
            level: "warn",
            detail: `the code is in ~/${folder}; the service needs node to have access to it`,
            fix: "move the checkout (e.g. ~/Code/achords) or grant node access in System Settings > Privacy & Security > Files and Folders",
          }
        : { name: "macOS folder access", level: "ok", detail: "code is outside protected folders" },
    );
  }

  add(
    env.serviceLoaded()
      ? { name: "service", level: "ok", detail: "loaded" }
      : { name: "service", level: "warn", detail: "not loaded", fix: "run `achords start`" },
  );
  add(
    (await env.gatewayResponds())
      ? { name: "gateway", level: "ok", detail: "responding on 127.0.0.1" }
      : { name: "gateway", level: "warn", detail: "not responding", fix: "run `achords start`" },
  );

  const vault = env.vaultStatus();
  if (!vault.ok) {
    add({
      name: "vault",
      level: "fail",
      detail: `cannot open: ${vault.error}`,
      fix: "allow Keychain access for node, or set ACHORDS_KEYSTORE=file on headless hosts",
    });
  } else {
    add({ name: "vault", level: "ok", detail: "master key available" });
    add(
      vault.telegram
        ? { name: "telegram", level: "ok", detail: "bot token set" }
        : {
            name: "telegram",
            level: "info",
            detail: "no bot token",
            fix: "optional: `achords secret set telegram.bot-token`",
          },
    );
  }
  return checks;
}

export function systemDoctorEnv(
  paths: HomePaths,
  gatewayEntry: string,
  serviceLoaded: () => boolean,
  vaultStatus: DoctorEnv["vaultStatus"],
): DoctorEnv {
  const run = (bin: string, args: string[]) => {
    try {
      return execFileSync(bin, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  };
  const port = Number(process.env.ACHORDS_PORT ?? 7420);
  return {
    paths,
    nodeVersion: process.versions.node,
    platform: process.platform,
    gatewayEntry,
    userHome: homedir(),
    webDist: new URL("../../web/dist/", import.meta.url).pathname,
    which: (bin) => run("/usr/bin/which", [bin]),
    version: (bin) => run(bin, ["--version"])?.split("\n")[0],
    serviceLoaded,
    // Any HTTP answer (401 without a session) means the gateway is up.
    gatewayResponds: async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/session`, {
          signal: AbortSignal.timeout(2000),
        });
        return res.status > 0;
      } catch {
        return false;
      }
    },
    vaultStatus,
  };
}
