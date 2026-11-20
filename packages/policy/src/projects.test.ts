import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject, loadProjects } from "./projects.ts";

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

  it("an empty or missing projects folder is fine", () => {
    expect(loadProjects(join(dir, "nope")).size).toBe(0);
  });
});
