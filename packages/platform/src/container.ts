// Apple's `container` tool (lightweight Linux VMs, ADR-0051): finding it and reading its output.
// The commands themselves are run by the gateway and the CLI; this module stays pure.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const IMAGE_REPO = "achords-agent";

/**
 * Every agent run's container is named with this install's prefix, so `achords kill` and a
 * restarting gateway find all of theirs, and never another install's (a dev checkout, tests).
 */
export const runContainerPrefix = (home: string): string =>
  `achords-run-${createHash("sha256").update(home).digest("hex").slice(0, 8)}-`;

/** The binary on PATH, else Homebrew's places (the service PATH may lack them). */
export function findContainerBin(path = process.env.PATH ?? ""): string | undefined {
  const dirs = [...path.split(":").filter(Boolean), "/opt/homebrew/bin", "/usr/local/bin"];
  return dirs.map((d) => join(d, "container")).find((p) => existsSync(p));
}

/** The image tag follows the Dockerfile: any change to it means a new image on the next run. */
export function imageTag(dockerfile: string): string {
  return `${IMAGE_REPO}:${createHash("sha256").update(dockerfile).digest("hex").slice(0, 12)}`;
}

/** Names of this install's run containers in `container ls --format json` output. */
export function runContainerNames(lsJson: string, prefix: string): string[] {
  try {
    const list = JSON.parse(lsJson) as { configuration?: { id?: unknown } }[];
    return list.map((c) => String(c.configuration?.id ?? "")).filter((id) => id.startsWith(prefix));
  } catch {
    return [];
  }
}

/** achords-agent images other than `keep`, from `container image ls --format json`. */
export function staleImages(lsJson: string, keep: string): string[] {
  try {
    const list = JSON.parse(lsJson) as { configuration?: { name?: unknown } }[];
    return list
      .map((i) => String(i.configuration?.name ?? "").replace(/^docker\.io\/library\//, ""))
      .filter((name) => name.startsWith(`${IMAGE_REPO}:`) && name !== keep);
  } catch {
    return [];
  }
}

/** The host side of the container network, from `container network inspect default`. */
export function parseNetwork(inspectJson: string): { gateway: string; subnet: string } | undefined {
  try {
    const [net] = JSON.parse(inspectJson) as {
      status?: { ipv4Gateway?: unknown; ipv4Subnet?: unknown };
    }[];
    const gateway = String(net?.status?.ipv4Gateway ?? "");
    const subnet = String(net?.status?.ipv4Subnet ?? "");
    return ipv4(gateway) !== undefined && /\/\d+$/.test(subnet) ? { gateway, subnet } : undefined;
  } catch {
    return undefined;
  }
}

const ipv4 = (ip: string): number | undefined => {
  const m = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return undefined;
  return parts.reduce((n, p) => n * 256 + p, 0);
};

/** Whether an IPv4 address (also in its IPv6-mapped form) lies in `a.b.c.d/n`. */
export function inSubnet(ip: string, cidr: string): boolean {
  const [base = "", bits = ""] = cidr.split("/");
  const a = ipv4(ip);
  const b = ipv4(base);
  const n = Number(bits);
  if (a === undefined || b === undefined || !Number.isInteger(n) || n < 8 || n > 32) return false;
  const size = 2 ** (32 - n);
  return Math.floor(a / size) === Math.floor(b / size);
}
