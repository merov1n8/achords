// ADR-0067 step 4: what a leveled agent's approved request adds to its runs. A request is turned
// into one grant when it is made; the owner then picks its scope (once, for this card, always).
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import { gitPushArgs, historyRewrite, pushDeletes } from "./check.ts";
import type { Manifest } from "./manifest.ts";

export const PERMISSION_KINDS = [
  "folder",
  "integration",
  "project",
  "level",
  "command",
  "web",
] as const;
export type PermissionKind = (typeof PERMISSION_KINDS)[number];

/** What an approval adds to a run (a project's or a command's request is stored as one of these). */
export type Grant =
  | { kind: "folder"; folders: string[] }
  | { kind: "integration"; id: string }
  | { kind: "level"; level: number }
  /** A level 5 push that deletes on the remote, exactly as approved (always-ask, no "always"). */
  | { kind: "push"; command: string };

const within = (p: string, root: string) =>
  p === root || p.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

export const expandPath = (p: string, userHome = homedir()) =>
  normalize(p === "~" ? userHome : p.startsWith("~/") ? join(userHome, p.slice(2)) : p);

/** Folders that hold keys: reading them is on the always-ask list. */
export function keyFolder(path: string, ctx: { achordsHome: string; userHome?: string }): boolean {
  const user = ctx.userHome ?? homedir();
  const p = expandPath(path, user);
  return [
    ctx.achordsHome,
    ...[".ssh", ".aws", ".gnupg", ".config/gh", "Library/Keychains"].map((d) => join(user, d)),
  ].some((k) => within(p, k) || within(k, p));
}

/** Whether a folder is one of `folders` or inside one. */
export const inFolders = (path: string, folders: string[], userHome = homedir()) =>
  folders.some((f) => within(expandPath(path, userHome), expandPath(f, userHome)));

/**
 * A command no approval can allow: force push and history rewrite, and push itself unless the
 * run may push (level 5 in work mode, through the gateway's credential helper).
 */
export function refusedCommand(command: string, opts: { push?: boolean } = {}): string | undefined {
  const rewrite = historyRewrite(command);
  if (rewrite) return rewrite;
  if (!opts.push && gitPushArgs(command).length) {
    return "git push needs level 5 in work mode: it goes through the gateway's credential helper";
  }
  return undefined;
}

const tokens = (cmd: string) => cmd.trim().split(/\s+/).filter(Boolean);
const DELETE = new Set(["rm", "rmdir", "unlink", "trash"]);
const CHANGE_PERMISSIONS = new Set(["chmod", "chown", "chgrp", "chflags", "xattr", "sudo"]);

/** Paths a deleting command names outside the agent's folders. */
export function deletesOutside(command: string, folders: string[], userHome = homedir()): string[] {
  const argv = tokens(command);
  if (!DELETE.has(argv[0] ?? "")) return [];
  return argv
    .slice(1)
    .filter((a) => !a.startsWith("-") && (isAbsolute(a) || a.startsWith("~")))
    .map((a) => expandPath(a, userHome))
    .filter((p) => !inFolders(p, folders, userHome));
}

/** Which always-ask item a command is (no "always" for it), or undefined. */
export function alwaysAskCommand(
  command: string,
  ctx: { folders: string[]; achordsHome: string; userHome?: string },
): string | undefined {
  const argv = tokens(command);
  if (deletesOutside(command, ctx.folders, ctx.userHome).length) {
    return "deleting outside its folders";
  }
  if (CHANGE_PERMISSIONS.has(argv[0] ?? "")) return "changing permissions";
  if (pushDeletes(command)) return "deleting on the remote";
  if (
    argv[0] === "security" ||
    argv.some((a) => (isAbsolute(a) || a.startsWith("~")) && keyFolder(a, ctx))
  ) {
    return "reading keys";
  }
  return undefined;
}

/**
 * A leveled agent's manifest with its grants applied before compiling: folders join the write
 * remit (the level decides whether they are written or only read), integrations the `mcp` remit;
 * `level` is the highest level granted, if any (the caller caps it at the project's ceiling).
 * Approved pushes change no field: the run's push guard reads them.
 */
export function applyGrants(m: Manifest, grants: Grant[]): { manifest: Manifest; level?: number } {
  let manifest = m;
  let level: number | undefined;
  for (const g of grants) {
    if (g.kind === "folder") {
      manifest = {
        ...manifest,
        fs: { ...manifest.fs, write: [...new Set([...manifest.fs.write, ...g.folders])] },
      };
    } else if (g.kind === "integration") {
      if (!manifest.mcp.includes(g.id)) manifest = { ...manifest, mcp: [...manifest.mcp, g.id] };
    } else if (g.kind === "level") {
      level = Math.max(level ?? 0, g.level);
    }
  }
  return level === undefined ? { manifest } : { manifest, level };
}
