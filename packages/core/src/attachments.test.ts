import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachmentsDir, IMAGE_NAME, saveImage, withImages } from "./attachments.ts";

describe("chat images", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-att-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("stores an image privately in the chat's folder under a random name", () => {
    const path = saveImage(home, "t1", "image/png", Buffer.from("PNG"));
    expect(path.startsWith(`${attachmentsDir(home, "t1")}/`)).toBe(true);
    expect(IMAGE_NAME.test(path.split("/").pop() as string)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("PNG");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses other types, empty and too large files", () => {
    expect(() => saveImage(home, "t1", "image/svg+xml", Buffer.from("<svg/>"))).toThrow(/PNG/);
    expect(() => saveImage(home, "t1", "image/png", Buffer.alloc(0))).toThrow(/5 MB/);
    expect(() => saveImage(home, "t1", "image/jpeg", Buffer.alloc(5 * 1024 * 1024 + 1))).toThrow(
      /5 MB/,
    );
  });

  it("puts image lines after the text", () => {
    expect(withImages("Nézd meg", ["/a/1.png", "/a/2.jpg"])).toBe(
      "Nézd meg\n\n[image: /a/1.png]\n[image: /a/2.jpg]",
    );
    expect(withImages("  ", ["/a/1.png"])).toBe("[image: /a/1.png]");
  });
});
