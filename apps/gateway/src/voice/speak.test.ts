import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { macSpeaker } from "./speak.ts";

const FAKE = new URL("./fake-tools.test-helper.mjs", import.meta.url).pathname;

describe("read-aloud on this Mac", () => {
  let dir: string;
  let log: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "achords-tts-"));
    log = join(dir, "argv.log");
    process.env.FAKE_TOOL_LOG = log;
    delete process.env.FAKE_SAY_FAIL;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const speaker = () =>
    macSpeaker({
      workDir: join(dir, "work"),
      say: [process.execPath, FAKE],
      ffmpeg: [process.execPath, FAKE],
    });
  const argv = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);

  it("Hungarian text: Tünde, markdown out, OGG/Opus out, temporary files removed", async () => {
    const out = await speaker().speak("**Kész:** a commit elkészült, pusht nem csináltam.");
    if (!out.ok) throw new Error(out.reason);
    expect(readFileSync(out.path, "utf8")).toBe("Kész: a commit elkészült, pusht nem csináltam.");
    const [sayArgs, ffmpegArgs] = argv();
    expect(sayArgs?.slice(0, 2)).toEqual(["-v", "Tünde"]);
    expect(ffmpegArgs).toEqual(expect.arrayContaining(["-c:a", "libopus"]));
    expect(ffmpegArgs?.at(-1)).toBe(out.path);
    expect(readdirSync(join(dir, "work"))).toEqual([out.path.split("/").pop()]);
  });

  it("other languages use the system voice; a failure says why and leaves nothing", async () => {
    const out = await speaker().speak("Done: the commit is on the audit branch.");
    expect(out.ok).toBe(true);
    expect(argv()[0]?.[0]).toBe("-f");
    process.env.FAKE_SAY_FAIL = "1";
    const failed = await speaker().speak("Hello again");
    expect(failed).toMatchObject({ ok: false, reason: expect.stringMatching(/^say failed/) });
    expect(readdirSync(join(dir, "work")).filter((f) => !f.endsWith(".ogg"))).toEqual([]);
    expect(await speaker().speak("```\ncode only\n```")).toEqual({
      ok: false,
      reason: "nothing to read",
    });
    expect(existsSync(log)).toBe(true);
  });
});
