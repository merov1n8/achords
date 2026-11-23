import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Agent, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, homePaths, listAgents, openCoreDatabase } from "@achords/core";
import { afterEach, describe, expect, it } from "vitest";
import { HEARTBEAT_KEY } from "./gateway.ts";

const MAIN = new URL("./main.ts", import.meta.url).pathname;

function startGateway(home: string): ChildProcess {
  return spawn(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN], {
    // Port 0: no clash with a real gateway; file key store: never touch the Keychain in tests.
    env: { ...process.env, ACHORDS_HOME: home, ACHORDS_PORT: "0", ACHORDS_KEYSTORE: "file" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function exitCode(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("gateway process", () => {
  let home: string;
  let child: ChildProcess | undefined;
  afterEach(() => {
    child?.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });

  it("writes a pidfile and heartbeat, and shuts down cleanly on SIGTERM", async () => {
    home = mkdtempSync(join(tmpdir(), "achords-gw-"));
    const paths = homePaths(home);
    child = startGateway(home);
    await waitFor(() => existsSync(paths.pidFile));
    expect(Number(readFileSync(paths.pidFile, "utf8"))).toBe(child.pid);
    await waitFor(() => {
      const db = openCoreDatabase(paths.db);
      const beat = getSetting(db, HEARTBEAT_KEY);
      db.close();
      return beat !== undefined;
    });

    // Startup seeds the default agents and mirrors them into the DB.
    expect(existsSync(join(home, "agents", "boss", "agent.yaml"))).toBe(true);
    const db = openCoreDatabase(paths.db);
    expect(listAgents(db).map((a) => a.id)).toEqual(["boss", "web-dev"]);
    db.close();

    const exited = exitCode(child);
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it("handles SIGTERM gracefully as soon as the pidfile exists", async () => {
    // Regression: the pidfile used to be written before the signal handlers were installed.
    for (let i = 0; i < 5; i++) {
      home = mkdtempSync(join(tmpdir(), "achords-gw-"));
      const paths = homePaths(home);
      child = startGateway(home);
      const until = Date.now() + 5000;
      while (!existsSync(paths.pidFile) && Date.now() < until) {
        await new Promise((r) => setImmediate(r));
      }
      const exited = exitCode(child);
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
      expect(existsSync(paths.pidFile)).toBe(false);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("drops open keep-alive connections on shutdown instead of serving without a database", async () => {
    // Regression: a browser polling over keep-alive kept the old gateway alive for minutes
    // after an update, every request failing with "database is not open".
    home = mkdtempSync(join(tmpdir(), "achords-gw-"));
    child = startGateway(home);
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    let port = 0;
    await waitFor(() => {
      port = Number(/127\.0\.0\.1:(\d+)/.exec(out)?.[1] ?? 0);
      return port > 0;
    });
    const agent = new Agent({ keepAlive: true });
    const statuses: number[] = [];
    let polling = true;
    const poll = async () => {
      while (polling) {
        await new Promise<void>((resolve) => {
          // A session cookie makes the request read the database (a dead session is a 401).
          const headers = { cookie: `achords_session_${port}=dead` };
          get({ port, path: "/api/threads", agent, headers }, (res) => {
            statuses.push(res.statusCode ?? 0);
            res.resume().on("end", resolve);
          }).on("error", () => resolve());
        });
      }
    };
    // Like a browser's parallel polls: some request is always in flight when the server closes.
    const polled = Promise.all([poll(), poll(), poll(), poll()]);
    await waitFor(() => statuses.length > 0);
    const exited = exitCode(child);
    child.kill("SIGTERM");
    const code = await Promise.race([
      exited,
      new Promise((r) => setTimeout(() => r("hung"), 3000)),
    ]);
    polling = false;
    await polled;
    agent.destroy();
    expect(code).toBe(0);
    expect(statuses).not.toContain(500);
  }, 15_000);

  it("exits on its own when the STOP marker appears", async () => {
    home = mkdtempSync(join(tmpdir(), "achords-gw-"));
    const paths = homePaths(home);
    child = startGateway(home);
    await waitFor(() => existsSync(paths.pidFile));
    const exited = exitCode(child);
    writeFileSync(paths.stopFile, "test");
    expect(await exited).toBe(0);
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it("refuses to start while the STOP marker exists (exit 0, so launchd does not respawn)", async () => {
    home = mkdtempSync(join(tmpdir(), "achords-gw-"));
    const paths = homePaths(home);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.stopFile, "test");
    child = startGateway(home);
    expect(await exitCode(child)).toBe(0);
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it("refuses to run a second instance", async () => {
    home = mkdtempSync(join(tmpdir(), "achords-gw-"));
    const paths = homePaths(home);
    child = startGateway(home);
    await waitFor(() => existsSync(paths.pidFile));
    const second = startGateway(home);
    expect(await exitCode(second)).toBe(0);
    expect(Number(readFileSync(paths.pidFile, "utf8"))).toBe(child.pid);
  });
});
