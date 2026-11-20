import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ADR-0031: a project = $ACHORDS_HOME/projects/<slug>/ with project.yaml, PROJECT.md, files/.
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

const projectSchema = z
  .object({ name: z.string().min(1), workspace: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i) })
  .strict();

export interface Project {
  slug: string;
  name: string;
  workspace: string;
  dir: string;
  filesDir: string;
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
  patch: { name?: string; workspace?: string; doc?: string },
): Project {
  const cur = loadProjects(projectsDir).get(slug);
  if (!cur) throw new Error(`no project ${slug}`);
  const data = projectSchema.parse({
    name: (patch.name ?? cur.name).trim(),
    workspace: (patch.workspace ?? cur.workspace).trim(),
  });
  writeFileSync(
    join(cur.dir, "project.yaml"),
    `name: ${JSON.stringify(data.name)}\nworkspace: ${data.workspace}\n`,
  );
  if (patch.doc !== undefined) writeFileSync(join(cur.dir, "PROJECT.md"), patch.doc);
  return loadProjects(projectsDir).get(slug) as Project;
}
