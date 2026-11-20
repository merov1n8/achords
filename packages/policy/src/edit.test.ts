import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFiles, updateManifestModels, updateManifestName } from "./edit.ts";
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

  it("keeps a block-style allowed list block-style", () => {
    writeFileSync(
      path,
      YAML.replace(
        "allowed: [cli-claude/sonnet, local/qwen3:8b]",
        "allowed:\n    - cli-claude/sonnet\n    - local/qwen3:8b",
      ),
    );
    updateManifestModels(path, {
      default: "cli-claude/opus",
      allowed: ["cli-claude/opus", "local/qwen3:8b"],
    });
    expect(readFileSync(path, "utf8")).toContain(
      "allowed:\n    - cli-claude/opus\n    - local/qwen3:8b\n",
    );
  });

  it("renames an agent, keeping comments; an empty name is refused", () => {
    updateManifestName(path, "Chief");
    expect(readFileSync(path, "utf8")).toContain("name: Chief");
    expect(readFileSync(path, "utf8")).toContain("# Boss agent — my notes stay here");
    expect(() => updateManifestName(path, "")).toThrow(/name/);
  });

  it("creates a new agent folder with agent.yaml and AGENT.md, validated, never over an existing one", () => {
    const made = createAgentFiles(dir, {
      id: "qa",
      name: "Tester",
      role: "qa",
      workspace: "web-clients",
      roles: ["qa"],
      models: { default: "cli-claude/sonnet", allowed: ["cli-claude/sonnet"] },
      tools: ["Read", "Grep"],
      description: "Reviews web work before it is done.",
    });
    expect(made.id).toBe("qa");
    expect(loadManifest(join(dir, "qa", "agent.yaml"))).toMatchObject({
      name: "Tester",
      roles: ["qa"],
      tools: ["Read", "Grep"],
      fs: { read: [], write: [] },
    });
    expect(readFileSync(join(dir, "qa", "AGENT.md"), "utf8")).toBe(
      "# Tester\n\nReviews web work before it is done.\n",
    );
    expect(() => createAgentFiles(dir, { ...base(), id: "qa" })).toThrow(/exists/);
    expect(() => createAgentFiles(dir, { ...base(), id: "../evil" })).toThrow(/id/);
    expect(() =>
      createAgentFiles(dir, { ...base(), id: "x", fs: { write: ["relative/path"] } }),
    ).toThrow(/absolute/);
    expect(existsSync(join(dir, "x"))).toBe(false); // nothing half-written
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

const base = () => ({
  id: "b",
  name: "B",
  role: "r",
  workspace: "w",
  models: { default: "cli-claude/sonnet", allowed: ["cli-claude/sonnet"] },
  description: "d",
});
