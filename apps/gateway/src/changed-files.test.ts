import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedFiles, isCode } from "./changed-files.ts";

describe("changedFiles", () => {
  let dir: string;
  const old = new Date("2026-01-01");
  const write = (rel: string, stale = false) => {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "x");
    if (stale) utimesSync(path, old, old);
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "achords-changed-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists files modified since the time, not older ones", () => {
    write("old.ts", true);
    const fresh = write("src/new.ts");
    expect(changedFiles([dir], old.getTime() + 1000)).toEqual([fresh]);
  });

  it("skips dependency and generated folders", () => {
    write("node_modules/x/index.js");
    write(".git/index");
    write("Library/cache.bin");
    expect(changedFiles([dir], 0)).toEqual([]);
  });

  it("walks a folder given twice (or nested) once", () => {
    const f = write("a/b.ts");
    expect(changedFiles([dir, dir, join(dir, "a")], 0)).toEqual([f]);
  });

  it("a missing folder has no changes", () => {
    expect(changedFiles([join(dir, "nope")], 0)).toEqual([]);
  });

  it("too many files to tell: undefined", () => {
    for (const n of [1, 2, 3]) write(`f${n}.ts`, true);
    expect(changedFiles([dir], Date.now(), 2)).toBeUndefined();
  });
});

describe("isCode", () => {
  it("documents and media are not code; anything else is", () => {
    for (const p of ["/a/summary.md", "/a/NOTES.TXT", "/a/shot.png", "/a/.DS_Store"]) {
      expect(isCode(p)).toBe(false);
    }
    for (const p of ["/a/app.ts", "/a/style.css", "/a/Makefile", "/a/data.json", "/a/x.cs"]) {
      expect(isCode(p)).toBe(true);
    }
  });
});
