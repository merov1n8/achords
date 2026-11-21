// The owner reaches the web UI from a phone or another computer through Tailscale
// (`tailscale serve` → https://<machine>.<tailnet>.ts.net). The gateway accepts that one host
// name besides 127.0.0.1/localhost; DNS rebinding cannot use it, Tailscale owns *.ts.net.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

const APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/;

/** This machine's MagicDNS name from `tailscale status --json`, or undefined. */
export function tailscaleHost(statusJson: string): string | undefined {
  try {
    const name = String(
      (JSON.parse(statusJson) as { Self?: { DNSName?: unknown } }).Self?.DNSName ?? "",
    )
      .replace(/\.$/, "")
      .toLowerCase();
    return HOST.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Asks the local Tailscale (app or CLI on PATH); undefined when it is not installed or off. */
export function findTailscaleHost(): Promise<string | undefined> {
  const bin = existsSync(APP_CLI) ? APP_CLI : "tailscale";
  return new Promise((done) =>
    execFile(bin, ["status", "--json"], { timeout: 5_000 }, (err, stdout) =>
      done(err ? undefined : tailscaleHost(stdout)),
    ),
  );
}
