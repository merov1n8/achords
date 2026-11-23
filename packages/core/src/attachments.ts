// Images the owner drops into a chat (web) or sends (Telegram): files under the achords home,
// one folder per chat. The message text carries a "[image: <path>]" line, so the boss, a direct
// @agent and the chat block of delegated work all see it; runs of that chat may read the folder.
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Db } from "./db/database.ts";
import { getSetting, setSetting } from "./settings.ts";

export const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
// Screenshots, not files: what a model can look at in one go. Larger files go in a folder.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_NAME = /^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/;

export const attachmentsDir = (home: string, threadId: string) =>
  join(home, "attachments", threadId);

/** Stores one image for a chat; returns its absolute path. Throws on a wrong type or size. */
export function saveImage(home: string, threadId: string, type: string, bytes: Buffer): string {
  const ext = IMAGE_TYPES[type.split(";")[0]?.trim().toLowerCase() ?? ""];
  if (!ext) throw new Error("only PNG, JPEG, WebP or GIF images");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("images up to 5 MB; put larger files in the project folder");
  }
  const dir = attachmentsDir(home, threadId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${randomUUID()}.${ext}`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

export const imageLine = (path: string) => `[image: ${path}]`;

/** The message text with its image lines after it. */
export const withImages = (text: string, paths: string[]) =>
  [text.trim(), paths.map(imageLine).join("\n")].filter(Boolean).join("\n\n");

// Chat images are kept this many days unless the owner sets otherwise; empty keeps them forever.
export const IMAGE_KEEP_KEY = "attachments.keep_days";
export const DEFAULT_KEEP_DAYS = 30;
const PRUNED_KEY = "attachments.pruned_on";

/** The retention in days, or undefined when images are kept forever. */
export function imageKeepDays(db: Db): number | undefined {
  const v = getSetting(db, IMAGE_KEEP_KEY);
  if (v === undefined) return DEFAULT_KEEP_DAYS;
  const n = Number(v);
  return v.trim() && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Deletes chat images older than `days` (by when they were stored) and empty chat folders. */
export function pruneImages(home: string, days: number, now = Date.now()): number {
  const root = join(home, "attachments");
  if (!existsSync(root)) return 0;
  const cutoff = now - days * 86_400_000;
  let removed = 0;
  for (const chat of readdirSync(root)) {
    const dir = join(root, chat);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (IMAGE_NAME.test(name) && statSync(path).mtimeMs < cutoff) {
        rmSync(path, { force: true });
        removed++;
      }
    }
    if (!readdirSync(dir).length) rmdirSync(dir);
  }
  return removed;
}

/** Once per local day (from midnight on): prunes by the owner's setting. Returns files removed. */
export function dailyImagePrune(db: Db, home: string, now = new Date()): number {
  const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  if (getSetting(db, PRUNED_KEY) === today) return 0;
  setSetting(db, PRUNED_KEY, today);
  const days = imageKeepDays(db);
  return days ? pruneImages(home, days, now.getTime()) : 0;
}
