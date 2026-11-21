import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Manifest } from "./manifest.ts";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VAULT_REF = /^vault:[a-z0-9{][a-z0-9_.{}-]*$/;
// MCP tool names as the CLI exposes them: mcp__<server>__<tool>.
const TOOL = /^[A-Za-z0-9_-]{1,64}$/;
const ENV = /^[A-Z_][A-Z0-9_]*$/;
// macOS app and process names: passed as argv only, never into a script.
const APP = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
// Literal or `vault:<id>`; `{project}` in a vault id is the task's project. `{workdir}` in a
// literal is the run's working folder (also writable by the agent).
const value = z.string();

/** One integration (ADR-0034): an MCP server, its credentials and the tools agents may use. */
export const catalogEntrySchema = z
  .object({
    id: z.string().regex(ID),
    name: z.string().min(1),
    description: z.string().default(""),
    // An ecosystem server (command + pinned package), one shipped with achords (`builtin`) or a
    // remote server over Streamable HTTP (`url`, its host listed in `hosts`).
    command: z.string().min(1).optional(),
    builtin: z.enum(["wordpress"]).optional(),
    url: z.string().url().optional(),
    // Remote servers: the Authorization header, `<scheme> <secret>`.
    authorization: z
      .object({ scheme: z.string().regex(/^[A-Za-z]+$/), secret: z.string().regex(VAULT_REF) })
      .strict()
      .optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string().regex(ENV), value).default({}),
    // Servers that read credentials from a file: the env var gets the path of a private JSON
    // file with these fields, written by the launcher and deleted when the server exits.
    files: z.record(z.string().regex(ENV), z.record(z.string(), value)).default({}),
    hosts: z.array(z.string().min(1)).default([]),
    // How the owner signs in from the web (ADR-0048): "google" = the shared Google sign-in that
    // fills the google-* vault ids; without it the owner types the entry's vault secrets.
    oauth: z.enum(["google"]).optional(),
    // What to install when `command` is not on the gateway's PATH (shown on the web page).
    install: z.string().min(1).optional(),
    tools: z
      .object({
        read: z.array(z.string().regex(TOOL)).default([]),
        write: z.array(z.string().regex(TOOL)).default([]),
      })
      .strict()
      .default({ read: [], write: [] }),
    // Connection test (web Integrations page): one cheap read call; "{target}" in an argument is
    // the project's first own target (its property, site or page).
    test: z
      .object({ tool: z.string().regex(TOOL), args: z.record(z.string(), z.string()).default({}) })
      .strict()
      .optional(),
    // Per-client scope (ADR-0036): a shared account reaches every client, so in a project run
    // the launcher only passes calls whose `args` values are the project's own (project.yaml
    // `integrations.<id>`). Tools without such an argument are refused unless listed in `free`.
    scope: z
      .object({
        args: z.array(z.string().regex(TOOL)).min(1),
        free: z.array(z.string().regex(TOOL)).default([]),
        // Prefix ignored when comparing, e.g. "properties/" for GA4 property ids.
        strip: z.string().optional(),
        // Project account channels holding the allowed values (default: the entry's id), e.g.
        // [facebook, instagram] for Meta page and Instagram account ids.
        channels: z.array(z.string().regex(ID)).optional(),
        // The argument may be left out when the project has exactly one target (the server
        // then uses the only one it was given), e.g. a WordPress site.
        optional: z.boolean().default(false),
      })
      .strict()
      .optional(),
    // Several targets with their own credentials (ADR-0047), e.g. a client's WordPress sites:
    // each address in the project's `channel` list has its own vault ids (`{site}` = slug of
    // the address). The server gets `env` = JSON [{url, ...secrets}] of the sites whose
    // credentials are set; the others are left out of the run.
    sites: z
      .object({
        channel: z.string().regex(ID),
        env: z.string().regex(ENV),
        secrets: z.record(z.string(), z.string().regex(VAULT_REF)),
        // Ids from before several sites: used for the first site when its own are not set.
        first: z.record(z.string(), z.string().regex(VAULT_REF)).optional(),
      })
      .strict()
      .optional(),
    // ADR-0054: the app on this Mac the server talks to (Blender, Unity Editor). achords opens it
    // for a run when it is not running and quits it once no active task needs it.
    app: z
      .object({
        name: z.string().regex(APP),
        // Arguments of macOS `open`, fixed here; `{workdir}` is the run's working folder.
        open: z.array(z.string().min(1)).min(1),
        // Process name for the running check (default: name).
        process: z.string().regex(APP).optional(),
        // A file the working folder must contain before the app is opened for it, e.g. the
        // Unity project marker; without it nothing is opened.
        requires: z.string().min(1).optional(),
        // Ready once something listens on this local port (the add-on or bridge socket).
        ready: z
          .object({
            port: z.number().int().min(1).max(65535),
            timeout_s: z.number().int().min(1).max(300).default(90),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if ([e.command, e.builtin, e.url].filter(Boolean).length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["command"],
        message: "set one of command, builtin or url",
      });
    }
    if (e.url) {
      const u = new URL(e.url);
      if (u.protocol !== "https:" || !e.hosts.includes(u.hostname)) {
        ctx.addIssue({ code: "custom", path: ["url"], message: "https on a host listed in hosts" });
      }
    }
    // Opened in the background: the owner's work in the foreground is never interrupted.
    const end = e.app?.open.indexOf("--args") ?? -1;
    if (e.app && !e.app.open.slice(0, end < 0 ? undefined : end).includes("-g")) {
      ctx.addIssue({ code: "custom", path: ["app", "open"], message: "include -g" });
    }
    if (e.app?.requires && (e.app.requires.startsWith("/") || e.app.requires.includes(".."))) {
      ctx.addIssue({ code: "custom", path: ["app", "requires"], message: "a relative path" });
    }
    if (e.authorization && !e.url) {
      ctx.addIssue({ code: "custom", path: ["authorization"], message: "only for a url" });
    }
    const check = (v: string, path: string[]) => {
      if (v.startsWith("vault:") && !VAULT_REF.test(v)) {
        ctx.addIssue({ code: "custom", path, message: "invalid vault reference" });
      }
    };
    if (e.sites?.first) {
      const keys = (r: Record<string, string>) => Object.keys(r).sort().join(",");
      if (keys(e.sites.first) !== keys(e.sites.secrets)) {
        ctx.addIssue({
          code: "custom",
          path: ["sites", "first"],
          message: "same fields as secrets",
        });
      }
    }
    for (const [key, v] of Object.entries(e.env)) check(v, ["env", key]);
    for (const [key, fields] of Object.entries(e.files)) {
      for (const [field, v] of Object.entries(fields)) check(v, ["files", key, field]);
    }
  });

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
export type CatalogApp = NonNullable<CatalogEntry["app"]>;
export type Catalog = Map<string, CatalogEntry>;

function readDir(dir: string, into: Catalog): void {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()) {
    const entry = catalogEntrySchema.parse(parseYaml(readFileSync(join(dir, file), "utf8")));
    into.set(entry.id, entry);
  }
}

/** Shipped entries first, then the owner's: an owner file with the same id replaces the shipped one. */
export function loadCatalog(seedDir: string, ownerDir: string): Catalog {
  const catalog: Catalog = new Map();
  readDir(seedDir, catalog);
  readDir(ownerDir, catalog);
  return catalog;
}

/** `{account:<channel>}`: a non-secret value from the project's accounts (first entry). */
export function accountRef(value: string): string | undefined {
  return /^\{account:([a-z0-9][a-z0-9-]{0,63})\}$/.exec(value)?.[1];
}

/** Project account channels an entry reads its settings from. */
export function accountRefs(entry: CatalogEntry): string[] {
  const values = [
    ...Object.values(entry.env),
    ...Object.values(entry.files).flatMap((f) => Object.values(f)),
  ];
  const channels = values.map(accountRef).filter((c): c is string => c !== undefined);
  return [...new Set([...channels, ...(entry.sites ? [entry.sites.channel] : [])])];
}

/**
 * Vault ids an entry needs, with `{project}` filled in (or left as is without a project).
 * Per-site ids keep their `{site}`.
 */
export function secretRefs(entry: CatalogEntry, project?: string): string[] {
  const values = [
    ...Object.values(entry.env),
    ...Object.values(entry.files).flatMap((f) => Object.values(f)),
    ...Object.values(entry.sites?.secrets ?? {}),
    ...(entry.authorization ? [entry.authorization.secret] : []),
  ];
  return values
    .filter((v) => v.startsWith("vault:"))
    .map((v) => (project ? v.replaceAll("{project}", project) : v));
}

/** Owner-wide vault ids of an entry (no `{project}` or `{site}`), without the `vault:` prefix. */
export const ownerSecrets = (entry: CatalogEntry): string[] => [
  ...new Set(
    secretRefs(entry)
      .filter((r) => !r.includes("{project}") && !r.includes("{site}"))
      .map((r) => r.slice("vault:".length)),
  ),
];

/**
 * The integrations a manifest may use, or the reason it may not. Deny by default: unknown ids,
 * and secrets next to a shell (same-user processes can read each other's environment).
 */
export function grantedIntegrations(
  manifest: Manifest,
  catalog: Catalog,
): { ok: true; entries: CatalogEntry[] } | { ok: false; reason: string } {
  const entries: CatalogEntry[] = [];
  for (const id of manifest.mcp) {
    const entry = catalog.get(id);
    if (!entry) return { ok: false, reason: `integration ${id} is not in the catalog` };
    if (manifest.shell && secretRefs(entry).length) {
      return {
        ok: false,
        reason: `integration ${id} uses credentials and agent ${manifest.id} has a shell`,
      };
    }
    entries.push(entry);
  }
  return { ok: true, entries };
}

/**
 * CLI tool names an agent may call on an entry. Write tools wait for publishing review, except
 * on a local integration (no credentials) while the owner granted full access (ADR-0035).
 */
export const allowedIntegrationTools = (entry: CatalogEntry, elevated = false): string[] =>
  [...entry.tools.read, ...(elevated && !secretRefs(entry).length ? entry.tools.write : [])].map(
    (t) => `mcp__${entry.id}__${t}`,
  );

export interface CallScope {
  args: string[];
  free: string[];
  strip?: string | undefined;
  /** The project's own values (properties, sites, pages). */
  allowed: string[];
  /** The argument may be left out in this run (the project has exactly one target). */
  optional?: boolean | undefined;
}

/** Why a tool call leaves the project's scope, or undefined when it may pass. */
export function scopeRefusal(
  scope: CallScope,
  tool: string,
  input: Record<string, unknown> | undefined,
): string | undefined {
  const norm = (v: string) =>
    scope.strip && v.startsWith(scope.strip) ? v.slice(scope.strip.length) : v;
  const allowed = new Set(scope.allowed.map(norm));
  const values: unknown[] = [];
  for (const arg of scope.args) {
    const v = input?.[arg];
    if (v === undefined) continue;
    values.push(...(Array.isArray(v) ? v : [v]));
  }
  if (!values.length) {
    return scope.free.includes(tool) || scope.optional
      ? undefined
      : `${tool} is not limited to this project's ${scope.args[0]}; use a tool that takes one`;
  }
  const foreign = values.find(
    (v) => !(typeof v === "string" || typeof v === "number") || !allowed.has(norm(String(v))),
  );
  return foreign === undefined
    ? undefined
    : `${String(foreign)} is not part of this project (allowed: ${scope.allowed.join(", ")})`;
}

export interface IntegrationStatus {
  id: string;
  name: string;
  /** Agents whose manifest lists it. */
  usedBy: string[];
  /** Program that starts the server (undefined for builtin servers). */
  command?: string;
  commandFound: boolean;
  /** Owner-wide vault ids the entry uses (ids only, never values). */
  secrets: string[];
  /** Owner-wide vault ids that are not set. */
  missingSecrets: string[];
  /** Web sign-in kind (catalog `oauth`), e.g. "google". */
  oauth?: "google";
  /** Install hint for a missing program. */
  install?: string;
  /** Credentials per client project (`{project}`): the projects that have all of them. */
  perProject: boolean;
  projectsReady: string[];
  /** Scoped shared account (ADR-0036): projects that name their own targets. */
  scoped: boolean;
  projectsScoped: string[];
  /** Usable in at least one run. */
  ready: boolean;
  /** Has a connection test (one read call). */
  testable: boolean;
  /** Entries with several sites (ADR-0047): every project site and the vault ids it lacks. */
  sites: { project: string; url: string; ready: boolean; missing: string[] }[];
  /**
   * For grouping on the web page: one owner-wide sign-in shared by all work ("account"),
   * credentials per client ("client"), or nothing to sign in to ("local").
   */
  kind: "account" | "client" | "local";
}

/** What an integration still needs: program on the service PATH, vault secrets, project setup. */
export function integrationStatus(
  catalog: Catalog,
  agents: Iterable<Manifest>,
  projects: Iterable<{ slug: string; integrations: Record<string, string[]> }>,
  hasSecret: (id: string) => boolean,
  onPath: (bin: string) => boolean,
): IntegrationStatus[] {
  const agentList = [...agents];
  const projectList = [...projects];
  const vaultId = (ref: string) => ref.slice("vault:".length);
  return [...catalog.values()].map((entry) => {
    const refs = secretRefs(entry);
    const accounts = accountRefs(entry);
    const perProject = refs.some((r) => r.includes("{project}")) || accounts.length > 0;
    const secrets = ownerSecrets(entry);
    const missingSecrets = secrets.filter((id) => !hasSecret(id));
    const sites = entry.sites
      ? projectList.flatMap((p) =>
          siteStatus(
            entry,
            p.slug,
            p.integrations[entry.sites?.channel ?? ""] ?? [],
            hasSecret,
          ).map((s) => ({ project: p.slug, url: s.url, ready: s.ready, missing: s.missing })),
        )
      : [];
    const projectsReady = perProject
      ? projectList
          .filter((p) =>
            secretRefs(entry, p.slug)
              .filter((r) => !r.includes("{site}"))
              .every((r) => hasSecret(vaultId(r))),
          )
          .filter((p) => accounts.every((c) => p.integrations[c]?.length))
          .filter((p) => !entry.sites || sites.some((s) => s.project === p.slug && s.ready))
          .map((p) => p.slug)
      : [];
    const projectsScoped = entry.scope
      ? projectList.filter((p) => scopeTargets(entry, p.integrations).length).map((p) => p.slug)
      : [];
    const commandFound = entry.command ? onPath(entry.command) : true;
    return {
      id: entry.id,
      name: entry.name,
      usedBy: agentList.filter((m) => m.mcp.includes(entry.id)).map((m) => m.id),
      ...(entry.command ? { command: entry.command } : {}),
      commandFound,
      secrets,
      missingSecrets,
      ...(entry.oauth ? { oauth: entry.oauth } : {}),
      ...(entry.install ? { install: entry.install } : {}),
      perProject,
      projectsReady,
      scoped: entry.scope !== undefined,
      projectsScoped,
      testable: entry.test !== undefined,
      sites,
      kind: entry.sites || perProject ? "client" : refs.length > 0 ? "account" : "local",
      ready:
        commandFound &&
        missingSecrets.length === 0 &&
        (!perProject || projectsReady.length > 0) &&
        (!entry.scope || projectsScoped.length > 0),
    };
  });
}

export type PublishMode = "review" | "auto" | "off";

/**
 * How an agent's write calls to an integration are handled (ADR-0037): the manifest's channel
 * setting (channel = integration id) or its default, tightened by the project, never loosened.
 */
export function publishMode(
  manifest: Manifest,
  integration: string,
  project?: { publish?: "review" | "off" | undefined },
): PublishMode {
  if (project?.publish === "off") return "off";
  const mode = manifest.publish_mode.channels[integration] ?? manifest.publish_mode.default;
  return project?.publish === "review" ? "review" : mode;
}

/** The project's own values for a scoped entry (ADR-0036), from its account channels. */
export function scopeTargets(
  entry: CatalogEntry,
  accounts: Record<string, string[]> | undefined,
): string[] {
  return (entry.scope?.channels ?? [entry.sites?.channel ?? entry.id]).flatMap(
    (c) => accounts?.[c] ?? [],
  );
}

/** `{site}` in a per-site vault id: the address without scheme, lowercased, dashes elsewhere. */
export function siteSlug(url: string): string {
  return url
    .replace(/^[a-z]+:\/\//i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Vault ids are at most 64 characters; a longer one is cut and keeps a hash of the whole id.
const fitId = (id: string) =>
  id.length <= 64
    ? id
    : `${id.slice(0, 55).replace(/-+$/, "")}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;

/**
 * Vault ids (field → id) one site may use, in the order they are tried: its own, then for the
 * first site (`index` 0) the ids from before several sites.
 */
export function siteCredentials(
  entry: CatalogEntry,
  project: string,
  url: string,
  index: number,
): Record<string, string>[] {
  if (!entry.sites) return [];
  const ids = (refs: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(refs).map(([field, ref]) => [
        field,
        fitId(
          ref
            .slice("vault:".length)
            .replaceAll("{project}", project)
            .replaceAll("{site}", siteSlug(url)),
        ),
      ]),
    );
  const { secrets, first } = entry.sites;
  return [ids(secrets), ...(index === 0 && first ? [ids(first)] : [])];
}

export interface SiteStatus {
  url: string;
  /** Vault ids to set for this site (field → id). */
  secrets: Record<string, string>;
  /** Ids of `secrets` not set yet (empty once the site is ready). */
  missing: string[];
  /** Ready through the ids from before several sites (first site only). */
  legacy: boolean;
  ready: boolean;
}

/** Per site of a project: which credentials are set (never their values). */
export function siteStatus(
  entry: CatalogEntry,
  project: string,
  urls: string[],
  hasSecret: (id: string) => boolean,
): SiteStatus[] {
  return urls.map((url, i) => {
    const [own = {}, legacy] = siteCredentials(entry, project, url, i);
    const ownMissing = Object.values(own).filter((id) => !hasSecret(id));
    const viaLegacy =
      ownMissing.length > 0 && legacy !== undefined && Object.values(legacy).every(hasSecret);
    const ready = ownMissing.length === 0 || viaLegacy;
    return { url, secrets: own, missing: ready ? [] : ownMissing, legacy: viaLegacy, ready };
  });
}
