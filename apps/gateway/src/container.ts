// Agent runs in Apple containers (ADR-0051), the gateway's side: the image (built on first need,
// cached by the Dockerfile's hash) and a second listener for the hub on the container network.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { join } from "node:path";
import {
  findContainerBin,
  imageTag,
  inSubnet,
  parseNetwork,
  runContainerNames,
  runContainerPrefix,
  staleImages,
} from "@achords/platform";

export type Exec = (
  bin: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number; out: string }>;

export type Prepared =
  | { ready: true; bin: string; image: string; hubUrl: string }
  | { ready: false; reason: string };

export interface ContainerHostDeps {
  /** ACHORDS_HOME: names this install's run containers. */
  home: string;
  /** Folder with the Dockerfile (seed/container). */
  dockerfileDir: string;
  /** The API's port and request handler, once it listens. */
  api: () => { port: number; handler: RequestListener } | undefined;
  /** Adds the container listener's address to the Host allow-list. */
  allowHost: (host: string) => void;
  log: (msg: string) => void;
  bin?: () => string | undefined;
  exec?: Exec;
  retryMs?: number;
}

const BUILD_TIMEOUT_MS = 30 * 60_000;
const CMD_TIMEOUT_MS = 30_000;
// The network's host address exists only while a VM runs; the run that needs it brings it up.
const BIND_FOR_MS = 2 * 60_000;

const execDefault: Exec = (bin, args, timeoutMs) =>
  new Promise((done) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) =>
        done({
          code: err ? Number((err as { code?: number }).code ?? 1) || 1 : 0,
          out: `${stdout}${stderr}`,
        }),
    );
  });

export function containerHost(deps: ContainerHostDeps) {
  const exec = deps.exec ?? execDefault;
  const findBin = deps.bin ?? (() => findContainerBin());
  const retryMs = deps.retryMs ?? 100;
  let building: Promise<void> | undefined;
  let buildError: string | undefined;
  const built = new Set<string>();
  let server: Server | undefined;
  let boundTo: string | undefined;
  let binding = false;
  let closed = false;

  /** Builds `image` from the Dockerfile; old achords images are removed afterwards. */
  const build = async (bin: string, image: string): Promise<void> => {
    const builderRan =
      runContainerNames(
        (await exec(bin, ["ls", "--format", "json"], CMD_TIMEOUT_MS)).out,
        "buildkit",
      ).length > 0;
    deps.log(`container: building image ${image}`);
    const res = await exec(
      bin,
      ["build", "-t", image, "-f", join(deps.dockerfileDir, "Dockerfile"), deps.dockerfileDir],
      BUILD_TIMEOUT_MS,
    );
    if (res.code !== 0) throw new Error(res.out.trim().slice(-600) || `exit ${res.code}`);
    built.add(image);
    // The builder is a VM of its own (2 GB); leave it as found.
    if (!builderRan) await exec(bin, ["builder", "stop"], CMD_TIMEOUT_MS);
    const images = await exec(bin, ["image", "ls", "--format", "json"], CMD_TIMEOUT_MS);
    for (const old of staleImages(images.out, image)) {
      await exec(bin, ["image", "rm", old], CMD_TIMEOUT_MS);
    }
    deps.log(`container: image ${image} ready`);
  };

  /** Only agent runs on the container network, only the agent API (token-checked as always). */
  const guarded =
    (subnet: string): RequestListener =>
    (req, res) => {
      if (!inSubnet(req.socket.remoteAddress ?? "", subnet)) {
        req.socket.destroy();
        return;
      }
      const api = deps.api();
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (!api || !path.startsWith("/api/agent/")) {
        res.writeHead(404).end();
        return;
      }
      api.handler(req, res);
    };

  const listen = (net: { gateway: string; subnet: string }, port: number) => {
    if (boundTo === net.gateway || binding) return;
    server?.close();
    server = undefined;
    boundTo = undefined;
    binding = true;
    const until = Date.now() + BIND_FOR_MS;
    const attempt = () => {
      if (closed) {
        binding = false;
        return;
      }
      const s = createServer(guarded(net.subnet));
      s.once("error", (err) => {
        s.close();
        if (Date.now() < until) setTimeout(attempt, retryMs).unref();
        else {
          binding = false;
          deps.log(`container: no listener on ${net.gateway}: ${(err as Error).message}`);
        }
      });
      // Never 0.0.0.0: this address exists only on the host's side of the container network.
      s.listen(port, net.gateway, () => {
        binding = false;
        server = s;
        boundTo = net.gateway;
        deps.allowHost(`${net.gateway}:${port}`);
        deps.log(`container: hub for agent runs on ${net.gateway}:${port}`);
      });
    };
    attempt();
  };

  return {
    /**
     * Everything a container run needs, or why it must wait. Throws a plain reason when the
     * container tool is missing or stopped (the run fails; the owner has to act).
     */
    async prepare(): Promise<Prepared> {
      const bin = findBin();
      if (!bin) {
        throw new Error(
          "this agent runs in an Apple container, but the container tool is not installed (brew install container, then brew services start container)",
        );
      }
      if ((await exec(bin, ["system", "status"], CMD_TIMEOUT_MS)).code !== 0) {
        throw new Error(
          "this agent runs in an Apple container, but the container service is not running (brew services start container)",
        );
      }
      const image = imageTag(readFileSync(join(deps.dockerfileDir, "Dockerfile"), "utf8"));
      if (buildError !== undefined) {
        const reason = buildError;
        buildError = undefined; // the next run tries again
        throw new Error(`the container image could not be built: ${reason}`);
      }
      const waiting = {
        ready: false as const,
        reason: "preparing the container image (first run or after an update, a few minutes)",
      };
      if (building) return waiting;
      if (!built.has(image)) {
        if ((await exec(bin, ["image", "inspect", image], CMD_TIMEOUT_MS)).code === 0) {
          built.add(image);
        } else {
          building = build(bin, image)
            .catch((err: Error) => {
              buildError = err.message;
              deps.log(`container: image build failed: ${err.message}`);
            })
            .finally(() => {
              building = undefined;
            });
          return waiting;
        }
      }
      const api = deps.api();
      if (!api) return { ready: false, reason: "the gateway is still starting" };
      const net = parseNetwork(
        (await exec(bin, ["network", "inspect", "default"], CMD_TIMEOUT_MS)).out,
      );
      if (!net) throw new Error("the container network has no address (container network ls)");
      listen(net, api.port);
      return { ready: true, bin, image, hubUrl: `http://${net.gateway}:${api.port}` };
    },
    /** Containers of runs a previous gateway left behind (it crashed or was killed). */
    async cleanup(): Promise<string[]> {
      const bin = findBin();
      if (!bin) return [];
      const names = runContainerNames(
        (await exec(bin, ["ls", "--format", "json"], CMD_TIMEOUT_MS)).out,
        runContainerPrefix(deps.home),
      );
      for (const name of names) await exec(bin, ["kill", name], CMD_TIMEOUT_MS);
      return names;
    },
    close(): void {
      closed = true;
      server?.close();
    },
  };
}
