import { describe, expect, it } from "vitest";
import { type CatalogEntry, catalogEntrySchema, loadCatalog, TOOL_CLASSES } from "./catalog.ts";
import { isSecured, liveGuard, liveRefusal } from "./live.ts";
import type { AccountEntry, ProjectClass } from "./projects.ts";

const SEED = new URL("../../../seed/catalog/", import.meta.url).pathname;
const seed = loadCatalog(SEED, "/nonexistent");
const get = (id: string) => seed.get(id) as CatalogEntry;

// One write tool per class, scoped by a `site` argument.
const SOCIAL = catalogEntrySchema.parse({
  id: "social",
  name: "Social",
  command: "npx",
  env: { KEY: "vault:social-key" },
  tools: {
    read: ["list_posts"],
    write: ["save_draft", "hide_post", "publish_post", "boost_post"],
    class: { save_draft: "draft", hide_post: "reversible", boost_post: "spend" },
  },
  scope: { args: ["site"] },
});
const WRITES = ["save_draft", "hide_post", "publish_post", "boost_post"];

const project = (
  cls: ProjectClass | undefined,
  integrationEntries: Record<string, AccountEntry[]>,
) => ({ ...(cls ? { class: cls } : {}), integrationEntries });
const live = (value: string): AccountEntry => ({ value, env: "live" });
const staging = (value: string): AccountEntry => ({ value, env: "staging" });

describe("the secured-live rule (ADR-0067)", () => {
  it("an unset class counts as secured", () => {
    expect(isSecured({})).toBe(true);
    expect(isSecured({ class: "secured" })).toBe(true);
    expect(isSecured({ class: "experimental" })).toBe(false);
  });

  it("refuses every write class on a live target of a secured or unset project; reads pass", () => {
    expect(WRITES.map((t) => SOCIAL.tools.class[t] ?? "live").sort()).toEqual(
      TOOL_CLASSES.filter((c) => c !== "read").sort(),
    );
    for (const cls of ["secured", undefined] as const) {
      const guard = liveGuard(SOCIAL, project(cls, { social: [live("a"), staging("s")] }));
      expect(guard).toBeDefined();
      if (!guard) continue;
      for (const tool of WRITES) {
        expect(liveRefusal(guard, tool, { site: "a" })).toMatch(/a is a live target.*staging/);
        expect(liveRefusal(guard, tool, { site: "s" })).toBeUndefined();
        // A list naming one live target is refused as a whole.
        expect(liveRefusal(guard, tool, { site: ["s", "a"] })).toMatch(/live target/);
      }
      expect(liveRefusal(guard, "list_posts", { site: "a" })).toBeUndefined();
    }
  });

  it("untagged entries are live (a plain string loads as live)", () => {
    const guard = liveGuard(SOCIAL, project(undefined, { social: [live("plain")] }));
    expect(guard?.staging).toEqual([]);
    expect(liveRefusal(guard as never, "save_draft", { site: "plain" })).toMatch(/live target/);
  });

  it("does not apply to experimental projects (own accounts included)", () => {
    expect(liveGuard(SOCIAL, project("experimental", { social: [live("a")] }))).toBeUndefined();
  });

  it("does not apply to entries that reach no project account or site", () => {
    const p = project("secured", {});
    for (const id of ["blender", "unity", "fal", "meshy", "elevenlabs"]) {
      expect(liveGuard(get(id), p)).toBeUndefined();
    }
    // ga4 has no write tools at all.
    expect(liveGuard(get("ga4"), project("secured", { ga4: [live("1")] }))).toBeUndefined();
  });

  it("fails closed when a write call names no target", () => {
    const p = project("secured", {
      facebook: [staging("page-1")],
      instagram: [staging("ig-1")],
    });
    const meta = liveGuard(get("meta"), p);
    expect(liveRefusal(meta as never, "meta_create_post", { page_id: "page-1" })).toBeUndefined();
    // A free write tool without page or account id: which account it hits cannot be told.
    expect(liveRefusal(meta as never, "meta_reply_instagram_comment", { comment_id: "c" })).toMatch(
      /does not say which target/,
    );
    // Search Console: staging site writable, call without one refused.
    const gsc = liveGuard(
      get("search-console"),
      project(undefined, {
        "search-console": [staging("sc-domain:staging.example")],
      }),
    );
    expect(
      liveRefusal(gsc as never, "gsc_sitemap_submit", { site_url: "sc-domain:staging.example" }),
    ).toBeUndefined();
    expect(liveRefusal(gsc as never, "gsc_sitemap_submit", {})).toMatch(/does not say/);
  });

  it("WordPress: the site argument, or the only site when it is left out (ADR-0047)", () => {
    const wp = get("wordpress");
    const one = liveGuard(wp, project(undefined, { wordpress: [staging("https://s.example")] }));
    expect(liveRefusal(one as never, "create_draft", {})).toBeUndefined();
    const oneLive = liveGuard(wp, project(undefined, { wordpress: [live("https://a.example")] }));
    expect(liveRefusal(oneLive as never, "create_draft", {})).toMatch(/writes to a live target/);
    const two = liveGuard(
      wp,
      project("secured", { wordpress: [live("https://a.example"), staging("https://s.example")] }),
    );
    expect(liveRefusal(two as never, "create_draft", {})).toMatch(/does not say/);
    expect(
      liveRefusal(two as never, "create_draft", { site: "https://s.example" }),
    ).toBeUndefined();
    expect(liveRefusal(two as never, "create_draft", { site: "https://a.example" })).toMatch(
      /live target/,
    );
  });

  it("entries without a target argument: the configured account decides, per-client keys fail closed", () => {
    const site = catalogEntrySchema.parse({
      id: "site",
      name: "Site",
      command: "npx",
      env: { URL: "{account:wordpress}", KEY: "vault:site-{project}" },
      tools: { read: ["ping"], write: ["deploy"] },
    });
    const first = (env: "live" | "staging") =>
      liveGuard(site, project(undefined, { wordpress: [{ value: "https://x", env }] }));
    expect(liveRefusal(first("staging") as never, "deploy", {})).toBeUndefined();
    expect(liveRefusal(first("live") as never, "deploy", {})).toMatch(/live target/);
    const perClient = catalogEntrySchema.parse({
      id: "wp",
      name: "WP",
      command: "npx",
      env: { WP_PASSWORD: "vault:wp-{project}" },
      tools: { read: ["list_posts"], write: ["create_post"] },
    });
    const guard = liveGuard(perClient, project(undefined, {}));
    expect(liveRefusal(guard as never, "create_post", {})).toMatch(/does not say/);
    expect(liveRefusal(guard as never, "list_posts", {})).toBeUndefined();
  });
});
