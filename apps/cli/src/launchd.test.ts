import { describe, expect, it } from "vitest";
import { LABEL, launchdService, protectedFolderOf, renderPlist } from "./launchd.ts";

const input = {
  nodePath: "/usr/local/bin/node",
  gatewayEntry: "/opt/achords & co/apps/gateway/src/main.ts",
  home: "/Users/x/.achords",
  logFile: "/Users/x/.achords/logs/gateway.log",
  path: "/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin:/bin",
};

describe("renderPlist", () => {
  it("produces a launchd job that only respawns on crashes", () => {
    const xml = renderPlist(input);
    expect(xml).toContain(`<string>${LABEL}</string>`);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(xml).toContain("<string>/usr/local/bin/node</string>");
    expect(xml).toContain("<string>--disable-warning=ExperimentalWarning</string>");
    expect(xml).toContain("<string>/opt/achords &amp; co/apps/gateway/src/main.ts</string>");
    expect(xml).toMatch(/<key>ACHORDS_HOME<\/key>\s*<string>\/Users\/x\/.achords<\/string>/);
    expect(xml).toContain("<key>StandardErrorPath</key>");
    // launchd's default PATH lacks ~/.local/bin etc., where the claude CLI usually lives.
    expect(xml).toMatch(
      /<key>PATH<\/key>\s*<string>\/Users\/x\/.local\/bin:\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/,
    );
  });
});

describe("launchdService", () => {
  function fake(loaded: boolean) {
    const calls: string[][] = [];
    const written: string[] = [];
    const svc = launchdService(input, {
      uid: 501,
      plistPath: "/tmp/test.plist",
      launchctl: (args) => {
        calls.push(args);
        if (args[0] === "print" && !loaded) throw new Error("not loaded");
      },
      writeFile: (path) => written.push(path),
    });
    return { svc, calls, written };
  }

  it("bootstraps when not loaded and kickstarts when loaded", () => {
    const a = fake(false);
    a.svc.start();
    expect(a.written).toEqual(["/tmp/test.plist"]);
    expect(a.calls).toContainEqual(["bootstrap", "gui/501", "/tmp/test.plist"]);

    const b = fake(true);
    b.svc.start();
    expect(b.calls).toContainEqual(["kickstart", `gui/501/${LABEL}`]);
  });

  it("boots out only a loaded job", () => {
    const a = fake(true);
    expect(a.svc.stop()).toBe(true);
    expect(a.calls).toContainEqual(["bootout", `gui/501/${LABEL}`]);
    const b = fake(false);
    expect(b.svc.stop()).toBe(false);
    expect(b.calls.some((c) => c[0] === "bootout")).toBe(false);
  });
});

describe("protectedFolderOf", () => {
  it("detects macOS privacy-protected folders (launchd jobs cannot read them)", () => {
    expect(protectedFolderOf("/Users/x/Documents/Git/a/main.ts", "/Users/x")).toBe("Documents");
    expect(protectedFolderOf("/Users/x/Desktop/a.ts", "/Users/x")).toBe("Desktop");
    expect(protectedFolderOf("/Users/x/Code/a.ts", "/Users/x")).toBeUndefined();
    expect(protectedFolderOf("/Users/x/DocumentsOld/a.ts", "/Users/x")).toBeUndefined();
  });
});
