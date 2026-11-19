import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateManifestModels } from "./edit.ts";
import { loadManifest } from "./manifest.ts";

const YAML = `# Boss agent — my notes stay here
id: boss
name: Boss
role: orchestrator
workspace: shared
models:
  default: cli-claude/sonnet # current choice
  allowed: [cli-claude/sonnet, local/qwen3:8b]
tools: [] # no tools
`;

describe("updateManifestModels", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "achords-edit-"));
    path = join(dir, "agent.yaml");
    writeFileSync(path, YAML);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("changes only the models and keeps the owner's comments", () => {
    updateManifestModels(path, {
      default: "cli-claude/opus",
      allowed: ["cli-claude/opus", "cli-claude/haiku", "local/qwen3:8b"],
    });
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# Boss agent — my notes stay here");
    expect(text).toContain("tools: [] # no tools");
    expect(text).toContain("allowed: [cli-claude/opus, cli-claude/haiku, local/qwen3:8b]");
    expect(loadManifest(path).models).toEqual({
      default: "cli-claude/opus",
      allowed: ["cli-claude/opus", "cli-claude/haiku", "local/qwen3:8b"],
    });
  });

  it("validates before writing: an invalid change leaves the file untouched", () => {
    expect(() =>
      updateManifestModels(path, {
        default: "cli-claude/claude-opus",
        allowed: ["cli-claude/claude-opus"],
      }),
    ).toThrow(/alias/);
    expect(() =>
      updateManifestModels(path, { default: "cli-claude/opus", allowed: ["cli-claude/haiku"] }),
    ).toThrow(/models.allowed/);
    expect(readFileSync(path, "utf8")).toBe(YAML);
  });
});
