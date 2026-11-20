import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Manifest } from "./manifest.ts";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VAULT_REF = /^vault:[a-z0-9{][a-z0-9_.{}-]*$/;
// MCP tool names as the CLI exposes them: mcp__<server>__<tool>.
const TOOL = /^[A-Za-z0-9_-]{1,64}$/;

/** One integration (ADR-0034): an MCP server, its credentials and the tools agents may use. */
export const catalogEntrySchema = z
  .object({
    id: z.string().regex(ID),
    name: z.string().min(1),
    description: z.string().default(""),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    // Literal values or vault references; `{project}` in a reference is the task's project.
    env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string()).default({}),
    hosts: z.array(z.string().min(1)).default([]),
    tools: z
      .object({
        read: z.array(z.string().regex(TOOL)).default([]),
        write: z.array(z.string().regex(TOOL)).default([]),
      })
      .strict()
      .default({ read: [], write: [] }),
  })
  .strict()
  .superRefine((e, ctx) => {
    for (const [key, value] of Object.entries(e.env)) {
      if (value.startsWith("vault:") && !VAULT_REF.test(value)) {
        ctx.addIssue({ code: "custom", path: ["env", key], message: "invalid vault reference" });
      }
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

/** Vault ids an entry needs, with `{project}` filled in (or left as is without a project). */
export function secretRefs(entry: CatalogEntry, project?: string): string[] {
  return Object.values(entry.env)
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

/** CLI tool names an agent may call on an entry; write tools wait for publishing review. */
export const allowedIntegrationTools = (entry: CatalogEntry): string[] =>
  entry.tools.read.map((t) => `mcp__${entry.id}__${t}`);
