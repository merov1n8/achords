import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LAUNCHER = new URL("./launch.ts", import.meta.url).pathname;

describe("integration launcher (ADR-0034)", () => {
  let hub: Server;
  let url: string;
  let auths: (string | undefined)[];

  beforeEach(async () => {
    auths = [];
    hub = createServer((req, res) => {
      auths.push(req.headers.authorization);
      if (req.headers.authorization !== "Bearer good") {
        res.statusCode = 401;
        return res.end("{}");
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          command: process.execPath,
          args: [
            "-e",
            "process.stdout.write([process.env.WP_PASSWORD, process.env.ACHORDS_MCP_TICKET ?? 'no-ticket'].join('|')); process.exit(3)",
          ],
          env: { WP_PASSWORD: "s3cret" },
        }),
      );
    });
    await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((r) => hub.close(r));
  });

  const launch = (ticket: string) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      execFile(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", LAUNCHER],
        { env: { ...process.env, ACHORDS_HUB_URL: url, ACHORDS_MCP_TICKET: ticket } },
        (error, out, err) => resolve({ code: error ? (error.code as number) : 0, out, err }),
      );
    });

  it("runs the server with the fetched environment, without the ticket, and keeps its exit code", async () => {
    const r = await launch("good");
    expect(auths).toEqual(["Bearer good"]);
    expect(r.out).toBe("s3cret|no-ticket");
    expect(r.code).toBe(3);
  });

  it("exits without starting anything when the ticket is refused", async () => {
    const r = await launch("used");
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/integration launch refused \(401\)/);
  });
});
