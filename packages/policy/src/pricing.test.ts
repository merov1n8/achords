import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { costOf, loadPricing } from "./pricing.ts";

describe("price list (Phase 4)", () => {
  it("prices tokens per million, cached input at its own rate; unknown models have no cost", () => {
    const dir = mkdtempSync(join(tmpdir(), "achords-pricing-"));
    expect(loadPricing(dir)).toEqual({});
    writeFileSync(
      join(dir, "pricing.yaml"),
      'models:\n  "cli-codex/gpt-x": { input: 2, output: 8, cached: 0.5 }\n',
    );
    const p = loadPricing(dir);
    expect(
      costOf(p, "cli-codex/gpt-x", {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 400_000,
      }),
    ).toBeCloseTo(0.6 * 2 + 0.4 * 0.5 + 0.5 * 8);
    expect(
      costOf(p, "cli-codex/other", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }),
    ).toBeNull();
    writeFileSync(join(dir, "pricing.yaml"), "models:\n  x: { input: -1, output: 1 }\n");
    expect(() => loadPricing(dir)).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});
