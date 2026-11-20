import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalog } from "./index.ts";

// Every literal t("key") in the CLI and the gateway must exist in the English catalog
// (the web has its own check, which also lists its dynamic keys).
const root = new URL("../../../", import.meta.url).pathname;
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );

describe("catalog coverage", () => {
  it("has every key the CLI and the gateway use", () => {
    const used = new Set<string>();
    for (const file of [
      ...sources(join(root, "apps/cli/src")),
      ...sources(join(root, "apps/gateway/src")),
    ]) {
      for (const m of readFileSync(file, "utf8").matchAll(/\bt\("([\w.]+)"/g))
        used.add(m[1] as string);
    }
    expect([...used].filter((k) => !(k in catalog))).toEqual([]);
    expect([...used].filter((k) => k.startsWith("cli.")).length).toBeGreaterThan(100);
  });
});
