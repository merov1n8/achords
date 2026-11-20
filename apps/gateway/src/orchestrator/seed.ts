import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Db, seedSchedule } from "@achords/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const PLACEHOLDER = /\{\{ACHORDS_HOME\}\}/g;

/**
 * Copies each seed agent folder into `agentsDir` unless it already exists there. Idempotent and
 * never overwrites: local edits to a seeded agent always win. Returns the ids that were seeded.
 */
export function seedAgents(seedDir: string, agentsDir: string, home: string): string[] {
  mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
  const seeded: string[] = [];
  for (const entry of readdirSync(seedDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dest = join(agentsDir, entry.name);
    if (existsSync(dest)) continue;
    cpSync(join(seedDir, entry.name), dest, { recursive: true });
    for (const file of readdirSync(dest)) {
      if (!/\.(ya?ml|md)$/.test(file)) continue;
      const path = join(dest, file);
      writeFileSync(path, readFileSync(path, "utf8").replace(PLACEHOLDER, home));
    }
    seeded.push(entry.name);
  }
  return seeded;
}

const seedScheduleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    name: z.string().min(1),
    cron: z.string().min(1),
    agent: z.string().min(1),
    title: z.string().min(1),
    instructions: z.string().min(1),
    project: z.string().optional(),
    // Shipped schedules start switched off: the owner turns on what they want.
    enabled: z.boolean().default(false),
  })
  .strict();

/** Seeds `<dir>/*.yaml` schedules once by id; never overwrites edits. Returns the ids seeded. */
export function seedSchedules(dir: string, db: Db): string[] {
  if (!existsSync(dir)) return [];
  const seeded: string[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()) {
    const s = seedScheduleSchema.parse(parseYaml(readFileSync(join(dir, file), "utf8")));
    const done = seedSchedule(db, {
      seedId: s.id,
      name: s.name,
      cron: s.cron,
      agentId: s.agent,
      title: s.title,
      instructions: s.instructions,
      enabled: s.enabled,
      ...(s.project ? { project: s.project } : {}),
    });
    if (done) seeded.push(s.id);
  }
  return seeded;
}
