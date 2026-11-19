import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHome } from "./home.ts";

describe("resolveHome", () => {
  it("defaults to ~/.achords", () => {
    expect(resolveHome({})).toBe(join(homedir(), ".achords"));
  });

  it("honours ACHORDS_HOME and resolves it to an absolute path", () => {
    expect(resolveHome({ ACHORDS_HOME: "/srv/achords" })).toBe("/srv/achords");
    expect(resolveHome({ ACHORDS_HOME: "rel" })).toBe(join(process.cwd(), "rel"));
  });

  it("ignores an empty ACHORDS_HOME", () => {
    expect(resolveHome({ ACHORDS_HOME: "" })).toBe(join(homedir(), ".achords"));
  });
});
