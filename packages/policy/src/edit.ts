import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { parseManifest } from "./manifest.ts";

/**
 * Changes an agent's models in its agent.yaml, keeping the owner's comments and layout.
 * The whole result is validated first; on any error the file is left untouched.
 */
export function updateManifestModels(
  path: string,
  models: { default: string; allowed: string[] },
): void {
  const doc = parseDocument(readFileSync(path, "utf8"));
  doc.setIn(["models", "default"], models.default);
  doc.setIn(["models", "allowed"], doc.createNode([...models.allowed], { flow: true }));
  const text = doc.toString({ flowCollectionPadding: false }); // [a, b] like hand-written files
  parseManifest(text, path); // throws with field paths if invalid
  // Atomic replace, same permissions.
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: statSync(path).mode & 0o777 });
  renameSync(tmp, path);
}
