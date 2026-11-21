import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliGemini, geminiArgs, geminiUsage } from "./cli-gemini.ts";
import type { RunRequest } from "./types.ts";

const FAKE = new URL("./fake-gemini.test-helper.mjs", import.meta.url).pathname;

describe("cli-gemini (ADR-0045, stage 1)", () => {
  let dir: string;
  let record: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "achords-gemini-test-"));
    record = join(dir, "record.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const req = (over: Partial<RunRequest> = {}): RunRequest => ({
    prompt: "say hello",
    model: "gemini-x",
    cwd: dir,
    tools: ["Read"],
    allowedTools: [],
    timeoutMs: 10_000,
    ...over,
  });
  const provider = (mode = "ok", env: Record<string, string> = {}) =>
    cliGemini({
      command: [process.execPath, FAKE],
      env: { FAKE_GEMINI_MODE: mode, FAKE_GEMINI_RECORD: record, ...env },
    });

  it("read-only runs plan, writing runs auto-edit; always sandboxed, never shell", () => {
    expect(geminiArgs(req())).toEqual(
      expect.arrayContaining(["--approval-mode", "plan", "--sandbox"]),
    );
    expect(geminiArgs(req({ tools: ["Read", "Edit"], addDirs: ["/x"] }))).toEqual(
      expect.arrayContaining(["--approval-mode", "auto_edit", "--include-directories", "/x"]),
    );
    expect(geminiArgs(req({ tools: ["Bash"] }))).toContain("plan"); // Bash alone writes nothing here
  });

  it("prompt on stdin, answer and tokens from the JSON, network closed by default", async () => {
    const r = await provider().run(req({ appendSystemPrompt: "Role." }));
    expect(r).toMatchObject({ ok: true, text: "Done: hello" });
    expect(r.usage).toMatchObject({ inputTokens: 100, outputTokens: 9, cacheReadTokens: 40 });
    const rec = JSON.parse(readFileSync(record, "utf8"));
    expect(rec.stdin).toBe("Role.\n\n---\n\nsay hello");
    expect(rec.seatbelt).toBe("restrictive-closed");
    await provider().run(req({ allowedTools: ["WebFetch"] }));
    expect(JSON.parse(readFileSync(record, "utf8")).seatbelt).toBe("restrictive-open");
  });

  it("API key only in API mode; schema answers parsed; quota is unavailable", async () => {
    await provider("ok", { GEMINI_API_KEY: "stray" }).run(req());
    expect(JSON.parse(readFileSync(record, "utf8")).apiKey).toBeNull();
    await provider().run(req({ billing: "api", env: { GEMINI_API_KEY: "g-key" } }));
    expect(JSON.parse(readFileSync(record, "utf8")).apiKey).toBe("g-key");
    const s = await provider("json").run(req({ jsonSchema: { type: "object" } }));
    expect(s.structured).toEqual({ action: "answer", message: "hi" });
    const q = await provider("quota").run(req());
    expect(q).toMatchObject({ ok: false, stopReason: "unavailable" });
    expect((await provider("hang").run(req({ timeoutMs: 300 }))).stopReason).toBe("timeout");
  });

  it("reads both stats layouts", () => {
    expect(geminiUsage({ inputTokens: 3, outputTokens: 2 })).toMatchObject({
      inputTokens: 3,
      outputTokens: 2,
    });
  });
});
