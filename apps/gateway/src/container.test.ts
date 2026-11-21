import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContainerPrefix } from "@achords/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { containerHost, type Exec } from "./container.ts";

const freePort = () =>
  new Promise<number>((done) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });

describe("container host (ADR-0051)", () => {
  let dir: string;
  let calls: string[][];
  let images: Set<string>;
  let subnet: string;
  let buildCode: number;
  let prebuilt: boolean;
  let hosts: string[];
  let host: ReturnType<typeof containerHost> | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "achords-container-"));
    writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
    calls = [];
    images = new Set();
    // Loopback stands in for the container network's host address.
    subnet = "127.0.0.0/8";
    buildCode = 0;
    prebuilt = false;
    hosts = [];
  });
  afterEach(() => {
    host?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const exec: Exec = async (_bin, args) => {
    calls.push(args);
    const [cmd, sub] = args;
    if (cmd === "image" && sub === "inspect")
      return { code: prebuilt || images.has(args[2] ?? "") ? 0 : 1, out: "" };
    if (cmd === "build") {
      if (buildCode === 0) images.add(args[2] ?? "");
      return { code: buildCode, out: buildCode ? "step 3 failed" : "" };
    }
    if (cmd === "network") {
      return {
        code: 0,
        out: JSON.stringify([{ status: { ipv4Gateway: "127.0.0.1", ipv4Subnet: subnet } }]),
      };
    }
    if (cmd === "image" && sub === "ls") {
      return {
        code: 0,
        out: JSON.stringify([{ configuration: { name: "docker.io/library/achords-agent:old" } }]),
      };
    }
    if (cmd === "ls") {
      return {
        code: 0,
        out: JSON.stringify([
          { configuration: { id: `${runContainerPrefix(dir)}x` } },
          { configuration: { id: "other" } },
        ]),
      };
    }
    return { code: 0, out: "" };
  };

  const make = (
    port: number,
    handler = (_: unknown, res: { end: (s: string) => void }) => res.end("api"),
  ) =>
    containerHost({
      home: dir,
      dockerfileDir: dir,
      api: () => ({ port, handler: handler as never }),
      allowHost: (h) => hosts.push(h),
      log: () => {},
      bin: () => "/fake/container",
      exec,
      retryMs: 10,
    });

  const waitFor = async (check: () => boolean) => {
    const until = Date.now() + 3000;
    while (!check()) {
      if (Date.now() > until) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it("builds the image on first need while the run waits, then serves only the agent API", async () => {
    const port = await freePort();
    host = make(port);
    expect(await host.prepare()).toMatchObject({ ready: false, reason: /container image/ });
    await waitFor(() => images.size === 1);
    const build = calls.find((c) => c[0] === "build");
    expect(build?.slice(0, 3)).toEqual(["build", "-t", [...images][0]]);
    // Old images go, the builder VM is stopped when it was not running before.
    await waitFor(() => calls.some((c) => c[0] === "image" && c[1] === "rm"));
    expect(calls).toContainEqual(["image", "rm", "achords-agent:old"]);
    expect(calls).toContainEqual(["builder", "stop"]);

    const ready = await host.prepare();
    expect(ready).toEqual({
      ready: true,
      bin: "/fake/container",
      image: [...images][0],
      hubUrl: `http://127.0.0.1:${port}`,
    });
    await waitFor(() => hosts.length === 1);
    expect(hosts).toEqual([`127.0.0.1:${port}`]);
    expect(await (await fetch(`http://127.0.0.1:${port}/api/agent/ask_owner`)).text()).toBe("api");
    expect((await fetch(`http://127.0.0.1:${port}/api/threads`)).status).toBe(404);
  });

  it("drops connections from outside the container network", async () => {
    prebuilt = true;
    subnet = "10.0.0.0/8";
    const port = await freePort();
    host = make(port);
    expect(await host.prepare()).toMatchObject({ ready: true });
    expect(calls.some((c) => c[0] === "build")).toBe(false);
    await waitFor(() => hosts.length === 1);
    await expect(fetch(`http://127.0.0.1:${port}/api/agent/ask_owner`)).rejects.toThrow();
  });

  it("reports a failed build once, then tries again", async () => {
    buildCode = 1;
    host = make(await freePort());
    await host.prepare();
    await waitFor(() => calls.some((c) => c[0] === "build"));
    await new Promise((r) => setTimeout(r, 20));
    await expect(host.prepare()).rejects.toThrow(/could not be built: step 3 failed/);
    expect(await host.prepare()).toMatchObject({ ready: false });
  });

  it("refuses plainly without the tool or its service", async () => {
    host = containerHost({
      home: dir,
      dockerfileDir: dir,
      api: () => undefined,
      allowHost: () => {},
      log: () => {},
      bin: () => undefined,
    });
    await expect(host.prepare()).rejects.toThrow(/brew install container/);
    host = containerHost({
      home: dir,
      dockerfileDir: dir,
      api: () => undefined,
      allowHost: () => {},
      log: () => {},
      bin: () => "/fake/container",
      exec: async () => ({ code: 1, out: "" }),
    });
    await expect(host.prepare()).rejects.toThrow(/brew services start container/);
  });

  it("stops run containers a previous gateway left behind", async () => {
    host = make(await freePort());
    const mine = `${runContainerPrefix(dir)}x`;
    expect(await host.cleanup()).toEqual([mine]);
    expect(calls).toContainEqual(["kill", mine]);
    expect(calls).not.toContainEqual(["kill", "other"]);
  });
});
