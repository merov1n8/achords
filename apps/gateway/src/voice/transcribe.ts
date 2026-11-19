import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export type TranscribeResult = { ok: true; text: string } | { ok: false; reason: string };

export interface Transcriber {
  available(): { ok: true } | { ok: false; reason: string };
  transcribe(audioPath: string): Promise<TranscribeResult>;
}

const run = (cmd: [string, ...string[]], args: string[], timeoutMs: number) =>
  new Promise<void>((resolve, reject) => {
    const [bin, ...lead] = cmd;
    execFile(bin, [...lead, ...args], { timeout: timeoutMs }, (err) =>
      err ? reject(err) : resolve(),
    );
  });

/**
 * Speech to text on this machine (ADR-0014): ffmpeg → 16 kHz mono WAV → whisper.cpp with
 * language auto-detection. Audio never leaves the host; intermediate files are removed.
 */
export function whisperTranscriber(opts: {
  model: string;
  workDir: string;
  ffmpeg?: [string, ...string[]];
  whisper?: [string, ...string[]];
  timeoutMs?: number;
}): Transcriber {
  const ffmpeg = opts.ffmpeg ?? ["ffmpeg"];
  const whisper = opts.whisper ?? ["whisper-cli"];
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  return {
    available: () =>
      existsSync(opts.model)
        ? { ok: true }
        : { ok: false, reason: `Whisper model not found at ${opts.model}` },

    async transcribe(audioPath) {
      mkdirSync(opts.workDir, { recursive: true, mode: 0o700 });
      const base = join(opts.workDir, `stt-${randomUUID()}`);
      try {
        try {
          await run(
            ffmpeg,
            [
              "-nostdin",
              "-y",
              "-loglevel",
              "error",
              "-i",
              audioPath,
              "-ar",
              "16000",
              "-ac",
              "1",
              "-c:a",
              "pcm_s16le",
              `${base}.wav`,
            ],
            timeoutMs,
          );
        } catch (err) {
          return { ok: false, reason: `ffmpeg failed: ${(err as Error).message.split("\n")[0]}` };
        }
        try {
          await run(
            whisper,
            [
              "-m",
              opts.model,
              "-f",
              `${base}.wav`,
              "-l",
              "auto",
              "-nt",
              "-np",
              "-otxt",
              "-of",
              base,
            ],
            timeoutMs,
          );
        } catch (err) {
          return { ok: false, reason: `whisper failed: ${(err as Error).message.split("\n")[0]}` };
        }
        const text = existsSync(`${base}.txt`)
          ? readFileSync(`${base}.txt`, "utf8").replace(/\s+/g, " ").trim()
          : "";
        return text ? { ok: true, text } : { ok: false, reason: "no speech recognised" };
      } finally {
        rmSync(`${base}.wav`, { force: true });
        rmSync(`${base}.txt`, { force: true });
      }
    },
  };
}
