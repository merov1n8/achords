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

// ADR-0067: every account and site is `live` or `staging`. A plain string is a live entry,
// so existing files keep their meaning; an object names the value as `url` or `id`.
export type Env = "live" | "staging";
export interface AccountEntry {
  value: string;
  env: Env;
}

const entryValue = z.string().min(1).max(200);
const env = z.enum(["live", "staging"]).default("live");
const accountEntry = z.union([
  entryValue.transform((value): AccountEntry => ({ value, env: "live" })),
  z
    .object({ url: entryValue, env })
    .strict()
    .transform((e): AccountEntry => ({ value: e.url, env: e.env })),
  z
    .object({ id: entryValue, env })
    .strict()
    .transform((e): AccountEntry => ({ value: e.id, env: e.env })),
]);

const accountLists = z
  .record(
    z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "lowercase letters, digits and dashes"),
    z.array(accountEntry).min(1).max(50),
  )
  .default({});

/** The values of account entries, for everything that does not care about `env`. */
export const entryValues = (lists: Record<string, AccountEntry[]>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(lists).map(([k, list]) => [k, list.map((e) => e.value)]));

// Written back the way it was read: live entries as plain strings, staging ones as objects.
const isAddress = (v: string) => /^[a-z][a-z0-9+.-]*:\/\/|^git@|^[\w-]+(\.[\w-]+)+(\/|$)/i.test(v);
const entryYaml = (e: AccountEntry) =>
  e.env === "live" ? e.value : { [isAddress(e.value) ? "url" : "id"]: e.value, env: e.env };
const listsYaml = (lists: Record<string, AccountEntry[]>) =>
  Object.fromEntries(Object.entries(lists).map(([k, list]) => [k, list.map(entryYaml)]));

export type ProjectClass = "secured" | "experimental";

const projectSchema = z
  .object({
    name: z.string().min(1),
    workspace: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
    // Catalog id → this client's own properties/sites/pages (ADR-0036).
    integrations: accountLists,
    // ADR-0067: unset counts as secured, but stays unset so the form shows "not chosen yet".
    class: z.enum(["secured", "experimental"]).optional(),
    spend_without_asking: z.boolean().optional(),
    // ADR-0037: a client can forbid agents publishing (off) or force review; never loosen.
    publish: z.enum(["review", "off"]).optional(),
    // ADR-0064: the project's code lives elsewhere on this Mac (a full path, or ~/…); its
    // runs start there instead of in files/. Set by hand: it opens that folder to agents.
    workdir: z
      .string()
      .regex(/^(~\/|\/).+/, "a full path, or one starting with ~/")
      .optional(),
  })
  .strict()
  .refine((p) => !p.spend_without_asking || p.class === "experimental", {
    path: ["spend_without_asking"],
    message: "only for an experimental project",
  });

export interface Project {
  slug: string;
  name: string;
  workspace: string;
  /** Catalog id → this client's own properties/sites/pages (ADR-0036), values only. */
  integrations: Record<string, string[]>;
  /** The same lists with each entry's environment (ADR-0067). */
  integrationEntries: Record<string, AccountEntry[]>;
  /** Unset = not chosen yet, counts as secured (ADR-0067). */
  class?: ProjectClass | undefined;
  spend_without_asking?: boolean | undefined;
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
      integrations: entryValues(parsed.data.integrations),
      integrationEntries: parsed.data.integrations,
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
  p: { slug: string; name: string; workspace: string; class?: ProjectClass },
): Project {
  if (!SLUG.test(p.slug)) throw new Error("slug: lowercase letters, digits and dashes");
  if (p.slug === OWN) throw new Error(`slug: "${OWN}" is reserved for your own accounts`);
  const data = projectSchema.parse({
    name: p.name.trim(),
    workspace: p.workspace.trim(),
    ...(p.class ? { class: p.class } : {}),
  });
  const dir = join(projectsDir, p.slug);
  if (existsSync(dir)) throw new Error(`project ${p.slug} already exists`);
  mkdirSync(join(dir, "files"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "project.yaml"),
    `name: ${JSON.stringify(data.name)}\nworkspace: ${data.workspace}\n${data.class ? `class: ${data.class}\n` : ""}`,
  );
  writeFileSync(
    join(dir, "PROJECT.md"),
    `# ${data.name}\n\nWhat this project is, for whom, and what matters most.\n\n## Preferences\n\n- \n\n## Stack and conventions\n\n- \n\n## Don'ts\n\n- \n\n## Deploy\n\n- Agents develop and stage; the owner deploys to production.\n`,
  );
  return loadProjects(projectsDir).get(p.slug) as Project;
}

/**
 * Changes a project's name, workspace, class or PROJECT.md; the slug (its folder) and files/
 * stay. Account lists given as plain strings keep the environment their entry had.
 */
export function updateProject(
  projectsDir: string,
  slug: string,
  patch: {
    name?: string;
    workspace?: string;
    doc?: string;
    integrations?: AccountListsInput;
    class?: ProjectClass;
    spend_without_asking?: boolean;
  },
): Project {
  const cur = loadProjects(projectsDir).get(slug);
  if (!cur) throw new Error(`no project ${slug}`);
  const cls = patch.class ?? cur.class;
  const spend = patch.spend_without_asking ?? cur.spend_without_asking;
  const lists = patch.integrations
    ? cleanLists(patch.integrations, cur.integrationEntries)
    : cur.integrationEntries;
  const data = projectSchema.parse({
    name: (patch.name ?? cur.name).trim(),
    workspace: (patch.workspace ?? cur.workspace).trim(),
    integrations: listsYaml(lists),
    ...(cls ? { class: cls } : {}),
    ...(spend !== undefined ? { spend_without_asking: spend } : {}),
    ...(cur.publish ? { publish: cur.publish } : {}),
    ...(cur.workdir ? { workdir: cur.workdir } : {}),
  });
  // Owner-edited fields the web form does not show (integration targets) are kept.
  const extra =
    (data.class ? `class: ${data.class}\n` : "") +
    (data.spend_without_asking !== undefined
      ? `spend_without_asking: ${data.spend_without_asking}\n`
      : "") +
    (data.publish ? `publish: ${data.publish}\n` : "") +
    (data.workdir ? `workdir: ${JSON.stringify(data.workdir)}\n` : "") +
    (Object.keys(data.integrations).length
      ? stringifyYaml({ integrations: listsYaml(data.integrations) })
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

/** Account lists as an editor sends them: a plain string keeps the env its value had. */
export type AccountListsInput = Record<string, (string | AccountEntry)[]>;

/**
 * Trimmed values, empty ones and empty lists left out (the web form sends blank rows). A plain
 * string takes the env of the same value in `cur` (the form does not show env yet), else live.
 */
function cleanLists(
  lists: AccountListsInput,
  cur: Record<string, AccountEntry[]>,
): Record<string, AccountEntry[]> {
  const out: Record<string, AccountEntry[]> = {};
  for (const [rawKey, values] of Object.entries(lists)) {
    const key = rawKey.trim();
    const kept = values
      .map((v): AccountEntry => {
        if (typeof v !== "string") return { value: v.value.trim(), env: v.env };
        const value = v.trim();
        return { value, env: cur[key]?.find((e) => e.value === value)?.env ?? "live" };
      })
      .filter((e) => e.value);
    if (kept.length) out[key] = kept;
  }
  return out;
}

/** The owner's own accounts (ADR-0042): used by work that has no client project. */
export const OWN = "own";

const ownSchema = z.object({ integrations: accountLists }).strict();

export const loadOwnAccounts = (home: string): Record<string, string[]> =>
  entryValues(loadOwnAccountEntries(home));

/** Own accounts with each entry's environment (ADR-0067), same shape as a project's. */
export function loadOwnAccountEntries(home: string): Record<string, AccountEntry[]> {
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

export function saveOwnAccounts(home: string, lists: AccountListsInput): Record<string, string[]> {
  const cleaned = listsYaml(cleanLists(lists, loadOwnAccountEntries(home)));
  const data = ownSchema.parse({ integrations: cleaned });
  writeFileSync(
    join(home, "accounts.yaml"),
    `# Your own accounts: used by work that has no client project.\n${Object.keys(data.integrations).length ? stringifyYaml({ integrations: cleaned }) : "integrations: {}\n"}`,
    { mode: 0o600 },
  );
  return entryValues(data.integrations);
}

/**
 * Own accounts as a project-shaped value, for integration resolution only. Work without a
 * project is experimental (ADR-0067).
 */
export function ownProject(home: string, workspace = "shared"): Project {
  const entries = loadOwnAccountEntries(home);
  return {
    slug: OWN,
    name: "Own accounts",
    workspace,
    integrations: entryValues(entries),
    integrationEntries: entries,
    class: "experimental",
    dir: home,
    filesDir: join(home, "work"),
    workDir: join(home, "work"),
    doc: "",
    workflowPath: "",
  };
}
