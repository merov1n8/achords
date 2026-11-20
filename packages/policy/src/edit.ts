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
