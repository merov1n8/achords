import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowedIntegrationTools,
  type CatalogEntry,
  grantedIntegrations,
  integrationStatus,
  loadCatalog,
  ownerSecrets,
  publishMode,
  scopeRefusal,
  scopeTargets,
  secretRefs,
  siteCredentials,
  siteSlug,
  siteStatus,
  toolClass,
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

  it("classifies tools: read tools read, write tools as listed, unclassified ones live (ADR-0067)", () => {
    const { seed, owner } = dirs();
    writeFileSync(
      join(owner, "wordpress.yaml"),
      WORDPRESS.replace(
        "write: [create_post]",
        "write: [create_post, create_draft]\n  class: { create_draft: draft }",
      ),
    );
    const entry = loadCatalog(seed, owner).get("wordpress") as CatalogEntry;
    expect(toolClass(entry, "list_posts")).toBe("read");
    expect(toolClass(entry, "create_draft")).toBe("draft");
    expect(toolClass(entry, "create_post")).toBe("live");
    writeFileSync(
      join(owner, "wordpress.yaml"),
      WORDPRESS.replace("write: [create_post]", "write: [create_post]\n  class: { delete: live }"),
    );
    expect(() => loadCatalog(seed, owner)).toThrow(/not a listed read or write tool/);
    writeFileSync(
      join(owner, "wordpress.yaml"),
      WORDPRESS.replace(
        "write: [create_post]",
        "write: [create_post]\n  class: { create_post: x }",
      ),
    );
    expect(() => loadCatalog(seed, owner)).toThrow();
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

    // The fixture has a shell on the Mac: WordPress carries a password, so it is refused.
    expect(grantedIntegrations(parseManifest(WEB_DEV, "t"), catalog)).toEqual({
      ok: false,
      reason:
        "integration wordpress uses credentials and agent web-dev has a shell on this Mac; switch its Apple container on to give it both",
    });
    // ADR-0055: in a container the shell cannot reach the gateway's servers, so both are fine.
    const boxed = parseManifest(`${WEB_DEV}\ncontainer: true\n`, "t");
    expect(grantedIntegrations(boxed, catalog).ok).toBe(true);
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

  it("needs exactly one of command, builtin and url", () => {
    const one = /one of command, builtin or url/;
    expect(() => write("id: x\nname: X\ntools:\n  read: [a]\n")()).toThrow(one);
    expect(() => write("id: x\nname: X\ncommand: npx\nbuiltin: wordpress\n")()).toThrow(one);
    expect(() =>
      write("id: x\nname: X\ncommand: npx\nurl: https://a.com/mcp\nhosts: [a.com]\n")(),
    ).toThrow(one);
    expect(write("id: x\nname: X\nbuiltin: wordpress\n")().get("x")?.builtin).toBe("wordpress");
  });

  it("takes a remote server on an https url of a listed host, its key as a secret", () => {
    const remote =
      'id: r\nname: R\nurl: https://mcp.a.com/mcp\nhosts: [mcp.a.com]\nauthorization: { scheme: Key, secret: "vault:a-key" }\n';
    const entry = write(remote)().get("r");
    if (!entry) throw new Error("missing");
    expect(secretRefs(entry)).toEqual(["vault:a-key"]);
    expect(ownerSecrets(entry)).toEqual(["a-key"]);
    expect(() => write(remote.replace("hosts: [mcp.a.com]", "hosts: [a.com]"))()).toThrow(
      /host listed in hosts/,
    );
    expect(() => write(remote.replace("https:", "http:"))()).toThrow(/host listed in hosts/);
    expect(() => write(remote.replace("vault:a-key", "plain"))()).toThrow();
    expect(() =>
      write('id: r\nname: R\ncommand: npx\nauthorization: { scheme: Key, secret: "vault:k" }\n')(),
    ).toThrow(/only for a url/);
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

  it("names a local app to open in the background, with plain names only (ADR-0054)", () => {
    const app = (yaml: string) => write(`id: b\nname: B\ncommand: uvx\napp:\n${yaml}`)().get("b");
    expect(
      app('  name: Blender\n  open: ["-g", "-a", "Blender"]\n  ready: { port: 9876 }\n')?.app,
    ).toEqual({
      name: "Blender",
      open: ["-g", "-a", "Blender"],
      ready: { port: 9876, timeout_s: 90 },
    });
    expect(() => app('  name: Blender\n  open: ["-a", "Blender"]\n')).toThrow(/include -g/);
    expect(() => app('  name: U\n  open: ["-a", "U", "--args", "-g"]\n')).toThrow(/include -g/);
    expect(() => app('  name: "B\\" & do"\n  open: ["-g", "-a", "B"]\n')).toThrow();
    expect(() => app('  name: U\n  open: ["-g", "-a", "U"]\n  requires: ../x\n')).toThrow(
      /relative path/,
    );
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
    // Settings from project accounts count too.
    writeFileSync(
      join(owner, "site.yaml"),
      'id: site\nname: S\ncommand: npx\nenv:\n  URL: "{account:wordpress}"\n',
    );
    const withSite = integrationStatus(
      loadCatalog(seed, owner),
      [agent],
      [{ slug: "acme", integrations: { wordpress: ["https://a.example"] } }, ...projects.slice(1)],
      () => true,
      () => true,
    ).find((s) => s.id === "site");
    expect(withSite).toMatchObject({ perProject: true, projectsReady: ["acme"] });
  });

  it("groups entries for the web page: shared accounts, per client, local apps", () => {
    const { seed, owner } = dirs();
    writeFileSync(join(owner, "wordpress.yaml"), WORDPRESS);
    writeFileSync(
      join(owner, "ga.yaml"),
      'id: ga\nname: GA\ncommand: uvx\nenv:\n  T: "vault:google-refresh-token"\n',
    );
    writeFileSync(join(owner, "blender.yaml"), "id: blender\nname: B\ncommand: uvx\n");
    const kinds = Object.fromEntries(
      integrationStatus(
        loadCatalog(seed, owner),
        [],
        [],
        () => true,
        () => true,
      ).map((s) => [s.id, s.kind]),
    );
    expect(kinds).toMatchObject({ ga: "account", wordpress: "client", blender: "local" });
  });

  it("names the owner-wide vault ids, the web sign-in kind and the install hint", () => {
    const { seed, owner } = dirs();
    writeFileSync(join(owner, "wordpress.yaml"), WORDPRESS);
    writeFileSync(
      join(owner, "ga.yaml"),
      'id: ga\nname: GA\ncommand: uvx\noauth: google\nenv:\n  T: "vault:google-refresh-token"\n  U: "vault:google-refresh-token"\n',
    );
    writeFileSync(
      join(owner, "blender.yaml"),
      "id: blender\nname: B\ncommand: uvx\ninstall: Get uv\n",
    );
    const catalog = loadCatalog(seed, owner);
    expect(ownerSecrets(catalog.get("ga") as CatalogEntry)).toEqual(["google-refresh-token"]);
    expect(ownerSecrets(catalog.get("wordpress") as CatalogEntry)).toEqual([]);
    const by = Object.fromEntries(
      integrationStatus(
        catalog,
        [],
        [],
        () => false,
        () => false,
      ).map((s) => [s.id, s]),
    );
    expect(by.ga).toMatchObject({ oauth: "google", secrets: ["google-refresh-token"] });
    expect(by.blender).toMatchObject({ install: "Get uv", secrets: [] });
    expect(by.wordpress?.oauth).toBeUndefined();
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

describe("scope targets from account channels", () => {
  it("reads the entry's own channel by default, or the listed channels", () => {
    const { seed, owner } = dirs();
    writeFileSync(
      join(owner, "m.yaml"),
      "id: meta\nname: M\ncommand: npx\nscope:\n  args: [page_id]\n  channels: [facebook, instagram]\n",
    );
    writeFileSync(
      join(owner, "g.yaml"),
      "id: ga4\nname: G\ncommand: uvx\nscope:\n  args: [property_id]\n",
    );
    const c = loadCatalog(seed, owner);
    const accounts = { facebook: ["1"], instagram: ["2", "@handle"], ga4: ["9"] };
    expect(scopeTargets(c.get("meta") as never, accounts)).toEqual(["1", "2", "@handle"]);
    expect(scopeTargets(c.get("ga4") as never, accounts)).toEqual(["9"]);
    expect(scopeTargets(c.get("ga4") as never, undefined)).toEqual([]);
  });
});

describe("several sites per project, each with its own credentials", () => {
  const SITES = `
id: wordpress
name: WordPress
builtin: wordpress
sites:
  channel: wordpress
  env: WP_SITES
  secrets:
    user: "vault:wordpress-user-{project}-{site}"
    password: "vault:wordpress-password-{project}-{site}"
  first:
    user: "vault:wordpress-user-{project}"
    password: "vault:wordpress-password-{project}"
tools:
  read: [site_info]
scope:
  args: [site]
  optional: true
`;
  const load = () => {
    const { seed, owner } = dirs();
    writeFileSync(join(owner, "wordpress.yaml"), SITES);
    return loadCatalog(seed, owner).get("wordpress") as CatalogEntry;
  };

  it("derives a deterministic vault id per site from its address", () => {
    expect(siteSlug("https://www.Acme.example/")).toBe("www-acme-example");
    expect(siteSlug("https://acme.example/blog")).toBe("acme-example-blog");
    expect(siteSlug("http://localhost:8080")).toBe("localhost-8080");
    const entry = load();
    expect(siteCredentials(entry, "acme", "https://acme.example", 1)).toEqual([
      {
        user: "wordpress-user-acme-acme-example",
        password: "wordpress-password-acme-acme-example",
      },
    ]);
    // The first site may still use the ids from before several sites.
    expect(siteCredentials(entry, "acme", "https://acme.example", 0)[1]).toEqual({
      user: "wordpress-user-acme",
      password: "wordpress-password-acme",
    });
    // Long addresses stay within the vault's 64 characters, still unique per site.
    const long = siteCredentials(entry, "acme", `https://${"x".repeat(80)}.example`, 1)[0];
    expect(long?.password).toMatch(/^wordpress-password-acme-x+-[0-9a-f]{8}$/);
    expect(long?.password?.length).toBe(64);
    // Per-site ids count as credentials: the shell and open-web rules see them.
    expect(secretRefs(entry, "acme")).toEqual([
      "vault:wordpress-user-acme-{site}",
      "vault:wordpress-password-acme-{site}",
    ]);
  });

  it("reports per site whether its credentials are set, never values", () => {
    const entry = load();
    const set = new Set([
      "wordpress-user-acme",
      "wordpress-password-acme",
      "wordpress-user-acme-b-example",
    ]);
    const urls = ["https://a.example", "https://b.example"];
    expect(siteStatus(entry, "acme", urls, (id) => set.has(id))).toEqual([
      {
        url: "https://a.example",
        secrets: {
          user: "wordpress-user-acme-a-example",
          password: "wordpress-password-acme-a-example",
        },
        missing: [],
        legacy: true,
        ready: true,
      },
      {
        url: "https://b.example",
        secrets: {
          user: "wordpress-user-acme-b-example",
          password: "wordpress-password-acme-b-example",
        },
        missing: ["wordpress-password-acme-b-example"],
        legacy: false,
        ready: false,
      },
    ]);
  });

  it("counts a project ready when one of its sites has credentials, and lists the others", () => {
    const { seed, owner } = dirs();
    writeFileSync(join(owner, "wordpress.yaml"), SITES);
    const status = integrationStatus(
      loadCatalog(seed, owner),
      [],
      [
        { slug: "acme", integrations: { wordpress: ["https://a.example", "https://b.example"] } },
        { slug: "beta", integrations: {} },
      ],
      (id) => id.endsWith("-acme-a-example"),
      () => true,
    ).find((s) => s.id === "wordpress");
    expect(status).toMatchObject({
      perProject: true,
      missingSecrets: [],
      projectsReady: ["acme"],
      ready: true,
      sites: [
        { project: "acme", url: "https://a.example", ready: true, missing: [] },
        {
          project: "acme",
          url: "https://b.example",
          ready: false,
          missing: ["wordpress-user-acme-b-example", "wordpress-password-acme-b-example"],
        },
      ],
    });
  });

  it("lets an optional scope argument be left out", () => {
    const one = { args: ["site"], free: [], allowed: ["https://a.example"], optional: true };
    expect(scopeRefusal(one, "site_info", {})).toBeUndefined();
    expect(scopeRefusal(one, "site_info", { site: "https://b.example" })).toMatch(/not part/);
    expect(scopeRefusal({ ...one, optional: false }, "site_info", {})).toMatch(/not limited/);
  });
});
