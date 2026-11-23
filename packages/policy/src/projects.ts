import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

// ADR-0031: a project = $ACHORDS_HOME/projects/<slug>/ with project.yaml, PROJECT.md, files/.
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

const accountLists = z
  .record(
    z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "lowercase letters, digits and dashes"),
    z.array(z.string().min(1).max(200)).min(1).max(50),
  )
  .default({});

const projectSchema = z
  .object({
    name: z.string().min(1),
    workspace: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
    // Catalog id → this client's own properties/sites/pages (ADR-0036).
    integrations: accountLists,
    // ADR-0037: a client can forbid agents publishing (off) or force review; never loosen.
    publish: z.enum(["review", "off"]).optional(),
    // ADR-0064: the project's code lives elsewhere on this Mac (a full path, or ~/…); its
    // runs start there instead of in files/. Set by hand: it opens that folder to agents.
    workdir: z
      .string()
      .regex(/^(~\/|\/).+/, "a full path, or one starting with ~/")
      .optional(),
  })
  .strict();

export interface Project {
  slug: string;
  name: string;
  workspace: string;
  /** Catalog id → this client's own properties/sites/pages (ADR-0036). */
  integrations: Record<string, string[]>;
  publish?: "review" | "off" | undefined;
  /** As written in project.yaml; `workDir` is the path it stands for. */
  workdir?: string | undefined;
  dir: string;
  filesDir: string;
  /** Where the project's runs start: `workdir` when set (ADR-0064), else `filesDir`. */
  workDir: string;
  /** PROJECT.md: client preferences, stack, conventions, deploy rules. */
  doc: string;
  /** Optional workflow replacing the workspace's for this project's cards. */
  workflowPath: string;
}

export function loadProjects(projectsDir: string): Map<string, Project> {
  const out = new Map<string, Project>();
  if (!existsSync(projectsDir)) return out;
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SLUG.test(entry.name)) continue;
    const dir = join(projectsDir, entry.name);
    const yamlPath = join(dir, "project.yaml");
    if (!existsSync(yamlPath)) continue;
    const parsed = projectSchema.safeParse(parseYaml(readFileSync(yamlPath, "utf8")));
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      );
      throw new Error(`${yamlPath}: invalid project\n  ${issues.join("\n  ")}`);
    }
    const docPath = join(dir, "PROJECT.md");
    out.set(entry.name, {
      slug: entry.name,
      ...parsed.data,
      dir,
      filesDir: join(dir, "files"),
      workDir: parsed.data.workdir
        ? parsed.data.workdir.replace(/^~\//, `${homedir()}/`)
        : join(dir, "files"),
      doc: existsSync(docPath) ? readFileSync(docPath, "utf8") : "",
      workflowPath: join(dir, "workflow.yaml"),
    });
  }
  return out;
}

export function createProject(
  projectsDir: string,
  p: { slug: string; name: string; workspace: string },
): Project {
  if (!SLUG.test(p.slug)) throw new Error("slug: lowercase letters, digits and dashes");
  if (p.slug === OWN) throw new Error(`slug: "${OWN}" is reserved for your own accounts`);
  const data = projectSchema.parse({ name: p.name.trim(), workspace: p.workspace.trim() });
  const dir = join(projectsDir, p.slug);
  if (existsSync(dir)) throw new Error(`project ${p.slug} already exists`);
  mkdirSync(join(dir, "files"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "project.yaml"),
    `name: ${JSON.stringify(data.name)}\nworkspace: ${data.workspace}\n`,
  );
  writeFileSync(
    join(dir, "PROJECT.md"),
    `# ${data.name}\n\nWhat this project is, for whom, and what matters most.\n\n## Preferences\n\n- \n\n## Stack and conventions\n\n- \n\n## Don'ts\n\n- \n\n## Deploy\n\n- Agents develop and stage; the owner deploys to production.\n`,
  );
  return loadProjects(projectsDir).get(p.slug) as Project;
}

/** Changes a project's name, workspace or PROJECT.md; the slug (its folder) and files/ stay. */
export function updateProject(
  projectsDir: string,
  slug: string,
  patch: {
    name?: string;
    workspace?: string;
    doc?: string;
    integrations?: Record<string, string[]>;
  },
): Project {
  const cur = loadProjects(projectsDir).get(slug);
  if (!cur) throw new Error(`no project ${slug}`);
  const data = projectSchema.parse({
    name: (patch.name ?? cur.name).trim(),
    workspace: (patch.workspace ?? cur.workspace).trim(),
    integrations: patch.integrations ? cleanLists(patch.integrations) : cur.integrations,
    ...(cur.publish ? { publish: cur.publish } : {}),
    ...(cur.workdir ? { workdir: cur.workdir } : {}),
  });
  // Owner-edited fields the web form does not show (integration targets) are kept.
  const extra =
    (data.publish ? `publish: ${data.publish}\n` : "") +
    (data.workdir ? `workdir: ${JSON.stringify(data.workdir)}\n` : "") +
    (Object.keys(data.integrations).length
      ? stringifyYaml({ integrations: data.integrations })
      : "");
  writeFileSync(
    join(cur.dir, "project.yaml"),
    `name: ${JSON.stringify(data.name)}\nworkspace: ${data.workspace}\n${extra}`,
  );
  if (patch.doc !== undefined) writeFileSync(join(cur.dir, "PROJECT.md"), patch.doc);
  return loadProjects(projectsDir).get(slug) as Project;
}

/**
 * Takes a project out of Achords without deleting anything: its folder (PROJECT.md, files/) is
 * moved to `asideDir/<slug>-<date>` for the owner to look through and delete by hand. Returns
 * the new path. The slug is free again afterwards.
 */
export function removeProject(
  projectsDir: string,
  slug: string,
  asideDir: string,
  now = Date.now(),
): string {
  const cur = loadProjects(projectsDir).get(slug);
  if (!cur) throw new Error(`no project ${slug}`);
  mkdirSync(asideDir, { recursive: true, mode: 0o700 });
  const day = new Date(now).toISOString().slice(0, 10);
  let target = join(asideDir, `${slug}-${day}`);
  for (let n = 2; existsSync(target); n++) target = join(asideDir, `${slug}-${day}-${n}`);
  renameSync(cur.dir, target);
  return target;
}

/** Trimmed values, empty ones and empty lists left out (the web form sends blank rows). */
function cleanLists(lists: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(lists)) {
    const kept = values.map((v) => v.trim()).filter(Boolean);
    if (kept.length) out[key.trim()] = kept;
  }
  return out;
}

/** The owner's own accounts (ADR-0042): used by work that has no client project. */
export const OWN = "own";

const ownSchema = z.object({ integrations: accountLists }).strict();

export function loadOwnAccounts(home: string): Record<string, string[]> {
  const path = join(home, "accounts.yaml");
  if (!existsSync(path)) return {};
  const parsed = ownSchema.safeParse(parseYaml(readFileSync(path, "utf8")) ?? {});
  if (!parsed.success) {
    throw new Error(
      `${path}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data.integrations;
}

export function saveOwnAccounts(
  home: string,
  lists: Record<string, string[]>,
): Record<string, string[]> {
  const data = ownSchema.parse({ integrations: cleanLists(lists) });
  writeFileSync(
    join(home, "accounts.yaml"),
    `# Your own accounts: used by work that has no client project.\n${Object.keys(data.integrations).length ? stringifyYaml(data) : "integrations: {}\n"}`,
    { mode: 0o600 },
  );
  return data.integrations;
}

/** Own accounts as a project-shaped value, for integration resolution only. */
export function ownProject(home: string, workspace = "shared"): Project {
  return {
    slug: OWN,
    name: "Own accounts",
    workspace,
    integrations: loadOwnAccounts(home),
    dir: home,
    filesDir: join(home, "work"),
    workDir: join(home, "work"),
    doc: "",
    workflowPath: "",
  };
}
