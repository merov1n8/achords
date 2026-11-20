import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreDatabase } from "@achords/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiHandler } from "./api.ts";

/** Raw request so paths like /../x are sent as-is (fetch would normalise them). */
function raw(base: string, path: string, host?: string) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const u = new URL(base);
      const r = request(
        { host: u.hostname, port: u.port, path, headers: host ? { host } : {} },
        (res) => {
          let body = "";
          res.on("data", (c) => {
            body += c;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      r.on("error", reject);
      r.end();
    },
  );
}

describe("static web UI", () => {
  let root: string;
  let dist: string;
  let server: Server;
  let base: string;

  const start = async (staticDir: string) => {
    server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    server.on(
      "request",
      createApiHandler({
        db: openCoreDatabase(":memory:"),
        orchestrator: {
          handleMessage: async () => "answer",
          delegate: () => ({ ok: false, reason: "n/a" }),
          askOwner: () => ({ ok: false, reason: "n/a" }),
          spawnWorker: () => ({ ok: false, reason: "n/a" }),
          proposeAgent: () => ({ ok: false, reason: "n/a" }),
          decideProposal: () => ({ ok: false, reason: "n/a" }),
          moveTask: () => ({ ok: false, reason: "n/a" }),
          ownerMove: () => ({ ok: false, reason: "n/a" }),
          runAction: () => ({ ok: false, message: "n/a" }),
          workflow: () => {
            throw new Error("n/a");
          },
          syncAgents: () => [],
        },
        allowedHosts: [`127.0.0.1:${port}`],
        staticDir,
      }),
    );
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "achords-static-"));
    dist = join(root, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>achords</title>");
    writeFileSync(join(dist, "assets", "app-abc123.js"), "console.log(1)");
    writeFileSync(join(root, "secret.txt"), "outside");
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  });

  it("serves index.html with a strict CSP and no caching", async () => {
    await start(dist);
    const res = await raw(base, "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("<title>achords</title>");
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["cache-control"]).toBe("no-cache");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
  });

  it("serves hashed assets as immutable with the right type", async () => {
    await start(dist);
    const res = await raw(base, "/assets/app-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.headers["cache-control"]).toMatch(/immutable/);
  });

  it("never serves files outside the dist folder", async () => {
    await start(dist);
    for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
      const res = await raw(base, path);
      expect(res.body).not.toContain("outside");
    }
  });

  it("falls back to index.html for app routes, 404 for missing assets", async () => {
    await start(dist);
    expect((await raw(base, "/kanban")).body).toContain("<title>achords</title>");
    expect((await raw(base, "/assets/missing.js")).status).toBe(404);
  });

  it("applies the Host check to static files too", async () => {
    await start(dist);
    expect((await raw(base, "/", "evil.example")).status).toBe(421);
  });

  it("explains when the UI has not been built", async () => {
    await start(join(root, "nope"));
    const res = await raw(base, "/");
    expect(res.status).toBe(404);
    expect(res.body).toMatch(/pnpm build/);
  });
});
