// `achords container build` and the container step of `achords kill` (ADR-0051).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findContainerBin,
  imageTag,
  runContainerNames,
  runContainerPrefix,
  staleImages,
} from "@achords/platform";

/** Runs the `container` tool; returns stdout, throws on a non-zero exit. */
export type ContainerRun = (args: string[], opts?: { show?: boolean }) => string;

export const containerRun =
  (bin: string): ContainerRun =>
  (args, opts) =>
    execFileSync(bin, args, {
      encoding: "utf8",
      timeout: opts?.show ? undefined : 30_000,
      stdio: opts?.show ? "inherit" : ["ignore", "pipe", "pipe"],
    }) ?? "";

/** Builds the agent image now (what the gateway does on first need); old images are removed. */
export function buildImage(dockerfileDir: string, run?: ContainerRun): string {
  const exec = run ?? defaultRun();
  const image = imageTag(readFileSync(join(dockerfileDir, "Dockerfile"), "utf8"));
  const builderRan = runContainerNames(exec(["ls", "--format", "json"]), "buildkit").length > 0;
  exec(["build", "-t", image, "-f", join(dockerfileDir, "Dockerfile"), dockerfileDir], {
    show: true,
  });
  // The builder is a VM of its own (2 GB); leave it as found.
  if (!builderRan) exec(["builder", "stop"]);
  for (const old of staleImages(exec(["image", "ls", "--format", "json"]), image)) {
    exec(["image", "rm", old]);
  }
  return image;
}

/** Emergency stop: kills this install's run containers (signals to their clients do not). */
export function killRunContainers(home: string, run?: ContainerRun): string[] {
  const bin = run ? "" : findContainerBin();
  if (!run && !bin) return [];
  const exec = run ?? containerRun(bin as string);
  const names = runContainerNames(exec(["ls", "--format", "json"]), runContainerPrefix(home));
  for (const name of names) exec(["kill", name]);
  return names;
}

function defaultRun(): ContainerRun {
  const bin = findContainerBin();
  if (!bin) {
    throw new Error(
      "the container tool is not installed (brew install container, then brew services start container)",
    );
  }
  return containerRun(bin);
}
