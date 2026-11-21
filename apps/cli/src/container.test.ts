import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageTag, runContainerPrefix } from "@achords/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildImage, type ContainerRun, killRunContainers } from "./container.ts";

describe("achords container (ADR-0051)", () => {
  let dir: string;
  let calls: string[][];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "achords-cli-box-"));
    writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
    calls = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fake =
    (ls: { id: string }[]): ContainerRun =>
    (args) => {
      calls.push(args);
      if (args[0] === "ls") return JSON.stringify(ls.map((c) => ({ configuration: c })));
      if (args[0] === "image" && args[1] === "ls") {
        return JSON.stringify([
          { configuration: { name: "docker.io/library/achords-agent:old" } },
          { configuration: { name: `docker.io/library/${imageTag("FROM scratch\n")}` } },
        ]);
      }
      return "";
    };

  it("builds the image tagged by its Dockerfile and removes older ones", () => {
    const image = buildImage(dir, fake([]));
    expect(image).toBe(imageTag("FROM scratch\n"));
    expect(calls).toContainEqual(["build", "-t", image, "-f", join(dir, "Dockerfile"), dir]);
    expect(calls).toContainEqual(["builder", "stop"]);
    expect(calls).toContainEqual(["image", "rm", "achords-agent:old"]);
    expect(calls).not.toContainEqual(["image", "rm", image]);
  });

  it("leaves a builder running that was running before", () => {
    buildImage(dir, fake([{ id: "buildkit" }]));
    expect(calls).not.toContainEqual(["builder", "stop"]);
  });

  it("kill stops only this install's run containers", () => {
    const mine = `${runContainerPrefix("/home/a")}1`;
    const other = `${runContainerPrefix("/home/b")}2`;
    expect(killRunContainers("/home/a", fake([{ id: mine }, { id: other }]))).toEqual([mine]);
    expect(calls.filter((c) => c[0] === "kill")).toEqual([["kill", mine]]);
  });
});
