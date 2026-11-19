import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgents, loadManifest, parseManifest } from "./manifest.ts";
import { WEB_DEV } from "./test-fixtures.ts";

describe("parseManifest", () => {
  it("parses a full manifest", () => {
    const m = parseManifest(WEB_DEV, "agent.yaml");
    expect(m).toMatchObject({
      id: "web-dev",
      workspace: "web-clients",
      models: { default: "cli-claude/sonnet", allowed: ["cli-claude/sonnet", "local/qwen3"] },
      sensitivity: "normal",
      publish_mode: { default: "review", channels: { wordpress: "auto" } },
      budget: { per_run_tokens: 200000, per_day_usd: 5 },
    });
  });

  it("defaults everything optional to deny", () => {
    const m = parseManifest(
      "id: a\nname: A\nrole: r\nworkspace: w\nmodels: {default: local/x}\n",
      "x",
    );
    expect(m).toMatchObject({
      tools: [],
      mcp: [],
      fs: { read: [], write: [] },
      network: { allow: [] },
      publish_mode: { default: "review", channels: {} },
      sensitivity: "normal",
    });
    expect(m.shell).toBeUndefined();
    expect(m.models.allowed).toEqual(["local/x"]);
  });

  it("delegation is deny by default and accepts explicit lists", () => {
    const base = "id: a\nname: A\nrole: r\nworkspace: w\nmodels: {default: local/x}\n";
    expect(parseManifest(base, "x").delegation).toEqual({ can_delegate_to: [], accepts_from: [] });
    const m = parseManifest(
      `${base}delegation:\n  can_delegate_to: [b]\n  accepts_from: [boss, c]\n`,
      "x",
    );
    expect(m.delegation).toEqual({ can_delegate_to: ["b"], accepts_from: ["boss", "c"] });
    expect(() => parseManifest(`${base}delegation:\n  can_delegate: [b]\n`, "x")).toThrow(
      /can_delegate/,
    );
  });

  it("rejects claude CLI model names that are neither an alias nor a full model name", () => {
    const base =
      "id: a\nname: A\nrole: r\nworkspace: w\nmodels:\n  default: cli-claude/sonnet\n  allowed: [cli-claude/sonnet, MODEL]\n";
    for (const ok of [
      "cli-claude/opus",
      "cli-claude/fable",
      "cli-claude/claude-opus-5-5",
      "cli-claude/claude-haiku-5-5-20261101",
      "local/qwen3:8b",
    ]) {
      expect(() => parseManifest(base.replace("MODEL", ok), "x")).not.toThrow();
    }
    // Real mistake from editing a manifest by hand: the version removed, the prefix kept.
    expect(() => parseManifest(base.replace("MODEL", "cli-claude/claude-opus"), "x")).toThrow(
      /claude-opus.*alias.*opus/s,
    );
  });

  it("rejects unknown keys, so typos cannot silently widen or drop a rule", () => {
    expect(() => parseManifest(`${WEB_DEV}\ntool: [Bash]\n`, "agent.yaml")).toThrow(
      /agent\.yaml.*tool/s,
    );
  });

  it("rejects relative fs paths and a default model outside the allow-list", () => {
    expect(() =>
      parseManifest(WEB_DEV.replace("[/srv/clients]", "[../clients]"), "agent.yaml"),
    ).toThrow(/fs\.read\.0.*absolute/s);
    expect(() =>
      parseManifest(WEB_DEV.replace("default: cli-claude/sonnet", "default: api/x"), "agent.yaml"),
    ).toThrow(/models\.default.*allowed/s);
  });

  it("reports YAML syntax errors with the file name", () => {
    expect(() => parseManifest("id: [unclosed", "broken.yaml")).toThrow(/broken\.yaml/);
  });
});

describe("loadAgents", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "achords-agents-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("loads agents/<id>/agent.yaml and requires the id to match the folder", () => {
    mkdirSync(join(dir, "web-dev"));
    writeFileSync(join(dir, "web-dev", "agent.yaml"), WEB_DEV);
    mkdirSync(join(dir, "no-manifest"));
    const agents = loadAgents(dir);
    expect([...agents.keys()]).toEqual(["web-dev"]);
    expect(loadManifest(join(dir, "web-dev", "agent.yaml")).id).toBe("web-dev");

    mkdirSync(join(dir, "other"));
    writeFileSync(join(dir, "other", "agent.yaml"), WEB_DEV);
    expect(() => loadAgents(dir)).toThrow(/other.*id "web-dev"/s);
  });
});
