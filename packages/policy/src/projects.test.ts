import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject, loadProjects, updateProject } from "./projects.ts";

describe("projects", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "achords-projects-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates a project folder with project.yaml, PROJECT.md and files/", () => {
    createProject(dir, { slug: "acme-shop", name: "Acme webshop", workspace: "web-clients" });
    expect(readFileSync(join(dir, "acme-shop", "PROJECT.md"), "utf8")).toContain("# Acme webshop");
    expect(existsSync(join(dir, "acme-shop", "files"))).toBe(true);
    const p = loadProjects(dir).get("acme-shop");
    expect(p).toMatchObject({
      slug: "acme-shop",
      name: "Acme webshop",
      workspace: "web-clients",
      filesDir: join(dir, "acme-shop", "files"),
    });
    expect(p?.doc).toContain("Acme webshop");
    expect(() => createProject(dir, { slug: "acme-shop", name: "x", workspace: "w" })).toThrow(
      /exists/,
    );
    expect(() => createProject(dir, { slug: "../x", name: "x", workspace: "w" })).toThrow(/slug/);
  });

  it("loads hand-made projects and skips folders without project.yaml; bad yaml is an error", () => {
    mkdirSync(join(dir, "manual"));
    writeFileSync(join(dir, "manual", "project.yaml"), "name: Manual\nworkspace: studio\n");
    mkdirSync(join(dir, "notes-only"));
    expect([...loadProjects(dir).keys()]).toEqual(["manual"]);
    writeFileSync(
      join(dir, "manual", "project.yaml"),
      "name: Manual\nworkspace: studio\nextra: 1\n",
    );
    expect(() => loadProjects(dir)).toThrow(/extra/);
  });

  it("updates name, workspace and PROJECT.md; the slug (folder) stays", () => {
    createProject(dir, { slug: "acme", name: "Acme", workspace: "web-clients" });
    writeFileSync(join(dir, "acme", "files", "index.php"), "<?php");
    updateProject(dir, "acme", {
      name: "Acme shop",
      workspace: "studio",
      doc: "# Acme shop\n\nWooCommerce.\n",
    });
    expect(loadProjects(dir).get("acme")).toMatchObject({
      name: "Acme shop",
      workspace: "studio",
      doc: "# Acme shop\n\nWooCommerce.\n",
    });
    expect(existsSync(join(dir, "acme", "files", "index.php"))).toBe(true);
    expect(() => updateProject(dir, "acme", { workspace: "../x" })).toThrow(/workspace/);
    expect(() => updateProject(dir, "nope", { name: "x" })).toThrow(/no project/);
  });

  it("an empty or missing projects folder is fine", () => {
    expect(loadProjects(join(dir, "nope")).size).toBe(0);
  });

  it("reads integration targets and keeps them when the project is edited (ADR-0036)", () => {
    createProject(dir, { slug: "roca", name: "Roca", workspace: "shared" });
    appendFileSync(
      join(dir, "roca", "project.yaml"),
      'integrations:\n  ga4: ["324490876"]\n  search-console: ["sc-domain:roca.com"]\n',
    );
    const want = { ga4: ["324490876"], "search-console": ["sc-domain:roca.com"] };
    expect(loadProjects(dir).get("roca")?.integrations).toEqual(want);
    expect(updateProject(dir, "roca", { name: "Roca Espais" }).integrations).toEqual(want);
  });
});
