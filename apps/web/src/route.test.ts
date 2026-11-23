import { describe, expect, it } from "vitest";
import { inAppPath, legacyPath, routeOf } from "./route.ts";

const O = "https://mac.example";

describe("plain path routes", () => {
  it("splits a path into its parts", () => {
    expect(routeOf("/chat/abc")).toEqual(["chat", "abc"]);
    expect(routeOf("/")).toEqual([]);
    expect(routeOf("/chats/my%20project")).toEqual(["chats", "my project"]);
  });

  it("turns an old #/ link into its path", () => {
    expect(legacyPath("#/settings/guide")).toBe("/settings/guide");
    expect(legacyPath("#top")).toBeUndefined();
    expect(legacyPath("")).toBeUndefined();
  });

  it("opens own links in the app; leaves the API, other sites and new tabs alone", () => {
    expect(inAppPath("/kanban", O)).toBe("/kanban");
    expect(inAppPath(`${O}/chat/x`, O)).toBe("/chat/x");
    expect(inAppPath("/api/files/x", O)).toBeUndefined();
    expect(inAppPath("https://github.com/x", O)).toBeUndefined();
    expect(inAppPath("/chat", O, { target: "_blank" })).toBeUndefined();
    expect(inAppPath("/chat", O, { modified: true })).toBeUndefined();
    expect(inAppPath("/x.zip", O, { download: true })).toBeUndefined();
    expect(inAppPath(null, O)).toBeUndefined();
  });
});
