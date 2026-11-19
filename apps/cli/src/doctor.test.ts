import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homePaths } from "@achords/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DoctorEnv, runDoctor } from "./doctor.ts";

describe("doctor", () => {
  let root: string;
  let env: DoctorEnv;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "achords-doctor-"));
    const webDist = join(root, "dist");
    mkdirSync(webDist);
    writeFileSync(join(webDist, "index.html"), "<!doctype html>");
    mkdirSync(join(root, "home"), { mode: 0o700 });
    env = {
      paths: homePaths(join(root, "home")),
      nodeVersion: "22.23.5",
      platform: "darwin",
      gatewayEntry: "/Users/x/Code/achords/apps/gateway/src/main.ts",
      userHome: "/Users/x",
      webDist,
      which: (bin) => (bin === "claude" || bin === "git" ? `/usr/local/bin/${bin}` : undefined),
      version: (bin) => (bin === "claude" ? "2.1.328 (Claude Code)" : "git version 2.50.0"),
      serviceLoaded: () => true,
      gatewayResponds: async () => true,
      vaultStatus: () => ({ ok: true, telegram: true }),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const byName = async (e: DoctorEnv) =>
    Object.fromEntries((await runDoctor(e)).map((c) => [c.name, c]));

  it("passes on a healthy install", async () => {
    const checks = await runDoctor(env);
    expect(checks.filter((c) => c.level === "fail")).toEqual([]);
    expect(checks.map((c) => c.name)).toEqual([
      "node",
      "claude CLI",
      "git",
      "data folder",
      "web UI",
      "macOS folder access",
      "service",
      "gateway",
      "vault",
      "telegram",
    ]);
  });

  it("fails on an old Node, a missing claude CLI and an unbuilt UI, with a fix for each", async () => {
    const c = await byName({
      ...env,
      nodeVersion: "22.11.0",
      which: () => undefined,
      webDist: join(root, "missing"),
    });
    expect(c.node).toMatchObject({ level: "fail" });
    expect(c.node?.fix).toMatch(/22\.13/);
    expect(c["claude CLI"]).toMatchObject({ level: "fail" });
    expect(c["claude CLI"]?.fix).toMatch(/install/i);
    expect(c["web UI"]?.fix).toMatch(/pnpm build/);
  });

  it("flags a data folder readable by others", async () => {
    rmSync(env.paths.home, { recursive: true });
    mkdirSync(env.paths.home, { mode: 0o755 });
    const c = await byName(env);
    expect(c["data folder"]).toMatchObject({ level: "warn" });
    expect(c["data folder"]?.fix).toMatch(/chmod 700/);
  });

  it("warns about a checkout in a macOS privacy-protected folder", async () => {
    const c = await byName({ ...env, gatewayEntry: "/Users/x/Documents/a/main.ts" });
    expect(c["macOS folder access"]).toMatchObject({ level: "warn" });
  });

  it("reports a stopped service/gateway and a missing Telegram token as info/warn, not failure", async () => {
    const c = await byName({
      ...env,
      serviceLoaded: () => false,
      gatewayResponds: async () => false,
      vaultStatus: () => ({ ok: true, telegram: false }),
    });
    expect(c.service?.level).toBe("warn");
    expect(c.gateway?.level).toBe("warn");
    expect(c.telegram?.level).toBe("info");
  });

  it("fails when the vault cannot be opened (e.g. Keychain denied)", async () => {
    const c = await byName({ ...env, vaultStatus: () => ({ ok: false, error: "denied" }) });
    expect(c.vault).toMatchObject({ level: "fail" });
  });
});
