import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Document, parseDocument, stringify } from "yaml";
import { parseManifest } from "./manifest.ts";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Edits agent.yaml keeping comments and layout; validates the whole result before writing. */
function editManifest(path: string, change: (doc: Document) => void): void {
  const doc = parseDocument(readFileSync(path, "utf8"));
  change(doc);
  const text = doc.toString({ flowCollectionPadding: false }); // [a, b] like hand-written files
  parseManifest(text, path); // throws with field paths if invalid
  // Atomic replace, same permissions.
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: statSync(path).mode & 0o777 });
  renameSync(tmp, path);
}

/** Changes an agent's models; on any error the file is left untouched. */
export function updateManifestModels(
  path: string,
  models: { default: string; allowed: string[] },
): void {
  editManifest(path, (doc) => {
    doc.setIn(["models", "default"], models.default);
    // Keep the list style the owner wrote (block "- x" lines or flow "[x, y]"); flow if new.
    const old = doc.getIn(["models", "allowed"], true) as { flow?: boolean } | undefined;
    const flow = old ? old.flow === true : true;
    doc.setIn(["models", "allowed"], doc.createNode([...models.allowed], { flow }));
  });
}

/** Renames an agent (display name only; id and role stay). */
export function updateManifestName(path: string, name: string): void {
  editManifest(path, (doc) => doc.setIn(["name"], name.trim()));
}

/** Everything the web form edits; the id stays, fields the form does not show are kept. */
export type AgentFields = Omit<NewAgent, "id" | "description"> & { doc: string };

/**
 * Saves the web form for an existing agent: agent.yaml keeps its comments and every field the
 * form does not cover (mcp, publish mode, …); AGENT.md is replaced. Validated before writing.
 */
export function updateAgent(agentsDir: string, id: string, f: AgentFields): void {
  if (!ID.test(id)) throw new Error("id: lowercase letters, digits and dashes");
  const dir = join(agentsDir, id);
  const list = (doc: Document, path: string[], items: string[]) => {
    const old = doc.getIn(path, true) as { flow?: boolean } | undefined;
    doc.setIn(path, doc.createNode([...items], { flow: old ? old.flow === true : true }));
  };
  editManifest(join(dir, "agent.yaml"), (doc) => {
    doc.setIn(["name"], f.name.trim());
    doc.setIn(["role"], f.role.trim());
    doc.setIn(["workspace"], f.workspace.trim());
    if (f.roles?.length) list(doc, ["roles"], f.roles);
    else doc.deleteIn(["roles"]);
    doc.setIn(["models", "default"], f.models.default);
    list(doc, ["models", "allowed"], f.models.allowed);
    list(doc, ["tools"], f.tools ?? []);
    list(doc, ["fs", "read"], f.fs?.read ?? []);
    list(doc, ["fs", "write"], f.fs?.write ?? []);
    // Absent shell = no shell at all (deny by default).
    if (f.shell) list(doc, ["shell", "allow"], f.shell.allow);
    else doc.deleteIn(["shell"]);
    list(doc, ["network", "allow"], f.network?.allow ?? []);
    list(doc, ["delegation", "can_delegate_to"], f.delegation?.can_delegate_to ?? []);
    list(doc, ["delegation", "accepts_from"], f.delegation?.accepts_from ?? []);
    if (f.budget?.per_run_usd) doc.setIn(["budget", "per_run_usd"], f.budget.per_run_usd);
    else doc.deleteIn(["budget"]);
  });
  const tmp = join(dir, `AGENT.md.tmp-${process.pid}`);
  writeFileSync(tmp, f.doc.endsWith("\n") ? f.doc : `${f.doc}\n`);
  renameSync(tmp, join(dir, "AGENT.md"));
}

export interface NewAgent {
  id: string;
  name: string;
  role: string;
  workspace: string;
  roles?: string[];
  models: { default: string; allowed: string[] };
  /** Permissions: everything omitted is "nothing allowed" (deny by default). */
  tools?: string[];
  fs?: { read?: string[]; write?: string[] };
  shell?: { allow: string[] };
  network?: { allow: string[] };
  delegation?: { can_delegate_to?: string[]; accepts_from?: string[] };
  budget?: { per_run_usd?: number };
  /** Scope paragraph for AGENT.md. */
  description: string;
}

/**
 * Creates `<agentsDir>/<id>/` with agent.yaml and AGENT.md. The manifest is validated with the
 * same strict schema as every other agent first; an existing agent is never overwritten.
 */
export function createAgentFiles(agentsDir: string, a: NewAgent): { id: string } {
  if (!ID.test(a.id)) throw new Error("id: lowercase letters, digits and dashes");
  const dir = join(agentsDir, a.id);
  if (existsSync(dir)) throw new Error(`agent ${a.id} already exists`);
  const manifest = {
    id: a.id,
    name: a.name.trim(),
    role: a.role.trim(),
    workspace: a.workspace.trim(),
    ...(a.roles?.length ? { roles: a.roles } : {}),
    models: a.models,
    tools: a.tools ?? [],
    fs: { read: a.fs?.read ?? [], write: a.fs?.write ?? [] },
    ...(a.shell ? { shell: a.shell } : {}),
    ...(a.network?.allow.length ? { network: a.network } : {}),
    ...(a.delegation ? { delegation: a.delegation } : {}),
    ...(a.budget?.per_run_usd ? { budget: a.budget } : {}),
  };
  const text = stringify(manifest, { flowCollectionPadding: false });
  parseManifest(text, `${a.id}/agent.yaml`); // throws with field paths if invalid
  mkdirSync(dir, { recursive: false, mode: 0o700 });
  try {
    writeFileSync(join(dir, "AGENT.md"), `# ${manifest.name}\n\n${a.description.trim()}\n`);
    writeFileSync(
      join(dir, "agent.yaml"),
      `# Created in the web UI. Everything not listed here is not allowed.\n${text}`,
    );
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { id: a.id };
}

/** List fields an agent change may touch (owner-approved proposals, ADR-0041). */
export const AGENT_LIST_FIELDS = {
  mcp: ["mcp"],
  tools: ["tools"],
  fs_read: ["fs", "read"],
  fs_write: ["fs", "write"],
  network: ["network", "allow"],
  shell: ["shell", "allow"],
  delegate_to: ["delegation", "can_delegate_to"],
  accept_from: ["delegation", "accepts_from"],
  models: ["models", "allowed"],
} as const;
export type AgentListField = keyof typeof AGENT_LIST_FIELDS;

export interface AgentPatch {
  add?: Partial<Record<AgentListField, string[] | undefined>>;
  remove?: Partial<Record<AgentListField, string[] | undefined>>;
  defaultModel?: string;
}

/**
 * The agent.yaml text after a change, comments and layout kept; validated like any manifest.
 * Removing the last shell command removes the shell.
 */
export function patchManifestText(text: string, patch: AgentPatch, source = "agent.yaml"): string {
  const doc = parseDocument(text);
  for (const [field, path] of Object.entries(AGENT_LIST_FIELDS) as [
    AgentListField,
    readonly string[],
  ][]) {
    const add = patch.add?.[field] ?? [];
    const remove = new Set(patch.remove?.[field] ?? []);
    if (!add.length && !remove.size) continue;
    const node = doc.getIn(path, true) as
      | { flow?: boolean; comment?: string | null; commentBefore?: string | null }
      | undefined;
    const cur = (doc.getIn(path) as { toJSON?: () => unknown } | undefined)?.toJSON?.();
    const list = Array.isArray(cur) ? (cur as string[]) : [];
    const next = [...new Set([...list.filter((x) => !remove.has(x)), ...add])];
    if (field === "shell" && next.length === 0) {
      doc.deleteIn(["shell"]);
      continue;
    }
    const fresh = doc.createNode(next, { flow: node ? node.flow === true : true });
    // Keep the owner's notes on that line.
    fresh.comment = node?.comment ?? null;
    fresh.commentBefore = node?.commentBefore ?? null;
    doc.setIn(path, fresh);
  }
  if (patch.defaultModel) doc.setIn(["models", "default"], patch.defaultModel);
  const out = doc.toString({ flowCollectionPadding: false });
  parseManifest(out, source); // throws with field paths if invalid
  return out;
}

/** What a change does, one line per field, for the owner's approval message. */
export function manifestChanges(before: string, after: string): string[] {
  const a = parseManifest(before, "before");
  const b = parseManifest(after, "after");
  const lists: [string, string[], string[]][] = [
    ["integrations", a.mcp, b.mcp],
    ["tools", a.tools, b.tools],
    ["read folders", a.fs.read, b.fs.read],
    ["write folders", a.fs.write, b.fs.write],
    ["websites", a.network.allow, b.network.allow],
    ["shell commands", a.shell?.allow ?? [], b.shell?.allow ?? []],
    ["may delegate to", a.delegation.can_delegate_to, b.delegation.can_delegate_to],
    ["accepts work from", a.delegation.accepts_from, b.delegation.accepts_from],
    ["models", a.models.allowed, b.models.allowed],
  ];
  const lines: string[] = [];
  for (const [label, x, y] of lists) {
    const added = y.filter((v) => !x.includes(v));
    const removed = x.filter((v) => !y.includes(v));
    if (added.length || removed.length) {
      lines.push(
        `${label}: ${[...added.map((v) => `+ ${v}`), ...removed.map((v) => `− ${v}`)].join(", ")}`,
      );
    }
  }
  if (a.models.default !== b.models.default) {
    lines.push(`default model: ${a.models.default} → ${b.models.default}`);
  }
  return lines;
}
