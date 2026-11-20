import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliCodex, codexArgs } from "./cli-codex.ts";
import type { RunRequest } from "./types.ts";

const FAKE = new URL("./fake-codex.test-helper.mjs", import.meta.url).pathname;

describe("cli-codex (ADR-0040)", () => {
  let dir: string;
  let record: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "achords-codex-test-"));
    record = join(dir, "record.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const req = (over: Partial<RunRequest> = {}): RunRequest => ({
    prompt: "say hello",
    model: "gpt-6-astra",
    cwd: dir,
    tools: ["Read"],
    allowedTools: [],
    timeoutMs: 10_000,
    ...over,
  });
  const provider = (mode = "ok") =>
    cliCodex({
      command: [process.execPath, FAKE],
      env: { FAKE_CODEX_MODE: mode, FAKE_CODEX_RECORD: record },
    });

  it("maps tools to a sandbox and keeps the web off unless granted", () => {
    const files = { last: "/t/last.txt" };
    const ro = codexArgs(req(), files);
    expect(ro).toEqual(expect.arrayContaining(["-s", "read-only", "--ignore-user-config"]));
    expect(ro).toContain("sandbox_workspace_write.network_access=false");
    const rw = codexArgs(
      req({ tools: ["Read", "Edit"], addDirs: ["/x"], allowedTools: ["WebFetch"] }),
      files,
    );
    expect(rw).toEqual(expect.arrayContaining(["-s", "workspace-write", "--add-dir", "/x"]));
    expect(rw).toContain("sandbox_workspace_write.network_access=true");
    expect(rw.at(-1)).toBe("-");
  });

  it("sends the prompt on stdin (role first) and returns the final message and usage", async () => {
    const r = await provider().run(req({ appendSystemPrompt: "You are a web dev." }));
    expect(r).toMatchObject({ ok: true, stopReason: "completed", text: "Done: hello" });
    expect(r.usage).toMatchObject({ inputTokens: 120, outputTokens: 7, cacheReadTokens: 20 });
    const rec = JSON.parse(readFileSync(record, "utf8"));
    expect(rec.stdin).toBe("You are a web dev.\n\n---\n\nsay hello");
    expect(rec.argv).not.toContain("say hello"); // never on argv
  });

  it("returns structured answers for a schema", async () => {
    const r = await provider("json").run(req({ jsonSchema: { type: "object" } }));
    expect(r.structured).toEqual({ action: "answer", message: "hi" });
  });

  it("treats a subscription limit as temporarily unavailable, and times out", async () => {
    const r = await provider("limit").run(req());
    expect(r).toMatchObject({ ok: false, stopReason: "unavailable" });
    expect(r.error).toMatch(/usage limit/);
    const slow = await provider("hang").run(req({ timeoutMs: 300 }));
    expect(slow.stopReason).toBe("timeout");
  });
});
