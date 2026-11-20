import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LAUNCHER = new URL("./launch.ts", import.meta.url).pathname;

describe("integration launcher (ADR-0034)", () => {
  let hub: Server;
  let url: string;
  let auths: (string | undefined)[];
  let scoped: object | undefined;

  beforeEach(async () => {
    auths = [];
    scoped = undefined;
    hub = createServer((req, res) => {
      auths.push(req.headers.authorization);
      if (req.headers.authorization !== "Bearer good") {
        res.statusCode = 401;
        return res.end("{}");
      }
      res.setHeader("content-type", "application/json");
      if (scoped) {
        res.end(JSON.stringify(scoped));
        return;
      }
      res.end(
        JSON.stringify({
          command: process.execPath,
          args: [
            "-e",
            "const f = process.env.CREDS; process.stdout.write([process.env.WP_PASSWORD, process.env.ACHORDS_MCP_TICKET ?? 'no-ticket', require('fs').readFileSync(f, 'utf8'), (require('fs').statSync(f).mode & 0o777).toString(8), f].join('|')); process.exit(3)",
          ],
          env: { WP_PASSWORD: "s3cret" },
          files: { CREDS: { refresh_token: "r3fresh" } },
        }),
      );
    });
    await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((r) => hub.close(r));
  });

  const launch = (ticket: string, input?: string) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", LAUNCHER],
        { env: { ...process.env, ACHORDS_HUB_URL: url, ACHORDS_MCP_TICKET: ticket } },
        (error, out, err) => resolve({ code: error ? (error.code as number) : 0, out, err }),
      );
      if (input !== undefined) child.stdin?.end(input);
    });

  it("runs the server with the fetched environment, without the ticket, and keeps its exit code", async () => {
    const r = await launch("good");
    expect(auths).toEqual(["Bearer good"]);
    const [password, ticket, file, mode, path] = r.out.split("|");
    expect([password, ticket]).toEqual(["s3cret", "no-ticket"]);
    // Credentials file: private, and gone once the server has exited.
    expect(JSON.parse(file ?? "")).toEqual({ refresh_token: "r3fresh" });
    expect(mode).toBe("600");
    expect(existsSync(path ?? "")).toBe(false);
    expect(r.code).toBe(3);
  });

  it("exits without starting anything when the ticket is refused", async () => {
    const r = await launch("used");
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/integration launch refused \(401\)/);
  });

  it("passes only calls inside the project scope to the server (ADR-0036)", async () => {
    // The fake server answers every line it receives with "saw <id>".
    scoped = {
      command: process.execPath,
      args: [
        "-e",
        "require('readline').createInterface({input: process.stdin}).on('line', (l) => console.log(JSON.stringify({ saw: JSON.parse(l).id })))",
      ],
      env: {},
      files: {},
      scope: { args: ["property_id"], free: [], strip: "properties/", allowed: ["111"] },
    };
    const call = (id: number, name: string, args: object) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      });
    const r = await launch(
      "good",
      [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        call(2, "run_report", { property_id: "properties/111" }),
        call(3, "run_report", { property_id: "222" }),
        call(4, "get_account_summaries", {}),
        JSON.stringify([{ jsonrpc: "2.0", id: 5, method: "tools/call" }]),
        "",
      ].join("\n"),
    );
    const lines = r.out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.filter((l) => "saw" in l).map((l) => l.saw)).toEqual([1, 2]);
    const refused = lines.filter((l) => l.result?.isError);
    expect(refused.map((l) => l.id)).toEqual([3, 4]);
    expect(refused[0].result.content[0].text).toMatch(/222 is not part of this project/);
    expect(lines.some((l) => l.error?.message === "batches are not accepted")).toBe(true);
  });
});
