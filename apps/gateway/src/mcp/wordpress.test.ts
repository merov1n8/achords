import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SERVER = new URL("./wordpress.ts", import.meta.url).pathname;

describe("builtin WordPress MCP server", () => {
  let site: Server;
  let url: string;
  let seen: { method: string; path: string; headers: IncomingHttpHeaders; body: string }[];
  let children: ChildProcess[];

  beforeEach(async () => {
    seen = [];
    children = [];
    site = createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
      res.setHeader("content-type", "application/json");
      const post = (id: number, status: string) => ({
        id,
        type: "post",
        status,
        title: { rendered: `Post ${id}` },
        content: { rendered: "<p>Hello</p>" },
        excerpt: { rendered: "<p>Hi</p>" },
        link: `${url}/?p=${id}`,
        date: "2026-11-20T10:00:00",
        modified: "2026-11-20T10:00:00",
      });
      if (req.url?.startsWith("/wp-json/wp/v2/posts?"))
        return res.end(JSON.stringify([post(1, "publish")]));
      if (req.url === "/wp-json/wp/v2/posts/1") return res.end(JSON.stringify(post(1, "publish")));
      if (req.url === "/wp-json/wp/v2/posts/2") {
        res.statusCode = 404;
        return res.end(
          JSON.stringify({ code: "rest_post_invalid_id", message: "Invalid post ID." }),
        );
      }
      if (req.url === "/wp-json/wp/v2/posts" && req.method === "POST") {
        res.statusCode = 201;
        return res.end(JSON.stringify(post(7, JSON.parse(body).status)));
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    for (const c of children) c.kill();
    await new Promise((r) => site.close(r));
  });

  const start = (wpUrl: string) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", SERVER], {
      env: { ...process.env, WP_URL: wpUrl, WP_USER: "editor", WP_APP_PASSWORD: "abcd efgh" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    children.push(child);
    const waiters = new Map<number, (r: Record<string, unknown>) => void>();
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      const msg = JSON.parse(line);
      waiters.get(msg.id)?.(msg);
    });
    let next = 1;
    const rpc = (method: string, params: unknown = {}) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = next++;
        waiters.set(id, resolve);
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    const tool = async (name: string, args: unknown) =>
      (await rpc("tools/call", { name, arguments: args })).result as {
        content: { text: string }[];
        isError?: boolean;
      };
    return { rpc, tool };
  };
  const init = {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  };

  it("lists, reads and creates drafts with the application password", async () => {
    const { rpc, tool } = start(url);
    await rpc("initialize", init);
    const tools = ((await rpc("tools/list")).result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_draft",
      "get_post",
      "list_posts",
      "site_info",
    ]);

    const list = await tool("list_posts", { type: "posts", search: "hello" });
    expect(JSON.parse(list.content[0]?.text ?? "")).toEqual([
      expect.objectContaining({ id: 1, title: "Post 1", status: "publish" }),
    ]);
    expect(seen[0]?.path).toMatch(/search=hello/);
    expect(seen[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from("editor:abcd efgh").toString("base64")}`,
    );

    const one = JSON.parse(
      (await tool("get_post", { type: "posts", id: 1 })).content[0]?.text ?? "",
    );
    expect(one).toMatchObject({ id: 1, content: "<p>Hello</p>", excerpt: "<p>Hi</p>" });

    const missing = await tool("get_post", { type: "posts", id: 2 });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toBe("WordPress 404: Invalid post ID.");
  });

  it("always creates drafts, whatever the caller asks", async () => {
    const { rpc, tool } = start(url);
    await rpc("initialize", init);
    const r = await tool("create_draft", {
      type: "posts",
      title: "New",
      content: "<p>x</p>",
      status: "publish",
    });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(seen.at(-1)?.body ?? "")).toEqual({
      title: "New",
      content: "<p>x</p>",
      status: "draft",
    });
    expect(JSON.parse(r.content[0]?.text ?? "")).toMatchObject({ id: 7, status: "draft" });
  });

  it("refuses plain http for a remote site", async () => {
    const { rpc, tool } = start("http://example.com");
    await rpc("initialize", init);
    const r = await tool("site_info", {});
    expect(r).toMatchObject({ isError: true, content: [{ text: "WP_URL must be https" }] });
  });
});
