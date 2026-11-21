import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findContainerBin,
  imageTag,
  inSubnet,
  parseNetwork,
  runContainerNames,
  runContainerPrefix,
  staleImages,
} from "./container.ts";

describe("container helpers (ADR-0051)", () => {
  it("finds the binary on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "achords-cbin-"));
    try {
      writeFileSync(join(dir, "container"), "#!/bin/sh\n");
      chmodSync(join(dir, "container"), 0o755);
      expect(findContainerBin(`/nope:${dir}`)).toBe(join(dir, "container"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tags the image by the Dockerfile's content", () => {
    expect(imageTag("FROM a")).toMatch(/^achords-agent:[0-9a-f]{12}$/);
    expect(imageTag("FROM a")).toBe(imageTag("FROM a"));
    expect(imageTag("FROM a")).not.toBe(imageTag("FROM b"));
  });

  it("lists only this install's run containers and stale achords images", () => {
    const mine = runContainerPrefix("/Users/a/.achords");
    const other = runContainerPrefix("/tmp/dev-home");
    expect(mine).toMatch(/^achords-run-[0-9a-f]{8}-$/);
    expect(mine).not.toBe(other);
    const ls = JSON.stringify([
      { configuration: { id: `${mine}1` } },
      { configuration: { id: `${other}2` } },
      { configuration: { id: "buildkit" } },
    ]);
    expect(runContainerNames(ls, mine)).toEqual([`${mine}1`]);
    expect(runContainerNames("not json", mine)).toEqual([]);
    const images = JSON.stringify([
      { configuration: { name: "docker.io/library/achords-agent:aaa" } },
      { configuration: { name: "docker.io/library/achords-agent:bbb" } },
      { configuration: { name: "docker.io/library/alpine:3.20" } },
    ]);
    expect(staleImages(images, "achords-agent:bbb")).toEqual(["achords-agent:aaa"]);
  });

  it("reads the host address of the container network", () => {
    const inspect = JSON.stringify([
      { status: { ipv4Gateway: "192.168.64.1", ipv4Subnet: "192.168.64.0/24" } },
    ]);
    expect(parseNetwork(inspect)).toEqual({ gateway: "192.168.64.1", subnet: "192.168.64.0/24" });
    expect(parseNetwork("[]")).toBeUndefined();
    expect(parseNetwork(JSON.stringify([{ status: { ipv4Gateway: "x" } }]))).toBeUndefined();
  });

  it("checks addresses against the subnet", () => {
    expect(inSubnet("192.168.64.7", "192.168.64.0/24")).toBe(true);
    expect(inSubnet("::ffff:192.168.64.7", "192.168.64.0/24")).toBe(true);
    expect(inSubnet("192.168.65.7", "192.168.64.0/24")).toBe(false);
    expect(inSubnet("10.0.0.5", "192.168.64.0/24")).toBe(false);
    expect(inSubnet("fe80::1", "192.168.64.0/24")).toBe(false);
    expect(inSubnet("192.168.64.7", "garbage")).toBe(false);
  });
});
