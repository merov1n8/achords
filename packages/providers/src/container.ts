// Runs a CLI command inside an Apple container (ADR-0051). Secrets never appear on argv: `-e NAME`
// makes `container run` copy the value from its own environment into the VM.
import { execFile } from "node:child_process";
import type { ContainerSpec } from "./types.ts";

export const CONTAINER_CPUS = 4;
export const CONTAINER_MEMORY = "4G";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `container run …` argv around `command`, which runs unchanged in `cwd` inside the VM. */
export function containerRunArgs(
  spec: ContainerSpec,
  cwd: string,
  envNames: string[],
  command: string[],
): string[] {
  const mounts = spec.mounts.flatMap((m) => {
    // The --mount syntax is comma-separated; a comma in a path would change its meaning.
    if (m.path.includes(",") || !m.path.startsWith("/")) {
      throw new Error(`container runs cannot share the folder ${m.path}`);
    }
    return [
      "--mount",
      `type=bind,source=${m.path},target=${m.path}${m.readonly ? ",readonly" : ""}`,
    ];
  });
  const env = envNames.flatMap((n) => {
    if (!ENV_NAME.test(n)) throw new Error(`invalid environment name ${n}`);
    return ["-e", n];
  });
  return [
    "run",
    "--rm",
    // stdin carries the prompt; --init forwards signals and reaps the CLI's tool processes.
    "-i",
    "--init",
    "--progress",
    "none",
    "--name",
    spec.name,
    "--cpus",
    String(spec.cpus ?? CONTAINER_CPUS),
    "--memory",
    spec.memory ?? CONTAINER_MEMORY,
    ...mounts,
    ...env,
    "-w",
    cwd,
    spec.image,
    ...command,
  ];
}

/**
 * Stops the VM. Signals to the `container run` client do not reach it, so timeout, cancel and
 * `achords kill` must name the container.
 */
export function stopContainer(spec: Pick<ContainerSpec, "bin" | "name">): void {
  execFile(spec.bin, ["kill", spec.name], { timeout: 15_000 }, () => {
    // already gone
  });
}
