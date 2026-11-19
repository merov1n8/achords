import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { homePaths, resolveHome } from "./home.ts";

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

describe("homePaths", () => {
  it("keeps every runtime file under the home directory", () => {
    const p = homePaths("/h");
    expect(p).toEqual({
      home: "/h",
      db: "/h/core.db",
      runDir: "/h/run",
      pidFile: "/h/run/gateway.pid",
      stopFile: "/h/run/STOP",
      logDir: "/h/logs",
    });
  });
});
