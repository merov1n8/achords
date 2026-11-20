import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowedIntegrationTools,
  grantedIntegrations,
  integrationStatus,
  loadCatalog,
  publishMode,
  scopeRefusal,
  secretRefs,
} from "./catalog.ts";
import { parseManifest } from "./manifest.ts";
import { WEB_DEV } from "./test-fixtures.ts";

const WORDPRESS = `
id: wordpress
name: WordPress
command: npx
args: ["-y", "some-wordpress-mcp@1.2.3"]
env:
  WP_URL: https://example.com
  WP_PASSWORD: "vault:wordpress-{project}"
hosts: [example.com]
tools:
  read: [list_posts, get_post]
  write: [create_post]
`;
const BLENDER = `
id: blender
name: Blender
command: uvx
args: ["blender-mcp==1.0.0"]
tools:
  read: [get_scene_info]
`;

function dirs() {
  const root = mkdtempSync(join(tmpdir(), "catalog-"));
  const seed = join(root, "seed");
  const owner = join(root, "owner");
  mkdirSync(seed);
  mkdirSync(owner);
  writeFileSync(join(seed, "wordpress.yaml"), WORDPRESS);
  writeFileSync(join(seed, "blender.yaml"), BLENDER);
  return { seed, owner };
}

describe("integration catalog (ADR-0034)", () => {
  it("loads shipped entries and lets an owner file with the same id replace one", () => {
    const { seed, owner } = dirs();
    writeFileSync(join(owner, "blender.yaml"), BLENDER.replace("Blender", "My Blender"));
    const catalog = loadCatalog(seed, owner);
    expect([...catalog.keys()].sort()).toEqual(["blender", "wordpress"]);
    expect(catalog.get("blender")?.name).toBe("My Blender");
    expect(loadCatalog(seed, join(owner, "missing")).size).toBe(2);
  });

  it("rejects unknown keys and malformed vault references", () => {
    const { seed, owner } = dirs();
    writeFileSync(join(owner, "x.yaml"), `${BLENDER}\nsecret: abc\n`);
    expect(() => loadCatalog(seed, owner)).toThrow();
    writeFileSync(join(owner, "x.yaml"), WORDPRESS.replace("vault:wordpress", "vault:Bad Id"));
    expect(() => loadCatalog(seed, owner)).toThrow(/invalid vault reference/);
  });

  it("fills the project into secret references", () => {
    const catalog = loadCatalog(dirs().seed, "/nonexistent");
    const wp = catalog.get("wordpress");
    if (!wp) throw new Error("missing");
    expect(secretRefs(wp, "acme")).toEqual(["vault:wordpress-acme"]);
    expect(secretRefs(wp)).toEqual(["vault:wordpress-{project}"]);
  });

  it("grants only listed entries, refuses unknown ids and secrets next to a shell", () => {
    const catalog = loadCatalog(dirs().seed, "/nonexistent");
    const noShell = parseManifest(WEB_DEV.replace(/shell:\n.*\n/, ""), "t");
    const granted = grantedIntegrations(noShell, catalog);
    expect(granted.ok && granted.entries.map((e) => e.id)).toEqual(["wordpress"]);

    // The fixture has a shell: WordPress carries a password, so it is refused.
    expect(grantedIntegrations(parseManifest(WEB_DEV, "t"), catalog)).toEqual({
      ok: false,
      reason: "integration wordpress uses credentials and agent web-dev has a shell",
    });
    // Blender has no secrets: fine with a shell.
    const blender = parseManifest(WEB_DEV.replace("mcp: [wordpress]", "mcp: [blender]"), "t");
    expect(grantedIntegrations(blender, catalog).ok).toBe(true);

    const unknown = parseManifest(WEB_DEV.replace("mcp: [wordpress]", "mcp: [ga4]"), "t");
    expect(grantedIntegrations(unknown, catalog)).toEqual({
      ok: false,
      reason: "integration ga4 is not in the catalog",
    });
  });

  it("allows read tools only; write tools wait for publishing review", () => {
    const wp = loadCatalog(dirs().seed, "/nonexistent").get("wordpress");
    if (!wp) throw new Error("missing");
    expect(allowedIntegrationTools(wp)).toEqual([
      "mcp__wordpress__list_posts",
      "mcp__wordpress__get_post",
    ]);
  });

  it("adds write tools under full access only when the integration has no credentials", () => {
    const wp = loadCatalog(dirs().seed, "/nonexistent").get("wordpress");
    if (!wp) throw new Error("missing");
    expect(allowedIntegrationTools(wp, true)).toEqual(allowedIntegrationTools(wp));
    const local = { ...wp, id: "blender", env: {}, files: {} };
    expect(allowedIntegrationTools(local, true)).toEqual([
      "mcp__blender__list_posts",
      "mcp__blender__get_post",
      ...local.tools.write.map((t) => `mcp__blender__${t}`),
    ]);
    expect(local.tools.write.length).toBeGreaterThan(0);
  });
});

describe("catalog entries with builtin servers and credential files", () => {
  const write = (yaml: string) => {
    const { seed, owner } = dirs();
    writeFileSync(join(owner, "x.yaml"), yaml);
    return () => loadCatalog(seed, owner);
  };

  it("needs exactly one of command and builtin", () => {
    expect(() => write("id: x\nname: X\ntools:\n  read: [a]\n")()).toThrow(/command or builtin/);
    expect(() => write("id: x\nname: X\ncommand: npx\nbuiltin: wordpress\n")()).toThrow(
      /command or builtin/,
    );
    expect(write("id: x\nname: X\nbuiltin: wordpress\n")().get("x")?.builtin).toBe("wordpress");
  });

  it("counts vault references inside credential files as secrets", () => {
    const entry = write(
      'id: g\nname: G\ncommand: uvx\nfiles:\n  GOOGLE_APPLICATION_CREDENTIALS:\n    type: authorized_user\n    refresh_token: "vault:google-refresh-token"\n',
    )().get("g");
    if (!entry) throw new Error("missing");
    expect(secretRefs(entry)).toEqual(["vault:google-refresh-token"]);
    expect(() =>
      write('id: g\nname: G\ncommand: uvx\nfiles:\n  F:\n    token: "vault:Bad"\n')(),
    ).toThrow(/invalid vault reference/);
  });
});

describe("project scope of shared accounts (ADR-0036)", () => {
  const ga = { args: ["property_id"], free: [], strip: "properties/", allowed: ["111"] };
  const gsc = {
    args: ["site_url", "site_urls"],
    free: ["gsc_server_guide"],
    allowed: ["sc-domain:a.com"],
  };

  it("passes the project's own values, in either spelling", () => {
    expect(scopeRefusal(ga, "run_report", { property_id: "111" })).toBeUndefined();
    expect(scopeRefusal(ga, "run_report", { property_id: "properties/111" })).toBeUndefined();
    expect(scopeRefusal(ga, "run_report", { property_id: 111 })).toBeUndefined();
    expect(scopeRefusal(gsc, "gsc_server_guide", {})).toBeUndefined();
  });

  it("refuses other clients, lists of everyone, and odd values", () => {
    expect(scopeRefusal(ga, "run_report", { property_id: "222" })).toMatch(/222 is not part/);
    expect(scopeRefusal(ga, "get_account_summaries", {})).toMatch(/not limited/);
    expect(scopeRefusal(ga, "get_account_summaries", undefined)).toMatch(/not limited/);
    expect(
      scopeRefusal(gsc, "gsc_multi_property_health", { site_urls: ["sc-domain:a.com", "b.com"] }),
    ).toMatch(/b.com/);
    expect(scopeRefusal(ga, "run_report", { property_id: { id: "111" } })).toBeDefined();
  });
});

describe("integration status (doctor, web)", () => {
  it("names what each integration still needs", () => {
    const { seed, owner } = dirs();
    writeFileSync(join(owner, "wordpress.yaml"), WORDPRESS);
    writeFileSync(
      join(owner, "ga.yaml"),
      'id: ga\nname: GA\ncommand: uvx\nenv:\n  T: "vault:google-refresh-token"\nscope:\n  args: [property_id]\n',
    );
    const catalog = loadCatalog(seed, owner);
    const agent = parseManifest(
      "id: seo\nname: s\nrole: s\nworkspace: w\nmodels:\n  default: cli-claude/sonnet\nmcp: [ga]\n",
      "t",
    );
    const projects = [
      { slug: "acme", integrations: { ga: ["1"] } },
      { slug: "beta", integrations: {} },
    ];
    const status = (secrets: string[], path: string[]) =>
      integrationStatus(
        catalog,
        [agent],
        projects,
        (id) => secrets.includes(id),
        (bin) => path.includes(bin),
      );
    const ga = status([], ["uvx"]).find((s) => s.id === "ga");
    expect(ga).toMatchObject({
      usedBy: ["seo"],
      commandFound: true,
      missingSecrets: ["google-refresh-token"],
      projectsScoped: ["acme"],
      ready: false,
    });
    expect(status(["google-refresh-token"], ["uvx"]).find((s) => s.id === "ga")?.ready).toBe(true);
    expect(status(["google-refresh-token"], []).find((s) => s.id === "ga")?.ready).toBe(false);
    const wp = status(["wordpress-acme"], ["npx"]).find((s) => s.id === "wordpress");
    expect(wp).toMatchObject({ perProject: true, projectsReady: ["acme"], missingSecrets: [] });
  });
});

describe("publish mode (ADR-0037)", () => {
  const agent = parseManifest(
    "id: m\nname: m\nrole: m\nworkspace: w\nmodels:\n  default: cli-claude/sonnet\npublish_mode:\n  default: review\n  channels:\n    wordpress: auto\n",
    "t",
  );
  it("takes the channel setting, else the default; a project only tightens it", () => {
    expect(publishMode(agent, "wordpress")).toBe("auto");
    expect(publishMode(agent, "meta")).toBe("review");
    expect(publishMode(agent, "wordpress", { publish: "review" })).toBe("review");
    expect(publishMode(agent, "wordpress", { publish: "off" })).toBe("off");
    expect(publishMode(agent, "meta", {})).toBe("review");
  });
});
