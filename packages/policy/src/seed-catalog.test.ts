import { describe, expect, it } from "vitest";
import {
  accountRefs,
  type CatalogEntry,
  integrationStatus,
  loadCatalog,
  secretRefs,
  toolClass,
} from "./catalog.ts";

const SEED = new URL("../../../seed/catalog/", import.meta.url).pathname;

describe("shipped integration catalog", () => {
  const catalog = loadCatalog(SEED, "/nonexistent");

  it("parses and contains the first integrations", () => {
    expect([...catalog.keys()].sort()).toEqual([
      "blender",
      "elevenlabs",
      "fal",
      "ga4",
      "meshy",
      "meta",
      "search-console",
      "unity",
      "wordpress",
    ]);
  });

  it("pins every ecosystem package to an exact version", () => {
    for (const e of catalog.values()) {
      if (e.builtin || e.url) continue;
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
    // Several sites per project, each with its own credentials (ADR-0047).
    expect(secretRefs(catalog.get("wordpress") as never, "acme")).toEqual([
      "vault:wordpress-user-acme-{site}",
      "vault:wordpress-password-acme-{site}",
    ]);
    expect(catalog.get("wordpress")?.sites?.first).toEqual({
      user: "vault:wordpress-user-{project}",
      password: "vault:wordpress-password-{project}",
    });
    expect(catalog.get("wordpress")?.scope).toMatchObject({ args: ["site"], optional: true });
    // The site address is not a secret: it comes from the project's accounts.
    expect(accountRefs(catalog.get("wordpress") as never)).toEqual(["wordpress"]);
    // Local apps carry no credentials, so game-dev agents with a shell may use them.
    expect(secretRefs(catalog.get("blender") as never)).toEqual([]);
    expect(secretRefs(catalog.get("unity") as never)).toEqual([]);
  });

  it("names the local apps achords opens for a run (ADR-0054)", () => {
    expect(catalog.get("blender")?.app).toMatchObject({ name: "Blender", ready: { port: 9876 } });
    const unity = catalog.get("unity")?.app;
    expect(unity?.open).toContain("{workdir}");
    expect(unity?.requires).toBe("ProjectSettings/ProjectVersion.txt");
    expect([...catalog.values()].filter((e) => e.app).map((e) => e.id)).toEqual([
      "blender",
      "unity",
    ]);
  });

  it("classifies every shipped write tool (ADR-0067)", () => {
    for (const e of catalog.values()) {
      expect(
        e.tools.write.filter((t) => !(t in e.tools.class)),
        e.id,
      ).toEqual([]);
    }
    const wp = catalog.get("wordpress") as CatalogEntry;
    expect(toolClass(wp, "create_draft")).toBe("draft");
    expect(toolClass(wp, "get_post")).toBe("read");
    expect(toolClass(catalog.get("meta") as CatalogEntry, "meta_create_post")).toBe("live");
    expect(toolClass(catalog.get("fal") as CatalogEntry, "run_model")).toBe("spend");
  });

  it("limits the shared Google accounts to the project's own targets (ADR-0036)", () => {
    expect(catalog.get("ga4")?.scope?.args).toEqual(["property_id"]);
    expect(catalog.get("search-console")?.scope?.args).toEqual(["site_url", "site_urls"]);
    // Tools that list every client are not free.
    expect(catalog.get("ga4")?.scope?.free).not.toContain("get_account_summaries");
    expect(catalog.get("search-console")?.scope?.free).not.toContain("gsc_properties_list");
    // Meta: page and Instagram ids from the project's facebook and instagram accounts.
    const meta = catalog.get("meta");
    expect(meta?.scope?.channels).toEqual(["facebook", "instagram"]);
    expect(meta?.scope?.free).not.toContain("meta_list_pages");
    expect(meta?.scope?.free).not.toContain("meta_list_instagram_accounts");
    for (const t of meta?.scope?.free ?? []) {
      expect([...(meta?.tools.read ?? []), ...(meta?.tools.write ?? [])], t).toContain(t);
    }
  });

  it("offers the media services as shared sign-ins with a key field (ADR-0048)", () => {
    const status = integrationStatus(
      catalog,
      [],
      [],
      () => false,
      () => true,
    );
    const media = status.filter((s) => ["elevenlabs", "meshy", "fal"].includes(s.id));
    expect(media.map((s) => [s.id, s.kind, s.missingSecrets])).toEqual([
      ["elevenlabs", "account", ["elevenlabs-api-key"]],
      ["fal", "account", ["fal-api-key"]],
      ["meshy", "account", ["meshy-api-key"]],
    ]);
    // fal is remote: nothing to install, its key goes into the Authorization header.
    const fal = catalog.get("fal");
    expect(fal?.url).toBe("https://mcp.fal.ai/mcp");
    expect(fal?.authorization).toEqual({ scheme: "Key", secret: "vault:fal-api-key" });
    expect(media.find((s) => s.id === "fal")?.command).toBeUndefined();
    expect(catalog.get("elevenlabs")?.env.ELEVENLABS_MCP_BASE_PATH).toBe("{workdir}");
  });

  it("makes every paid media tool a write tool and leaves out calls and agents", () => {
    const write = (id: string) => catalog.get(id)?.tools.write ?? [];
    const all = (id: string) => [...(catalog.get(id)?.tools.read ?? []), ...write(id)];
    expect(write("elevenlabs")).toEqual(
      expect.arrayContaining(["text_to_speech", "voice_clone", "compose_music", "speech_to_text"]),
    );
    for (const t of ["make_outbound_call", "list_phone_numbers", "create_agent", "play_audio"]) {
      expect(all("elevenlabs")).not.toContain(t);
    }
    expect(write("meshy")).toEqual(
      expect.arrayContaining(["meshy_text_to_3d", "meshy_image_to_3d", "meshy_rig"]),
    );
    expect(all("meshy")).not.toContain("meshy_send_to_slicer");
    expect(write("fal")).toEqual(expect.arrayContaining(["run_model", "submit_job"]));
  });

  it("connection tests only read", () => {
    for (const e of catalog.values()) {
      if (e.test) expect(e.tools.read, e.id).toContain(e.test.tool);
    }
    expect(catalog.get("wordpress")?.test?.tool).toBe("site_info");
  });
});
