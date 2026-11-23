import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachmentsDir,
  dailyImagePrune,
  IMAGE_KEEP_KEY,
  IMAGE_NAME,
  imageKeepDays,
  pruneImages,
  saveImage,
  withImages,
} from "./attachments.ts";
import { openCoreDatabase } from "./db/database.ts";
import { setSetting } from "./settings.ts";

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

describe("chat image retention", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-prune-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const DAY = 86_400_000;
  const aged = (thread: string, days: number) => {
    const p = saveImage(home, thread, "image/png", Buffer.from("x"));
    const t = (Date.now() - days * DAY) / 1000;
    utimesSync(p, t, t);
    return p;
  };

  it("removes images older than the limit and chat folders left empty; nothing else", () => {
    const old = aged("t1", 31);
    const fresh = aged("t1", 2);
    const lone = aged("t2", 40);
    const other = join(attachmentsDir(home, "t1"), "notes.txt");
    writeFileSync(other, "keep");
    expect(pruneImages(home, 30)).toBe(2);
    expect([existsSync(old), existsSync(fresh), existsSync(other)]).toEqual([false, true, true]);
    expect(existsSync(lone)).toBe(false);
    expect(existsSync(attachmentsDir(home, "t2"))).toBe(false);
  });

  it("30 days by default, the owner's number, empty means never; once per day", () => {
    const db = openCoreDatabase(join(home, "core.db"));
    expect(imageKeepDays(db)).toBe(30);
    const old = aged("t1", 10);
    setSetting(db, IMAGE_KEEP_KEY, "7");
    const day = new Date(2026, 10, 24, 0, 0, 5);
    expect(dailyImagePrune(db, home, new Date(Date.now()))).toBe(1);
    expect(existsSync(old)).toBe(false);
    const again = aged("t1", 10);
    expect(dailyImagePrune(db, home, new Date(Date.now()))).toBe(0); // already ran today
    setSetting(db, IMAGE_KEEP_KEY, "");
    expect(imageKeepDays(db)).toBeUndefined();
    expect(dailyImagePrune(db, home, day)).toBe(0);
    expect(existsSync(again)).toBe(true);
    db.close();
  });
});
