// ADR-0067 step 2: an agent's effective level compiled into the fields a run already uses
// (tools, shell, network, container, mcp and the tool lists per integration). Agents without a
// `level` never come here: their lists apply as written.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { type Catalog, type CatalogEntry, publishMode, secretRefs, toolClass } from "./catalog.ts";
import { isLocalModel } from "./check.ts";
import type { Manifest } from "./manifest.ts";
import type { ProjectClass } from "./projects.ts";

/**
 * A split agent's mode (ADR-0067: the open web never shares a run with draft+ account tools, nor
 * a host run with a shell). "accounts" is the work mode (shell and account tools, no open web);
 * the value keeps its stored name (tasks.run_mode, null = work).
 */
export type RunMode = "accounts" | "web";
/** Where a level 4+ shell runs. */
export type SandboxKind = "container" | "host" | "codex" | "gemini";

export interface CompiledIntegration {
  /** Tools the agent calls without asking (bare names). */
  tools: string[];
  /**
   * Tools that go through publishing (ADR-0037): `review` always asks the owner; the others
   * follow `mode` (the manifest's publish_mode, tightened by the project).
   */
  publish?: { mode: "review" | "auto"; tools: string[]; review: string[] };
}

export interface CompiledLevel {
  /** The level the run actually gets (after the local-model cap and a missing sandbox). */
  level: number;
  manifest: Manifest;
  integrations: Record<string, CompiledIntegration>;
  /**
   * The agent works in two modes: the open web would meet a shell or draft+ account tools.
   */
  split: boolean;
  mode?: RunMode;
  sandbox?: SandboxKind;
  /**
   * The hub tool push_branch: level 5 in work mode; the gateway pushes, never the shell, never
   * force (ADR-0067).
   */
  push?: true;
  /** Why the run got less than its effective level (one chat line each). */
  notes: string[];
  /** Integrations of the remit left out of this run, with the reason. */
  unavailable: string[];
  refusal?: string;
}

export interface CompileInput {
  /** Effective level for this run (`effectiveLevel`). */
  level: number;
  project: {
    class?: ProjectClass | undefined;
    spend_without_asking?: boolean | undefined;
    publish?: "review" | "off" | undefined;
  };
  catalog: Catalog;
  run: {
    /** provider/model the run uses. */
    model: string;
    mode?: RunMode | null | undefined;
    /** The install can run Apple containers (ADR-0051). */
    containerAvailable: boolean;
  };
}

const READ = ["Read", "Glob", "Grep"];
const WRITE = ["Edit", "Write"];
const WEB = ["WebFetch", "WebSearch"];
const LOCAL_CAP = 3;

const keyed = (e: CatalogEntry) => secretRefs(e).length > 0;

/** Direct, review and follow-publish_mode tools of one entry at a level. */
function grant(
  m: Manifest,
  e: CatalogEntry,
  level: number,
  project: CompileInput["project"],
): { direct: string[]; review: string[]; follow: string[] } {
  const out = { direct: [] as string[], review: [] as string[], follow: [] as string[] };
  const off = publishMode(m, e.id, project) === "off";
  for (const tool of [...e.tools.read, ...e.tools.write]) {
    const cls = toolClass(e, tool);
    if (cls === "read") out.direct.push(tool);
    else if (off) continue;
    else if (cls === "draft" || cls === "reversible") out.direct.push(tool);
    else if (level < 5) out.review.push(tool);
    else if (cls === "live") out.follow.push(tool);
    // Spending: always asks on a secured project, on an experimental one unless switched off.
    else if (project.class === "experimental" && project.spend_without_asking)
      out.follow.push(tool);
    else out.review.push(tool);
  }
  return out;
}

/** Compiles an effective level into the run's fields. Pure: the caller supplies the catalog. */
export function compileLevel(m: Manifest, input: CompileInput): CompiledLevel {
  const { catalog, run } = input;
  const base = { manifest: m, integrations: {}, split: false, notes: [], unavailable: [] };
  if (input.level <= 0) {
    return { ...base, level: 0, refusal: `${m.id} is switched off (level 0) and gets no work` };
  }
  const notes: string[] = [];
  const local = isLocalModel(run.model);
  // Local models: level 3 at most and never the open web (ADR-0067 guard).
  const level = local ? Math.min(input.level, LOCAL_CAP) : input.level;
  const entries: CatalogEntry[] = [];
  for (const id of m.mcp) {
    const entry = catalog.get(id);
    if (!entry) return { ...base, level, refusal: `integration ${id} is not in the catalog` };
    entries.push(entry);
  }
  return compileAt(m, input, level, entries, notes, local);
}

function compileAt(
  m: Manifest,
  input: CompileInput,
  level: number,
  entries: CatalogEntry[],
  given: string[],
  local: boolean,
): CompiledLevel {
  const { project, run } = input;
  const notes = [...given];
  const grants = level >= 3 ? entries.map((e) => ({ e, g: grant(m, e, level, project) })) : [];
  // ADR-0067 guards: the open web shares no run with account tools of class draft and above,
  // and no host run with a shell (level 4+). Such an agent works in two modes: work (shell and
  // account tools, no open web) and web (open web, neither of them).
  const split = level >= 3 && !local && (level >= 4 || grants.some(({ e, g }) => writesOf(e, g)));
  const mode: RunMode | undefined = split ? (run.mode ?? "accounts") : undefined;
  const web = level >= 2 && !local && mode !== "accounts";
  // Work mode keeps the documentation hosts of the remit (never "*"); project sites (ADR-0057)
  // and the package registries are added by the run.
  const remitHosts = mode === "accounts" ? m.network.allow.filter((h) => h !== "*") : [];
  const unavailable: string[] = [];
  const integrations: Record<string, CompiledIntegration> = {};
  for (const { e, g } of grants) {
    if (mode === "web") {
      // Web half: keyed integrations leave the run, keyless ones keep their read tools (local
      // apps then leave with the container below).
      if (keyed(e)) {
        unavailable.push(`${e.id} (account tools are not available while you read the web)`);
        continue;
      }
      const reads = g.direct.filter((t) => toolClass(e, t) === "read");
      if (reads.length) integrations[e.id] = { tools: reads };
      continue;
    }
    const pub = [...g.review, ...g.follow];
    const follows = publishMode(m, e.id, project) === "auto" ? "auto" : "review";
    integrations[e.id] = {
      tools: g.direct,
      ...(pub.length ? { publish: { mode: follows, tools: pub, review: g.review } } : {}),
    };
  }
  const keyedInRun = entries.some((e) => integrations[e.id] && keyed(e));
  const provider = run.model.slice(0, run.model.indexOf("/"));
  let sandbox: SandboxKind | undefined;
  // Web mode has no shell.
  if (level >= 4 && mode !== "web") {
    if (provider === "cli-codex") sandbox = "codex";
    else if (provider === "cli-gemini") sandbox = "gemini";
    else if (provider === "cli-claude") {
      // ADR-0055: a shell next to keys only in a container (with the work mode's hosts).
      // Owner-approved exception: keys beside a host shell.
      if (!keyedInRun || m.keys_beside_host_shell) sandbox = "host";
      else if (run.containerAvailable) sandbox = "container";
    }
    if (!sandbox) {
      const why =
        provider === "cli-claude"
          ? "its shell would need an Apple container (integrations with credentials), which this install cannot run"
          : `${provider} has no sandbox for a shell`;
      return compileAt(
        m,
        input,
        3,
        entries,
        [...notes, `${m.id} runs at level 3 instead of ${level} for this task: ${why}`],
        local,
      );
    }
  }
  // ADR-0051: every Claude run with the open web runs in a container, a split agent's web mode
  // included (one rule for every open-web run).
  const container = sandbox === "container" || (provider === "cli-claude" && web);
  if (container) {
    // ADR-0054: apps on this Mac are not reachable from the container.
    for (const e of entries) {
      if (!e.app || !integrations[e.id]) continue;
      delete integrations[e.id];
      const conflict = sandbox === "container" && keyedInRun;
      const why = `${e.app.name} on this Mac is not reachable from the Apple container this run needs for ${conflict ? "a shell next to integrations with credentials" : "the open web"}`;
      unavailable.push(`${e.id} (${why})`);
      // A remit that cannot work as set up is said in the chat, not only to the agent.
      if (conflict) notes.push(`${m.id} works without ${e.id} in this task: ${why}`);
    }
  }
  const { shell: _shell, ...rest } = m;
  const manifest: Manifest = {
    ...rest,
    tools: [
      ...READ,
      ...(level >= 2 ? WRITE : []),
      ...(web ? WEB : remitHosts.length ? ["WebFetch"] : []),
      ...(sandbox ? ["Bash"] : []),
    ],
    network: { allow: web ? ["*"] : remitHosts },
    container,
    mcp: entries.filter((e) => integrations[e.id]).map((e) => e.id),
  };
  const push = level >= 5 && mode === "accounts";
  return {
    level,
    manifest,
    integrations,
    split,
    ...(mode ? { mode } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(push ? { push: true as const } : {}),
    notes,
    unavailable,
  };
}

/** Whether an entry gives this run any tool of class draft or above. */
function writesOf(e: CatalogEntry, g: { direct: string[]; review: string[]; follow: string[] }) {
  return (
    g.review.length > 0 || g.follow.length > 0 || g.direct.some((t) => toolClass(e, t) !== "read")
  );
}

/**
 * Remit setups that cannot work as compiled, for the agent page: a level 4 shell next to keyed
 * integrations needs a container in work mode, where the agent's local apps (ADR-0054) cannot be
 * reached. A shell alone no longer does: the open web is in the other mode.
 */
export function levelConflicts(m: Manifest, catalog: Catalog): string[] {
  if ((m.level ?? 0) < 4 || m.keys_beside_host_shell) return [];
  const entries = m.mcp.map((id) => catalog.get(id)).filter((e): e is CatalogEntry => !!e);
  const keys = entries.filter(keyed).map((e) => e.id);
  const apps = entries.filter((e) => e.app).map((e) => e.app?.name as string);
  if (!keys.length || !apps.length) return [];
  return [
    `${m.id}: a level 4 shell next to integrations with credentials (${keys.join(", ")}) runs in an Apple container, where ${apps.join(" and ")} on this Mac cannot be reached; those runs leave ${apps.length > 1 ? "them" : "it"} out`,
  ];
}

// Package registries a level 4 shell may reach (ADR-0067: "packages from known registries").
export const REGISTRY_HOSTS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "api.nuget.org",
  "crates.io",
  "static.crates.io",
  "rubygems.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
];

// No shell pushes (level 5 pushes through push_branch, run by the gateway) and history rewrite
// is refused at every level. Prefix rules are best effort (`sh -c '…'` passes them): the git
// environment of every run (GIT_SHELL_ENV) is what keeps a shell push without credentials.
export const SHELL_DENY = [
  "Bash(git push:*)",
  "Bash(git filter-branch:*)",
  "Bash(git filter-repo:*)",
];

/**
 * Folders under the user's home a host shell may read (ADR-0067): toolchains builds need, only
 * those present. Directories of programs, never of credentials.
 */
export const HOME_TOOLCHAINS = [
  ".local/bin",
  ".local/share/fnm",
  ".local/share/mise",
  ".nvm",
  ".volta",
  ".bun/bin",
  ".pyenv",
  ".rbenv",
  ".asdf",
  ".cargo/bin",
  ".rustup",
  ".dotnet",
  ".swiftpm",
  "Library/Developer",
];

/**
 * Credential files and folders under the user's home, denied by name as well as with the home
 * itself: a run folder or toolchain that is or contains one of them is never re-allowed.
 */
export const HOME_KEYS = [
  ".ssh",
  ".aws",
  ".azure",
  ".config",
  ".gnupg",
  "Library/Keychains",
  ".git-credentials",
  ".config/git/credentials",
  ".netrc",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pypirc",
  ".docker",
  ".kube",
  ".gem",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".nuget",
  ".gradle",
  ".m2",
  ".terraform.d",
  ".vault-token",
  ".claude",
  ".claude.json",
  ".codex",
  ".gemini",
];

/**
 * Environment of a host-sandbox shell (ADR-0067): package caches in the run's own writable
 * `cache` folder. User config files are not redirected here: the CLI's environment scrub
 * (CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, claude 2.1.331) drops GIT_CONFIG_GLOBAL, XDG_CONFIG_HOME,
 * npm_config_userconfig and PIP_CONFIG_FILE before Bash, so the sandbox's read denies keep
 * `~/.npmrc` and the like out, and git reads only a global config without secrets
 * (`gitConfigReads`). CARGO_HOME stays: it also holds the rustup proxies on PATH.
 */
export function hostShellEnv(cache: string): Record<string, string> {
  return {
    npm_config_cache: join(cache, "npm"),
    npm_config_store_dir: join(cache, "pnpm"),
    YARN_CACHE_FOLDER: join(cache, "yarn"),
    BUN_INSTALL_CACHE_DIR: join(cache, "bun"),
    PIP_CACHE_DIR: join(cache, "pip"),
    NUGET_PACKAGES: join(cache, "nuget"),
  };
}

/** Git config content that may hold a credential (a token, a password, a URL with a user). */
export const GIT_SECRET = /token|password|passwd|_auth|secret|bearer|https?:\/\/[^/\s]+@/i;

// Keys whose value is a file git opens (an unreadable include stops git; the others warn).
const GIT_FILE_KEYS =
  /^(include\.path|includeif\..*\.path|core\.excludesfile|core\.attributesfile|commit\.template)$/i;

/**
 * The user's global git config files a host shell may read: git stops on an unreadable
 * `~/.gitconfig` or `~/.config/git/config` and the CLI's scrub drops GIT_CONFIG_GLOBAL. Only
 * files without secret-looking content (`GIT_SECRET`), with the files they name (includes too,
 * checked the same way); `credential.helper` is emptied for every run (GIT_SHELL_ENV).
 */
export function gitConfigReads(user: string): string[] {
  const out: string[] = [];
  const configFile = (f: string) => {
    if (out.includes(f) || !existsSync(f) || !statSync(f).isFile()) return;
    if (GIT_SECRET.test(readFileSync(f, "utf8"))) return;
    out.push(f);
    let list = "";
    try {
      list = execFileSync("git", ["config", "--file", f, "--no-includes", "--null", "--list"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return;
    }
    for (const item of list.split("\0")) {
      const nl = item.indexOf("\n");
      const key = item.slice(0, nl);
      if (nl < 0 || !GIT_FILE_KEYS.test(key)) continue;
      let p = item.slice(nl + 1);
      if (p.startsWith("~/")) p = join(user, p.slice(2));
      else if (!isAbsolute(p)) {
        if (!key.toLowerCase().startsWith("include")) continue;
        p = join(dirname(f), p);
      }
      if (key.toLowerCase().startsWith("include")) configFile(p);
      else if (existsSync(p) && statSync(p).isFile()) out.push(p);
    }
  };
  configFile(join(user, ".gitconfig"));
  configFile(join(user, ".config/git/config"));
  return out;
}

/**
 * Install folders of the symlinked programs in toolchain folders (`~/.local/bin/node` →
 * `~/.local/opt/node-v24/bin/node` brings `~/.local/opt/node-v24`): the first link target in a
 * `bin` folder brings that folder's parent; a chain that ends elsewhere brings its last target.
 */
export function symlinkTargets(dirs: string[]): string[] {
  const out = new Set<string>();
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      let p = join(dir, name);
      for (
        let hop = 0;
        hop < 16 && lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink();
        hop++
      ) {
        const next = resolve(dirname(p), readlinkSync(p));
        if (!existsSync(dirname(next))) break;
        p = join(realpathSync(dirname(next)), basename(next));
        if (basename(dirname(p)) === "bin") {
          out.add(dirname(dirname(p)));
          break;
        }
        if (existsSync(p) && !lstatSync(p).isSymbolicLink()) out.add(p);
      }
    }
  }
  return [...out];
}

/**
 * The claude CLI's own sandbox for a level 4 shell on the host (`--settings`): commands write only
 * to the run's folders, reach only registries and the run's hosts, and read nothing of the user's
 * home or achords' home but the run's own folders and the toolchains present; credential files
 * stay denied by name. Only the remit's `unsandboxed` executables leave it.
 */
export function hostSandboxSettings(input: {
  /** The run's work folders (absolute), its cache folder included. */
  write: string[];
  /** Everything the run may read (its folders, skills, chat images). */
  own: string[];
  /** The run's allowed hosts (`network.allow`, "*" left out). */
  network: string[];
  unsandboxed: string[];
  achordsHome: string;
  userHome?: string;
  /** The run's PATH (default: the gateway's): its folders under the home are toolchains too. */
  path?: string[];
}): Record<string, unknown> {
  const user = input.userHome ?? homedir();
  const hosts = input.network.filter((h) => h !== "*").map((h) => h.split("/")[0] as string);
  const inside = (p: string, root: string) => p === root || p.startsWith(`${root}/`);
  const keys = HOME_KEYS.map((p) => join(user, p));
  const denied = [user, input.achordsHome];
  // A PATH folder `…/<install>/bin` brings its install folder (node's lib/node_modules), but
  // never a folder right below the home (`~/.local`, `~/.cargo`).
  const onPath = (input.path ?? (process.env.PATH ?? "").split(":"))
    .filter((p) => p.startsWith(`${user}/`))
    .flatMap((p) => {
      const parent = dirname(p);
      const deep = parent.slice(user.length + 1).includes("/");
      return p.endsWith("/bin") && deep ? [p, parent] : [p];
    });
  const toolchains = [...HOME_TOOLCHAINS.map((p) => join(user, p)), ...onPath].filter(
    (p) => existsSync(p) && statSync(p).isDirectory(),
  );
  // Re-allowed only below a denied root, and never a folder that is or holds a denied one.
  const readable = (p: string) =>
    denied.some((root) => inside(p, root)) &&
    ![...denied, ...keys].some((d) => inside(d, p)) &&
    !keys.some((k) => inside(p, k));
  // An install folder right below the home (`~/.local`) is too wide.
  const deep = (p: string) => !inside(p, user) || p.slice(user.length + 1).includes("/");
  const installs = symlinkTargets(toolchains).filter(
    (p) => deep(p) && !inside(p, input.achordsHome),
  );
  // Git config files sit in ~/.config/git, denied with ~/.config: re-allowed by file only.
  const config = join(user, ".config");
  const gitFiles = gitConfigReads(user).filter(
    (p) =>
      inside(p, user) &&
      !inside(p, input.achordsHome) &&
      !keys.some((k) => k !== config && inside(p, k)) &&
      (!inside(p, config) || inside(p, join(config, "git"))),
  );
  return {
    sandbox: {
      enabled: true,
      // Never fall back to running commands unsandboxed.
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [...input.unsandboxed],
      network: {
        allowedDomains: [...new Set([...REGISTRY_HOSTS, ...hosts])],
        strictAllowlist: true,
      },
      filesystem: {
        allowWrite: [...new Set(input.write)],
        denyRead: [...new Set([...denied, ...keys])],
        allowRead: [
          ...new Set([
            ...[...input.own, ...input.write, ...toolchains, ...installs].filter(readable),
            ...gitFiles,
          ]),
        ],
      },
    },
    permissions: {
      deny: SHELL_DENY,
      // The excluded executables still need an allow rule: they run outside the sandbox.
      allow: input.unsandboxed.map((p) => `Bash(${p}:*)`),
    },
  };
}
