import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isHungarian, speakable } from "@achords/i18n";

export type SpeakResult = { ok: true; path: string } | { ok: false; reason: string };

export interface Speaker {
  /** An OGG/Opus voice note of the text; the caller removes the file. */
  speak(text: string): Promise<SpeakResult>;
}

// Longer replies are cut here: a voice note of more than a few minutes is not listened to.
export const MAX_SPOKEN = 6000;

const run = (cmd: [string, ...string[]], args: string[], timeoutMs: number) =>
  new Promise<void>((resolve, reject) => {
    const [bin, ...lead] = cmd;
    execFile(bin, [...lead, ...args], { timeout: timeoutMs }, (err) =>
      err ? reject(err) : resolve(),
    );
  });

/**
 * Text to speech on this Mac: macOS `say` (Hungarian text with the Tünde voice) → AIFF → ffmpeg
 * → OGG/Opus, the format Telegram plays as a voice note. Nothing leaves the host.
 */
export function macSpeaker(opts: {
  workDir: string;
  say?: [string, ...string[]];
  ffmpeg?: [string, ...string[]];
  hungarianVoice?: string;
  timeoutMs?: number;
}): Speaker {
  const say = opts.say ?? ["say"];
  const ffmpeg = opts.ffmpeg ?? ["ffmpeg"];
  const timeoutMs = opts.timeoutMs ?? 3 * 60_000;
  return {
    async speak(text) {
      const spoken = speakable(text).slice(0, MAX_SPOKEN);
      if (!spoken) return { ok: false, reason: "nothing to read" };
      mkdirSync(opts.workDir, { recursive: true, mode: 0o700 });
      const base = join(opts.workDir, `tts-${randomUUID()}`);
      try {
        writeFileSync(`${base}.txt`, spoken, { mode: 0o600 });
        const voice = isHungarian(spoken) ? ["-v", opts.hungarianVoice ?? "Tünde"] : [];
        try {
          await run(say, [...voice, "-f", `${base}.txt`, "-o", `${base}.aiff`], timeoutMs);
        } catch (err) {
          return { ok: false, reason: `say failed: ${(err as Error).message.split("\n")[0]}` };
        }
        try {
          await run(
            ffmpeg,
            [
              "-nostdin",
              "-y",
              "-loglevel",
              "error",
              "-i",
              `${base}.aiff`,
              "-c:a",
              "libopus",
              "-b:a",
              "32k",
              `${base}.ogg`,
            ],
            timeoutMs,
          );
        } catch (err) {
          return { ok: false, reason: `ffmpeg failed: ${(err as Error).message.split("\n")[0]}` };
        }
        return existsSync(`${base}.ogg`)
          ? { ok: true, path: `${base}.ogg` }
          : { ok: false, reason: "no audio produced" };
      } finally {
        rmSync(`${base}.txt`, { force: true });
        rmSync(`${base}.aiff`, { force: true });
      }
    },
  };
}
