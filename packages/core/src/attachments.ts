// Images the owner drops into a chat (web) or sends (Telegram): files under the achords home,
// one folder per chat. The message text carries a "[image: <path>]" line, so the boss, a direct
// @agent and the chat block of delegated work all see it; runs of that chat may read the folder.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
