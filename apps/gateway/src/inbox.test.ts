// ADR-0069: the inbox folder and the hook script the CLIs run.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dropInbox,
  HOOK_CHARS,
  HOOK_SCRIPT,
  hookCommand,
  hookOutput,
  NOTE_CHARS,
  putNote,
  takeNotes,
  takenNotes,
} from "./inbox.ts";

describe("inbox (ADR-0069)", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), "achords-inbox-")), "task-1");
  });
  afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

  it("hands notes over once, in order, and tells the gateway which", () => {
    putNote(dir, 12, "second");
    putNote(dir, 3, "first");
    expect(takeNotes(dir)).toEqual(["first", "second"]);
    expect(takeNotes(dir)).toEqual([]);
    expect(takenNotes(dir)).toEqual([3, 12]);
    expect(takenNotes(dir)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("cuts long notes and leaves the rest for the next hook", () => {
    putNote(dir, 1, "a".repeat(NOTE_CHARS + 50));
    putNote(dir, 2, "b".repeat(NOTE_CHARS));
    putNote(dir, 3, "c".repeat(NOTE_CHARS));
    const first = takeNotes(dir);
    expect(first[0]).toHaveLength(NOTE_CHARS + 1);
    expect(first.join("").length).toBeLessThanOrEqual(HOOK_CHARS);
    expect(first).toHaveLength(2);
    expect(takeNotes(dir)).toEqual(["c".repeat(NOTE_CHARS)]);
  });

  it("an empty or missing inbox gives nothing", () => {
    expect(takeNotes(dir)).toEqual([]);
    expect(takenNotes(dir)).toEqual([]);
    expect(hookOutput("post", [])).toBe("");
    dropInbox(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("the hook script prints what each CLI expects", () => {
    putNote(dir, 1, "Use the main branch.");
    const run = (mode: string) =>
      execFileSync(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", HOOK_SCRIPT, dir, mode],
        { input: '{"hook_event_name":"x"}', encoding: "utf8" },
      );
    expect(JSON.parse(run("post"))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "Use the main branch.",
      },
    });
    expect(run("stop")).toBe(""); // nothing left: the agent may stop
    putNote(dir, 2, "One more thing.");
    expect(JSON.parse(run("stop"))).toEqual({ decision: "block", reason: "One more thing." });
    expect(takenNotes(dir)).toEqual([1, 2]);
  });

  it("quotes paths for the shell", () => {
    expect(hookCommand("/usr/bin/node", "/x/it's here", "stop")).toBe(
      `'/usr/bin/node' --disable-warning=ExperimentalWarning '${HOOK_SCRIPT}' '/x/it'\\''s here' stop`,
    );
  });
});
