import { describe, expect, it } from "vitest";
import { loadCatalog, secretRefs } from "./catalog.ts";

const SEED = new URL("../../../seed/catalog/", import.meta.url).pathname;

describe("shipped integration catalog", () => {
  const catalog = loadCatalog(SEED, "/nonexistent");

  it("parses and contains the first integrations", () => {
    expect([...catalog.keys()].sort()).toEqual([
      "blender",
      "ga4",
      "meta",
      "search-console",
      "unity",
      "wordpress",
    ]);
  });

  it("pins every ecosystem package to an exact version", () => {
    for (const e of catalog.values()) {
      if (e.builtin) continue;
      const pkg = e.args.find((a) => /@\d|==\d/.test(a));
      expect(pkg, e.id).toMatch(/(@\d+\.\d+\.\d+|==\d+\.\d+\.\d+)$/);
    }
  });

  it("keeps credentials in the vault and never lists a tool as both read and write", () => {
    for (const e of catalog.values()) {
      for (const [key, v] of Object.entries(e.env)) {
        if (/TOKEN|SECRET|PASSWORD/.test(key)) expect(v, `${e.id} ${key}`).toMatch(/^vault:|^$/);
      }
      expect(
        e.tools.read.filter((t) => e.tools.write.includes(t)),
        e.id,
      ).toEqual([]);
    }
    expect(secretRefs(catalog.get("wordpress") as never, "acme")).toEqual([
      "vault:wordpress-url-acme",
      "vault:wordpress-user-acme",
      "vault:wordpress-password-acme",
    ]);
    // Local apps carry no credentials, so game-dev agents with a shell may use them.
    expect(secretRefs(catalog.get("blender") as never)).toEqual([]);
    expect(secretRefs(catalog.get("unity") as never)).toEqual([]);
  });

  it("limits the shared Google accounts to the project's own targets (ADR-0036)", () => {
    expect(catalog.get("ga4")?.scope?.args).toEqual(["property_id"]);
    expect(catalog.get("search-console")?.scope?.args).toEqual(["site_url", "site_urls"]);
    // Tools that list every client are not free.
    expect(catalog.get("ga4")?.scope?.free).not.toContain("get_account_summaries");
    expect(catalog.get("search-console")?.scope?.free).not.toContain("gsc_properties_list");
  });
});
