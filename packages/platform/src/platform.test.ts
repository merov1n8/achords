import { describe, expect, it } from "vitest";
import { detectPlatform, recommendModels } from "./platform.ts";

describe("platform", () => {
  it("detects Apple Silicon and RAM", () => {
    expect(detectPlatform({ platform: "darwin", arch: "arm64", totalmem: 24 * 2 ** 30 })).toEqual({
      kind: "apple-silicon",
      ramGb: 24,
    });
    expect(detectPlatform({ platform: "linux", arch: "x64", totalmem: 16 * 2 ** 30 })).toEqual({
      kind: "generic",
      ramGb: 16,
    });
  });

  it("recommends a chat model that leaves room for the OS and agents, plus an embedding model", () => {
    expect(recommendModels(8).chat).toBe("qwen3:1.7b");
    expect(recommendModels(16).chat).toBe("qwen3:4b");
    expect(recommendModels(24).chat).toBe("qwen3:8b");
    expect(recommendModels(32).chat).toBe("qwen3:14b");
    expect(recommendModels(64).chat).toBe("qwen3:32b");
    expect(recommendModels(24).embedding).toBe("nomic-embed-text");
  });
});
