import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ServiceManager } from "./launchd.ts";

export const UNIT = "achords-gateway.service";

export interface UnitInput {
  nodePath: string;
  gatewayEntry: string;
  home: string;
}

// systemd unit quoting: double quotes, escaped backslashes/quotes, and % doubled (specifiers).
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/** Restart=on-failure: like launchd's SuccessfulExit=false, a deliberate exit 0 stays down. */
export function renderUnit(i: UnitInput): string {
  return `[Unit]
Description=achords gateway
After=network-online.target

[Service]
ExecStart=${[i.nodePath, "--disable-warning=ExperimentalWarning", i.gatewayEntry].map(q).join(" ")}
Environment=${q(`ACHORDS_HOME=${i.home}`)}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

interface SystemdDeps {
  unitPath: string;
  systemctl: (args: string[]) => void;
  writeFile: (path: string, content: string) => void;
}

const realDeps = (): SystemdDeps => ({
  unitPath: join(homedir(), ".config", "systemd", "user", UNIT),
  systemctl: (args) => {
    execFileSync("systemctl", ["--user", ...args], { stdio: "ignore" });
  },
  writeFile: (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  },
});

/** User-level systemd service (Linux). */
export function systemdService(input: UnitInput, deps: SystemdDeps = realDeps()): ServiceManager {
  const isLoaded = () => {
    try {
      deps.systemctl(["is-active", "--quiet", UNIT]);
      return true;
    } catch {
      return false;
    }
  };
  return {
    kind: "systemd",
    isLoaded,
    start() {
      deps.writeFile(deps.unitPath, renderUnit(input));
      deps.systemctl(["daemon-reload"]);
      deps.systemctl(["enable", "--now", UNIT]);
    },
    stop() {
      if (!isLoaded()) return false;
      deps.systemctl(["stop", UNIT]);
      return true;
    },
  };
}
