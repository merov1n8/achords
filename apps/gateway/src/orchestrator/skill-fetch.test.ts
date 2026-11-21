import { createServer, request as httpRequest, type RequestOptions, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fetchSkillSource,
  htmlToText,
  isPrivateAddress,
  SKILL_FETCH_LIMIT,
  safeLookup,
  skillUrl,
} from "./skill-fetch.ts";

describe("skill fetch (ADR-0049)", () => {
  let server: Server;
  let port: number;
  // Stands in for https: every request to any host lands on the local test server.
  const request = (u: URL, o: RequestOptions) =>
    httpRequest({ ...o, host: "127.0.0.1", port, path: `${u.pathname}${u.search}` });

  beforeAll(async () => {
    server = createServer((req, res) => {
      const routes: Record<string, () => void> = {
        "/skill.md": () => {
          res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
          res.end("---\nname: x\n---\nBody\n");
        },
        "/page": () => {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(
            "<html><head><title>t</title></head><body><h1>Hi</h1><script>evil()</script><p>a &amp; b</p></body></html>",
          );
        },
        "/hop": () => {
          res.writeHead(302, { location: "https://skills.example/skill.md" });
          res.end();
        },
        "/to-loopback": () => {
          res.writeHead(302, { location: "https://127.0.0.1/skill.md" });
          res.end();
        },
        "/to-http": () => {
          res.writeHead(301, { location: "http://skills.example/skill.md" });
          res.end();
        },
        "/loop": () => {
          res.writeHead(302, { location: "/loop" });
          res.end();
        },
        "/big": () => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("x".repeat(SKILL_FETCH_LIMIT + 1));
        },
        "/image": () => {
          res.writeHead(200, { "content-type": "image/png" });
          res.end("png");
        },
        "/slow": () => {
          setTimeout(() => res.end("late"), 2000);
        },
      };
      const route = routes[req.url ?? ""];
      if (route) route();
      else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it("accepts only https links to public hosts, and turns GitHub file pages into raw files", () => {
    expect(() => skillUrl("http://example.com/x")).toThrow(/only https/);
    expect(() => skillUrl("https://user:pw@example.com/x")).toThrow(/login/);
    for (const host of [
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "[::1]",
      "169.254.169.254",
      "a.localhost",
    ]) {
      expect(() => skillUrl(`https://${host}/x`)).toThrow(/not a public address/);
    }
    expect(skillUrl("https://github.com/o/r/blob/main/skills/a/SKILL.md#top").href).toBe(
      "https://raw.githubusercontent.com/o/r/main/skills/a/SKILL.md",
    );
  });

  it("knows private and public addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "172.20.1.1",
      "192.168.1.1",
      "100.100.1.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "0.0.0.0",
      "nonsense",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "2606:4700::1111"])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses names that resolve to private addresses", async () => {
    const err = await new Promise<Error | null>((resolve) =>
      safeLookup("localhost", {}, (e) => resolve(e)),
    );
    expect(err?.message).toMatch(/not a public address/);
  });

  it("returns markdown as is and pages as plain text", async () => {
    await expect(fetchSkillSource("https://skills.example/skill.md", { request })).resolves.toEqual(
      {
        url: "https://skills.example/skill.md",
        text: "---\nname: x\n---\nBody",
      },
    );
    const page = await fetchSkillSource("https://skills.example/page", { request });
    expect(page.text).toBe("# Hi\na & b");
  });

  it("follows redirects, checking every hop", async () => {
    await expect(
      fetchSkillSource("https://skills.example/hop", { request }),
    ).resolves.toMatchObject({
      url: "https://skills.example/skill.md",
    });
    await expect(
      fetchSkillSource("https://skills.example/to-loopback", { request }),
    ).rejects.toThrow(/not a public address/);
    await expect(fetchSkillSource("https://skills.example/to-http", { request })).rejects.toThrow(
      /only https/,
    );
    await expect(fetchSkillSource("https://skills.example/loop", { request })).rejects.toThrow(
      /too many redirects/,
    );
  });

  it("enforces size, type and time limits", async () => {
    await expect(fetchSkillSource("https://skills.example/big", { request })).rejects.toThrow(
      /larger than 200 KB/,
    );
    await expect(fetchSkillSource("https://skills.example/image", { request })).rejects.toThrow(
      /not a text page/,
    );
    await expect(fetchSkillSource("https://skills.example/nope", { request })).rejects.toThrow(
      /HTTP 404/,
    );
    await expect(
      fetchSkillSource("https://skills.example/slow", { request, timeoutMs: 100 }),
    ).rejects.toThrow(/too long/);
  });

  it("strips markup and decodes entities", () => {
    expect(htmlToText("<ul><li>one</li><li>two &#38; &#x41;</li></ul><style>x{}</style>")).toBe(
      "- one\n- two & A",
    );
  });
});
