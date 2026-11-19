import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homePaths } from "@achords/core";
import { describe, expect, it } from "vitest";
import { defaultKeyStore, openHomeVault } from "./home.ts";

describe("openHomeVault", () => {
  it("uses the Keychain on macOS and a 0600 file elsewhere or when forced", () => {
    const paths = homePaths("/h");
    expect(defaultKeyStore(paths, {}, "darwin").kind).toBe("keychain");
    expect(defaultKeyStore(paths, {}, "linux").kind).toBe("file");
    expect(defaultKeyStore(paths, { ACHORDS_KEYSTORE: "file" }, "darwin").kind).toBe("file");
  });

  it("opens the vault under ACHORDS_HOME with a persistent key", () => {
    const home = mkdtempSync(join(tmpdir(), "achords-hv-"));
    try {
      const env = { ACHORDS_KEYSTORE: "file" };
      const v1 = openHomeVault(home, env);
      v1.set("x.key", "value-123456789", "test");
      v1.close();
      const v2 = openHomeVault(home, env);
      expect(v2.resolve("x.key", "test")).toBe("value-123456789");
      v2.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
