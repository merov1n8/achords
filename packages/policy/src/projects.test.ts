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
import {
  createProject,
  loadOwnAccountEntries,
  loadOwnAccounts,
  loadProjects,
  ownProject,
  removeProject,
  saveOwnAccounts,
  updateProject,
} from "./projects.ts";

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

  it("removes a project from Achords by moving its folder aside, files untouched", () => {
    createProject(dir, { slug: "acme", name: "Acme", workspace: "web-clients" });
    writeFileSync(join(dir, "acme", "files", "logo.png"), "x");
    const aside = join(dir, "..", `${dir.split("/").at(-1)}-removed`);
    const moved = removeProject(dir, "acme", aside, 1_700_000_000_000);
    expect(loadProjects(dir).has("acme")).toBe(false);
    expect(moved).toBe(join(aside, "acme-2023-11-14"));
    expect(readFileSync(join(moved, "files", "logo.png"), "utf8")).toBe("x");
    // The slug is free again.
    createProject(dir, { slug: "acme", name: "Acme 2", workspace: "web-clients" });
    expect(() => removeProject(dir, "nope", aside)).toThrow(/no project/);
    rmSync(aside, { recursive: true, force: true });
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
    appendFileSync(join(dir, "roca", "project.yaml"), "publish: off\n");
    expect(updateProject(dir, "roca", { name: "Roca" }).publish).toBe("off");
  });

  it("sets the account lists from the web editor, dropping empty entries", () => {
    createProject(dir, { slug: "acme", name: "Acme", workspace: "w" });
    const p = updateProject(dir, "acme", {
      integrations: {
        instagram: [" @acme ", "@acme.shop", ""],
        facebook: [],
        "search-console": ["sc-domain:acme.com"],
      },
    });
    expect(p.integrations).toEqual({
      instagram: ["@acme", "@acme.shop"],
      "search-console": ["sc-domain:acme.com"],
    });
    expect(readFileSync(join(dir, "acme", "project.yaml"), "utf8")).toMatch(/instagram:/);
    expect(updateProject(dir, "acme", { integrations: {} }).integrations).toEqual({});
    expect(() => updateProject(dir, "acme", { integrations: { "Bad Key": ["x"] } })).toThrow();
  });

  it("reads plain account entries as live and keeps staging entries through saves (ADR-0067)", () => {
    createProject(dir, { slug: "acme", name: "Acme", workspace: "w" });
    appendFileSync(
      join(dir, "acme", "project.yaml"),
      [
        "integrations:",
        "  website:",
        "    - https://acme.com",
        "    - { url: https://staging.acme.com, env: staging }",
        "  ga4:",
        "    - { id: '324490876', env: live }",
        "",
      ].join("\n"),
    );
    const p = loadProjects(dir).get("acme");
    // Consumers that only need the values see plain strings, as before.
    expect(p?.integrations).toEqual({
      website: ["https://acme.com", "https://staging.acme.com"],
      ga4: ["324490876"],
    });
    expect(p?.integrationEntries).toEqual({
      website: [
        { value: "https://acme.com", env: "live" },
        { value: "https://staging.acme.com", env: "staging" },
      ],
      ga4: [{ value: "324490876", env: "live" }],
    });
    // A rename keeps the lists; the web form's plain strings keep each value's env.
    updateProject(dir, "acme", { name: "Acme shop" });
    const again = updateProject(dir, "acme", {
      integrations: { website: ["https://staging.acme.com", "https://new.acme.com"] },
    });
    expect(again.integrationEntries.website).toEqual([
      { value: "https://staging.acme.com", env: "staging" },
      { value: "https://new.acme.com", env: "live" },
    ]);
    const yaml = readFileSync(join(dir, "acme", "project.yaml"), "utf8");
    expect(yaml).toMatch(/- url: https:\/\/staging\.acme\.com\n\s+env: staging\n/);
    expect(yaml).toContain("- https://new.acme.com");
    // An editor that sends entries can switch one to staging.
    const switched = updateProject(dir, "acme", {
      integrations: { ga4: [{ value: "324490876", env: "staging" }] },
    });
    expect(switched.integrationEntries.ga4).toEqual([{ value: "324490876", env: "staging" }]);
    expect(loadProjects(dir).get("acme")?.integrationEntries.ga4?.[0]?.env).toBe("staging");
    writeFileSync(
      join(dir, "acme", "project.yaml"),
      "name: A\nworkspace: w\nintegrations:\n  ga4: [{ id: '1', env: prod }]\n",
    );
    expect(() => loadProjects(dir)).toThrow(/integrations/);
  });

  it("stores the class only once chosen; spending without asking is for experimental only", () => {
    createProject(dir, { slug: "acme", name: "Acme", workspace: "w" });
    expect(loadProjects(dir).get("acme")?.class).toBeUndefined();
    expect(
      createProject(dir, { slug: "b", name: "B", workspace: "w", class: "secured" }).class,
    ).toBe("secured");
    expect(() => updateProject(dir, "acme", { spend_without_asking: true })).toThrow(
      /spend_without_asking.*experimental/s,
    );
    const p = updateProject(dir, "acme", { class: "experimental", spend_without_asking: true });
    expect(p).toMatchObject({ class: "experimental", spend_without_asking: true });
    expect(updateProject(dir, "acme", { name: "Acme 2" })).toMatchObject({
      class: "experimental",
      spend_without_asking: true,
    });
    expect(() => updateProject(dir, "acme", { class: "secured" })).toThrow(/experimental/);
    expect(
      updateProject(dir, "acme", { class: "secured", spend_without_asking: false }).class,
    ).toBe("secured");
    writeFileSync(
      join(dir, "acme", "project.yaml"),
      "name: A\nworkspace: w\nclass: secured\nspend_without_asking: true\n",
    );
    expect(() => loadProjects(dir)).toThrow(/spend_without_asking/);
    writeFileSync(join(dir, "acme", "project.yaml"), "name: A\nworkspace: w\nclass: open\n");
    expect(() => loadProjects(dir)).toThrow(/class/);
  });

  it("keeps the owner's own accounts outside projects; 'own' is not a project name (ADR-0042)", () => {
    expect(loadOwnAccounts(dir)).toEqual({});
    expect(saveOwnAccounts(dir, { facebook: ["1365", " "], ga4: [] })).toEqual({
      facebook: ["1365"],
    });
    expect(loadOwnAccounts(dir)).toEqual({ facebook: ["1365"] });
    expect(ownProject(dir)).toMatchObject({
      slug: "own",
      class: "experimental",
      integrations: { facebook: ["1365"] },
    });
    // Same entry shape as projects: staging survives a save of plain strings.
    writeFileSync(
      join(dir, "accounts.yaml"),
      "integrations:\n  facebook: [{ id: '1365', env: staging }, '77']\n",
    );
    expect(loadOwnAccounts(dir)).toEqual({ facebook: ["1365", "77"] });
    saveOwnAccounts(dir, { facebook: ["1365", "77", "88"] });
    expect(loadOwnAccountEntries(dir)).toEqual({
      facebook: [
        { value: "1365", env: "staging" },
        { value: "77", env: "live" },
        { value: "88", env: "live" },
      ],
    });
    expect(() => createProject(dir, { slug: "own", name: "x", workspace: "w" })).toThrow(
      /reserved/,
    );
  });
});
