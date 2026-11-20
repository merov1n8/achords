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
// Literal or `vault:<id>`; `{project}` in a vault id is the task's project.
const value = z.string();

/** One integration (ADR-0034): an MCP server, its credentials and the tools agents may use. */
export const catalogEntrySchema = z
  .object({
    id: z.string().regex(ID),
    name: z.string().min(1),
    description: z.string().default(""),
    // An ecosystem server (command + pinned package) or one shipped with achords (`builtin`).
    command: z.string().min(1).optional(),
    builtin: z.enum(["wordpress"]).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string().regex(ENV), value).default({}),
    // Servers that read credentials from a file: the env var gets the path of a private JSON
    // file with these fields, written by the launcher and deleted when the server exits.
    files: z.record(z.string().regex(ENV), z.record(z.string(), value)).default({}),
    hosts: z.array(z.string().min(1)).default([]),
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
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (!e.command === !e.builtin) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "set either command or builtin" });
    }
    const check = (v: string, path: string[]) => {
      if (v.startsWith("vault:") && !VAULT_REF.test(v)) {
        ctx.addIssue({ code: "custom", path, message: "invalid vault reference" });
      }
    };
    for (const [key, v] of Object.entries(e.env)) check(v, ["env", key]);
    for (const [key, fields] of Object.entries(e.files)) {
      for (const [field, v] of Object.entries(fields)) check(v, ["files", key, field]);
    }
  });

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
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
  return [...new Set(values.map(accountRef).filter((c): c is string => c !== undefined))];
}

/** Vault ids an entry needs, with `{project}` filled in (or left as is without a project). */
export function secretRefs(entry: CatalogEntry, project?: string): string[] {
  const values = [
    ...Object.values(entry.env),
    ...Object.values(entry.files).flatMap((f) => Object.values(f)),
  ];
  return values
    .filter((v) => v.startsWith("vault:"))
    .map((v) => (project ? v.replaceAll("{project}", project) : v));
}

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
    return scope.free.includes(tool)
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
  /** Owner-wide vault ids that are not set. */
  missingSecrets: string[];
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
    const missingSecrets = refs
      .filter((r) => !r.includes("{project}"))
      .map(vaultId)
      .filter((id) => !hasSecret(id));
    const projectsReady = perProject
      ? projectList
          .filter((p) => secretRefs(entry, p.slug).every((r) => hasSecret(vaultId(r))))
          .filter((p) => accounts.every((c) => p.integrations[c]?.length))
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
      missingSecrets,
      perProject,
      projectsReady,
      scoped: entry.scope !== undefined,
      projectsScoped,
      testable: entry.test !== undefined,
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
  return (entry.scope?.channels ?? [entry.id]).flatMap((c) => accounts?.[c] ?? []);
}
