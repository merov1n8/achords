import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

export const LABEL = "dev.achords.gateway";

export interface PlistInput {
  nodePath: string;
  gatewayEntry: string;
  home: string;
  logFile: string;
}

/** Manages the always-on gateway as an OS service. */
export interface ServiceManager {
  readonly kind: string;
  start(): void;
  /** Unloads the service; returns false if it was not loaded. */
  stop(): boolean;
  isLoaded(): boolean;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderPlist(i: PlistInput): string {
  const args = [i.nodePath, "--disable-warning=ExperimentalWarning", i.gatewayEntry]
    .map((a) => `    <string>${esc(a)}</string>`)
    .join("\n");
  // KeepAlive.SuccessfulExit=false: respawn after crashes only. The gateway exits 0 when it is
  // stopped on purpose (SIGTERM, STOP marker), so an emergency stop cannot be undone by launchd.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ACHORDS_HOME</key>
    <string>${esc(i.home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${esc(i.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(i.logFile)}</string>
</dict>
</plist>
`;
}

interface LaunchdDeps {
  uid: number;
  plistPath: string;
  launchctl: (args: string[]) => void;
  writeFile: (path: string, content: string) => void;
}

const realDeps = (): LaunchdDeps => ({
  uid: process.getuid?.() ?? 0,
  plistPath: join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`),
  launchctl: (args) => {
    execFileSync("launchctl", args, { stdio: "ignore" });
  },
  writeFile: (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  },
});

export function launchdService(input: PlistInput, deps: LaunchdDeps = realDeps()): ServiceManager {
  const domain = `gui/${deps.uid}`;
  const target = `${domain}/${LABEL}`;
  const isLoaded = () => {
    try {
      deps.launchctl(["print", target]);
      return true;
    } catch {
      return false;
    }
  };
  return {
    kind: "launchd",
    isLoaded,
    start() {
      // Rewritten every start so the job follows the current node binary and checkout.
      deps.writeFile(deps.plistPath, renderPlist(input));
      if (isLoaded()) deps.launchctl(["kickstart", target]);
      else deps.launchctl(["bootstrap", domain, deps.plistPath]);
    },
    stop() {
      if (!isLoaded()) return false;
      deps.launchctl(["bootout", target]);
      return true;
    },
  };
}

/** Hosts with neither launchd nor systemd. */
export const unsupportedService: ServiceManager = {
  kind: "none",
  isLoaded: () => false,
  start() {
    throw new Error(
      `service install is not supported on ${process.platform} yet; run the gateway in the foreground`,
    );
  },
  stop: () => false,
};

// macOS privacy (TCC) folders: a launchd job cannot read them without an explicit grant.
const PROTECTED = ["Documents", "Desktop", "Downloads", join("Library", "Mobile Documents")];

export function protectedFolderOf(path: string, home = homedir()): string | undefined {
  return PROTECTED.find((f) => path.startsWith(join(home, f) + sep));
}
