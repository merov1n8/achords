import { describe, expect, it } from "vitest";
import { revocable, revokeAffects, signinServices } from "./integrations.ts";
import type { IntegrationStatus } from "./types.ts";

const entry = (over: Partial<IntegrationStatus>): IntegrationStatus => ({
  id: "x",
  name: "X",
  usedBy: [],
  commandFound: true,
  secrets: [],
  missingSecrets: [],
  perProject: false,
  projectsReady: [],
  scoped: false,
  projectsScoped: [],
  ready: true,
  testable: false,
  sites: [],
  kind: "account",
  ...over,
});
const google = ["google-client-id", "google-refresh-token"];
const ga4 = entry({ id: "ga4", name: "GA4", oauth: "google", secrets: google });
const gsc = entry({ id: "gsc", name: "Search Console", oauth: "google", secrets: google });
const meta = entry({ id: "meta", name: "Meta", secrets: ["meta-access-token"] });
const blender = entry({ id: "blender", name: "Blender", kind: "local" });

describe("integration helpers", () => {
  it("offers one Google choice for every Google entry, and each token service on its own", () => {
    const out = signinServices([ga4, meta, gsc, blender]);
    expect(out.map((s) => [s.key, s.name, s.entries.map((e) => e.id)])).toEqual([
      ["google", "Google", ["ga4", "gsc"]],
      ["meta", "Meta", ["meta"]],
    ]);
  });

  it("names everything a revoke takes away", () => {
    expect(revokeAffects([ga4, gsc, meta], ga4)).toEqual(["GA4", "Search Console"]);
    expect(revokeAffects([ga4, gsc, meta], meta)).toEqual(["Meta"]);
  });

  it("offers revoke only when something is set", () => {
    expect(revocable(meta)).toBe(true);
    expect(revocable({ ...meta, missingSecrets: ["meta-access-token"] })).toBe(false);
    expect(revocable(blender)).toBe(false);
  });
});
