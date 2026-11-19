import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
