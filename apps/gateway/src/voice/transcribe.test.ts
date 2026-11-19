import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { whisperTranscriber } from "./transcribe.ts";

const FAKE = new URL("./fake-tools.test-helper.mjs", import.meta.url).pathname;

describe("local Whisper transcriber", () => {
  let dir: string;
  let log: string;
  let model: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "achords-voice-"));
    log = join(dir, "argv.log");
    model = join(dir, "ggml-model.bin");
    writeFileSync(model, "model");
    process.env.FAKE_TOOL_LOG = log;
    delete process.env.FAKE_WHISPER_FAIL;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const t = () =>
    whisperTranscriber({
      model,
      workDir: join(dir, "work"),
      ffmpeg: [process.execPath, FAKE],
      whisper: [process.execPath, FAKE],
    });

  it("converts to 16 kHz mono WAV, transcribes locally with language auto-detect, cleans up", async () => {
    const audio = join(dir, "note.oga");
    writeFileSync(audio, "ogg-bytes");
    expect(await t().transcribe(audio)).toEqual({
      ok: true,
      text: "Szia, csinálj egy TODO listát.",
    });
    const [ffmpegArgs, whisperArgs] = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(ffmpegArgs).toEqual(
      expect.arrayContaining(["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"]),
    );
    expect(whisperArgs).toEqual(
      expect.arrayContaining(["-m", model, "-l", "auto", "-nt", "-otxt"]),
    );
    // No intermediate files left behind.
    expect(readdirSync(join(dir, "work"))).toEqual([]);
  });

  it("reports failures and empty results instead of passing garbage on", async () => {
    const audio = join(dir, "note.oga");
    writeFileSync(audio, "x");
    process.env.FAKE_WHISPER_FAIL = "1";
    expect(await t().transcribe(audio)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/whisper/),
    });
    delete process.env.FAKE_WHISPER_FAIL;
    process.env.FAKE_WHISPER_TEXT = "   \n";
    expect(await t().transcribe(audio)).toEqual({ ok: false, reason: "no speech recognised" });
    delete process.env.FAKE_WHISPER_TEXT;
  });

  it("is unavailable without the model file", () => {
    const missing = whisperTranscriber({ model: join(dir, "nope.bin"), workDir: dir });
    expect(missing.available()).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/model/),
    });
    expect(t().available()).toEqual({ ok: true });
    expect(existsSync(model)).toBe(true);
  });
});
