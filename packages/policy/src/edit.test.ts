import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgentFiles,
  manifestChanges,
  patchManifestText,
  updateAgent,
  updateManifestModels,
  updateManifestName,
} from "./edit.ts";
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

describe("agent change proposals (ADR-0041)", () => {
  const BASE = `# Social agent
id: social
name: Social
role: social
workspace: marketing
models:
  default: cli-claude/sonnet
  allowed: [cli-claude/sonnet]
tools: [Read, WebFetch]
mcp: [wordpress] # client sites
network:
  allow: [example.com]
`;

  it("adds and removes list entries, keeps comments, and describes the change", () => {
    const next = patchManifestText(BASE, {
      add: { mcp: ["meta"], models: ["cli-claude/opus"], network: ["facebook.com"] },
      remove: { network: ["example.com"], tools: ["WebFetch"] },
      defaultModel: "cli-claude/opus",
    });
    expect(next).toContain("# Social agent");
    expect(next).toContain("mcp: [wordpress, meta] # client sites");
    expect(manifestChanges(BASE, next)).toEqual([
      "integrations: + meta",
      "tools: − WebFetch",
      "websites: + facebook.com, − example.com",
      "models: + cli-claude/opus",
      "default model: cli-claude/sonnet → cli-claude/opus",
    ]);
  });

  it("creates missing lists, drops an emptied shell, and refuses invalid results", () => {
    const withShell = patchManifestText(BASE, { add: { shell: ["ls"], tools: ["Bash"] } });
    expect(withShell).toMatch(/shell:\n {2}allow: \[ls\]/);
    expect(patchManifestText(withShell, { remove: { shell: ["ls"] } })).not.toContain("shell");
    expect(() => patchManifestText(BASE, { defaultModel: "cli-claude/haiku" })).toThrow(
      /must be one of models.allowed/,
    );
  });
});

describe("updateAgent (web: edit with the same form as create)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "achords-edit-"));
    createAgentFiles(dir, {
      id: "social",
      name: "Social",
      role: "posts",
      workspace: "marketing",
      models: { default: "cli-claude/sonnet", allowed: ["cli-claude/sonnet"] },
      tools: ["Read", "Bash"],
      shell: { allow: ["ls"] },
      description: "Writes posts.",
    });
    // Fields the form does not show must survive an edit.
    const path = join(dir, "social", "agent.yaml");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}mcp: [wordpress, meta] # owner's note\npublish_mode:\n  default: review\n`,
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fields = {
    name: "Social media",
    role: "posts and replies",
    workspace: "marketing",
    roles: ["writer"],
    models: {
      default: "cli-codex/gpt-6.2-sol",
      allowed: ["cli-claude/sonnet", "cli-codex/gpt-6.2-sol"],
    },
    tools: ["Read"],
    fs: { read: ["/tmp/a"], write: [] },
    network: { allow: ["example.com"] },
    delegation: { can_delegate_to: [], accepts_from: ["boss"] },
    doc: "# Social media\n\nWrites and schedules posts.\n",
  };

  it("rewrites the form fields, keeps the rest (mcp, publish mode, comments), drops a removed shell", () => {
    updateAgent(dir, "social", fields);
    const m = loadManifest(join(dir, "social", "agent.yaml"));
    expect(m).toMatchObject({
      name: "Social media",
      role: "posts and replies",
      roles: ["writer"],
      models: fields.models,
      tools: ["Read"],
      mcp: ["wordpress", "meta"],
      network: { allow: ["example.com"] },
      delegation: { accepts_from: ["boss"] },
    });
    expect(m.shell).toBeUndefined();
    expect(readFileSync(join(dir, "social", "agent.yaml"), "utf8")).toMatch(/owner's note/);
    expect(readFileSync(join(dir, "social", "AGENT.md"), "utf8")).toBe(fields.doc);
  });

  it("sets a shell and a budget when given, removes the budget at 0", () => {
    updateAgent(dir, "social", {
      ...fields,
      tools: ["Bash"],
      shell: { allow: ["npm test"] },
      budget: { per_run_usd: 2 },
    });
    expect(loadManifest(join(dir, "social", "agent.yaml"))).toMatchObject({
      shell: { allow: ["npm test"] },
      budget: { per_run_usd: 2 },
    });
    updateAgent(dir, "social", { ...fields, budget: { per_run_usd: 0 } });
    expect(loadManifest(join(dir, "social", "agent.yaml")).budget?.per_run_usd).toBeUndefined();
  });

  it("refuses invalid values and leaves both files untouched", () => {
    const before = readFileSync(join(dir, "social", "agent.yaml"), "utf8");
    expect(() =>
      updateAgent(dir, "social", { ...fields, fs: { read: ["relative/path"], write: [] } }),
    ).toThrow();
    expect(readFileSync(join(dir, "social", "agent.yaml"), "utf8")).toBe(before);
    expect(readFileSync(join(dir, "social", "AGENT.md"), "utf8")).toMatch(/Writes posts/);
    expect(() => updateAgent(dir, "../x", fields)).toThrow(/id/);
  });
});
