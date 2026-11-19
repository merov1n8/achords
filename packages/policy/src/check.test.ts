import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkFs,
  checkMcp,
  checkModel,
  checkNetwork,
  checkShell,
  checkTool,
  publishMode,
} from "./check.ts";
import { parseManifest } from "./manifest.ts";
import { WEB_DEV } from "./test-fixtures.ts";

const m = parseManifest(WEB_DEV, "agent.yaml");

describe("tools, mcp, models", () => {
  it("allows only listed tools and MCP servers", () => {
    expect(checkTool(m, "Read").allowed).toBe(true);
    expect(checkTool(m, "Bash")).toEqual({ allowed: false, reason: "tool Bash not in allow-list" });
    expect(checkMcp(m, "wordpress").allowed).toBe(true);
    expect(checkMcp(m, "meta-ads").allowed).toBe(false);
  });

  it("allows only listed models", () => {
    expect(checkModel(m, "cli-claude/sonnet").allowed).toBe(true);
    expect(checkModel(m, "cli-claude/opus").allowed).toBe(false);
  });

  it("routes local-only agents to local models only, even if listed (fail-closed)", () => {
    const localOnly = parseManifest(`${WEB_DEV}\nsensitivity: local-only\n`, "x");
    expect(checkModel(localOnly, "local/qwen3").allowed).toBe(true);
    expect(checkModel(localOnly, "cli-claude/sonnet")).toEqual({
      allowed: false,
      reason: "agent is local-only; cli-claude/sonnet is not a local model",
    });
    expect(checkModel(m, "cli-claude/sonnet", { dataSensitivity: "local-only" }).allowed).toBe(
      false,
    );
  });
});

describe("network and publishing", () => {
  it("matches allowed domains and their subdomains only", () => {
    expect(checkNetwork(m, "example.com").allowed).toBe(true);
    expect(checkNetwork(m, "api.example.com").allowed).toBe(true);
    expect(checkNetwork(m, "evil-example.com").allowed).toBe(false);
    expect(checkNetwork(m, "example.com.evil.io").allowed).toBe(false);
  });

  it("publishes in review mode unless a channel says auto", () => {
    expect(publishMode(m, "wordpress")).toBe("auto");
    expect(publishMode(m, "facebook")).toBe("review");
  });
});

describe("shell", () => {
  it("runs allow-listed commands directly and asks approval for the rest", () => {
    expect(checkShell(m, "git status").decision).toBe("allow");
    expect(checkShell(m, "git status --short").decision).toBe("allow");
    expect(checkShell(m, "git push").decision).toBe("approval");
    expect(checkShell(m, "gitstatus").decision).toBe("approval");
  });

  it("never auto-allows shell metacharacters (chaining, substitution, redirects)", () => {
    for (const cmd of [
      "git status; rm -rf ~",
      "git status && curl x",
      "git status | sh",
      "git status $(whoami)",
      "git status `id`",
      "git status > /etc/x",
      "git status\nrm -rf ~",
    ]) {
      expect(checkShell(m, cmd).decision).toBe("approval");
    }
  });

  it("denies all shell use when the manifest has no shell section", () => {
    const noShell = parseManifest(WEB_DEV.replace(/shell:\n {2}allow: .*\n/, ""), "x");
    expect(checkShell(noShell, "git status").decision).toBe("deny");
  });
});

describe("fs", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "achords-fs-"));
    mkdirSync(join(root, "clients", "site-a"), { recursive: true });
    mkdirSync(join(root, "private"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const manifest = (r: string) =>
    parseManifest(
      WEB_DEV.replace("[/srv/clients]", `[${r}/clients]`).replace(
        "[/srv/clients/site-a]",
        `[${r}/clients/site-a]`,
      ),
      "x",
    );

  it("allows reads and writes only inside the declared roots", () => {
    const p = manifest(root);
    expect(checkFs(p, join(root, "clients", "x.txt"), "read").allowed).toBe(true);
    expect(checkFs(p, join(root, "clients", "x.txt"), "write").allowed).toBe(false);
    expect(checkFs(p, join(root, "clients", "site-a", "new", "f.ts"), "write").allowed).toBe(true);
    expect(checkFs(p, join(root, "clients", "site-a"), "read").allowed).toBe(true);
    expect(checkFs(p, join(root, "private", "x"), "read").allowed).toBe(false);
  });

  it("blocks .. traversal, prefix tricks and symlink escapes", () => {
    const p = manifest(root);
    expect(checkFs(p, join(root, "clients", "..", "private", "x"), "read").allowed).toBe(false);
    mkdirSync(join(root, "clients-evil"));
    expect(checkFs(p, join(root, "clients-evil", "x"), "read").allowed).toBe(false);
    symlinkSync(join(root, "private"), join(root, "clients", "link"));
    expect(checkFs(p, join(root, "clients", "link", "x"), "read").allowed).toBe(false);
  });

  it("rejects relative paths", () => {
    expect(checkFs(manifest(root), "clients/x", "read").allowed).toBe(false);
  });
});
