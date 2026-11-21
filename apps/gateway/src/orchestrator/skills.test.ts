import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendMessage,
  createThread,
  getTask,
  listMessages,
  openCoreDatabase,
  setSetting,
} from "@achords/core";
import { deleteSkill, listSkills, readSkill, writeSkill } from "@achords/policy";
import type { ModelProvider, RunRequest } from "@achords/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunTokens } from "../mcp/tokens.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { seedSkills } from "./seed.ts";
import {
  changedLines,
  createSkillFlow,
  type SkillCaller,
  skillModeKey,
  skillProposals,
} from "./skills.ts";

const SEED_SKILLS = new URL("../../../../seed/skills/", import.meta.url).pathname;

describe("skill flow (ADR-0049)", () => {
  let home: string;
  let dir: string;
  let db: ReturnType<typeof openCoreDatabase>;
  let threadId: string;
  let caller: SkillCaller;
  const flow = (fetched = "# Report\nWrite plainly.") =>
    createSkillFlow({
      db,
      dir,
      redact: (s) => s.replaceAll("sk-SECRET", "[redacted]"),
      fetchSource: async (url) => ({ url, text: fetched }),
    });
  const req = {
    name: "owner-report",
    description: "How to write the final report for the owner",
    body: "Write plain sentences.\nNo JSON.",
    reason: "the owner corrected the last report",
  };
  const lastMessage = () => listMessages(db, threadId).at(-1);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-skillflow-"));
    dir = join(home, "skills");
    db = openCoreDatabase(join(home, "core.db"));
    threadId = createThread(db, {}).id;
    caller = {
      agentId: "web-dev",
      workspace: "web-clients",
      taskId: "t1",
      threadId,
      openWeb: false,
    };
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("lists visible skills in the prompt and reads the full text only on request", () => {
    writeSkill(dir, {
      workspace: "shared",
      name: "seo",
      description: "SEO basics",
      enabled: true,
      body: "Use titles.",
    });
    writeSkill(dir, {
      workspace: "games",
      name: "unity",
      description: "Unity",
      enabled: true,
      body: "x",
    });
    const f = flow();
    const block = f.promptBlock("web-clients");
    expect(block).toContain("- seo: SEO basics");
    expect(block).not.toContain("unity");
    expect(block).not.toContain("Use titles.");
    expect(block).toContain("skill_propose");
    expect(f.read("web-clients", "seo")).toEqual({
      ok: true,
      text: 'Skill "seo" (owner-approved instructions):\n\nUse titles.',
    });
    expect(f.read("web-clients", "unity")).toEqual({ ok: false, reason: "no skill unity" });
    expect(f.read("web-clients", "../games/unity")).toMatchObject({ ok: false });
  });

  it("review mode: a new skill waits for Approve, then is written once", () => {
    const f = flow();
    expect(f.propose(caller, { ...req, body: "Use sk-SECRET never" })).toMatchObject({ ok: true });
    expect(readSkill(dir, "web-clients", "owner-report")).toBeUndefined();
    const msg = lastMessage();
    expect(msg?.content).toContain('web-dev proposes a new skill "owner-report" for web-clients');
    expect(msg?.content).toContain("[redacted]");
    expect(msg?.content).not.toContain("{");
    const id = (msg?.actions?.[0]?.data ?? "").split(":")[2] as string;
    expect(msg?.actions?.map((a) => a.data)).toEqual([`skill:approve:${id}`, `skill:reject:${id}`]);
    expect(skillProposals(db)).toHaveLength(1);
    expect(f.decide(id, true)).toEqual({ ok: true, message: "Saved: skill owner-report." });
    expect(readSkill(dir, "web-clients", "owner-report")?.body).toBe("Use [redacted] never");
    expect(lastMessage()?.actions ?? undefined).toBeUndefined();
    expect(f.decide(id, true).ok).toBe(false);
    expect(skillProposals(db)).toEqual([]);
  });

  it("auto mode applies a new skill at once, but not from a run that reads the open web", () => {
    setSetting(db, skillModeKey("web-clients"), "auto");
    const f = flow();
    expect(f.propose(caller, req)).toMatchObject({
      ok: true,
      text: expect.stringMatching(/^Saved/),
    });
    expect(readSkill(dir, "web-clients", "owner-report")?.description).toBe(req.description);
    expect(lastMessage()?.content).toContain('web-dev added the skill "owner-report"');
    expect(lastMessage()?.actions ?? undefined).toBeUndefined();

    f.propose({ ...caller, openWeb: true }, { ...req, name: "web-thing" });
    expect(readSkill(dir, "web-clients", "web-thing")).toBeUndefined();
    expect(skillProposals(db).map((p) => p.name)).toEqual(["web-thing"]);
  });

  it("a change always goes to review and shows the changed lines; a stale one is refused", () => {
    setSetting(db, skillModeKey("web-clients"), "auto");
    writeSkill(dir, {
      workspace: "shared",
      name: "owner-report",
      description: "Old",
      enabled: false,
      body: "Intro\nOld line\nEnd",
    });
    const f = flow();
    // Same name without `replaces` is still a change, never an overwrite.
    f.propose(caller, { ...req, body: "Intro\nNew line\nEnd" });
    const msg = lastMessage();
    expect(msg?.content).toContain('proposes a change to the skill "owner-report" (shared)');
    expect(msg?.content).toContain("Before:\nOld line\n\nAfter:\nNew line");
    expect(msg?.content).toContain("Description: Old → How to write");
    const id = skillProposals(db)[0]?.id as string;
    expect(f.decide(id, true).ok).toBe(true);
    const saved = readSkill(dir, "shared", "owner-report");
    expect(saved?.body).toBe("Intro\nNew line\nEnd");
    expect(saved?.enabled).toBe(false);

    f.propose(caller, { ...req, replaces: "owner-report", body: "v3" });
    const stale = skillProposals(db)[0]?.id as string;
    writeSkill(dir, { ...(saved as NonNullable<typeof saved>), body: "edited by the owner" });
    expect(f.decide(stale, true)).toEqual({
      ok: false,
      message: "Not changed: the skill owner-report was edited since this proposal; ask again.",
    });
    expect(f.decide(stale, false)).toEqual({ ok: true, message: "Rejected: skill owner-report." });
    expect(readSkill(dir, "shared", "owner-report")?.body).toBe("edited by the owner");
  });

  it("a patch may rename, never onto another existing skill", () => {
    writeSkill(dir, {
      workspace: "web-clients",
      name: "a",
      description: "A",
      enabled: true,
      body: "a",
    });
    writeSkill(dir, {
      workspace: "web-clients",
      name: "b",
      description: "B",
      enabled: true,
      body: "b",
    });
    const f = flow();
    expect(f.propose(caller, { ...req, name: "b", replaces: "a" })).toEqual({
      ok: false,
      reason: "a skill named b already exists",
    });
    expect(f.propose(caller, { ...req, replaces: "missing" })).toMatchObject({ ok: false });
    expect(f.propose(caller, { ...req, name: "Bad Name" })).toMatchObject({ ok: false });
    f.propose(caller, { ...req, name: "c", replaces: "a" });
    expect(f.decide(skillProposals(db)[0]?.id as string, true).ok).toBe(true);
    expect(readSkill(dir, "web-clients", "a")).toBeUndefined();
    expect(readSkill(dir, "web-clients", "c")?.body).toBe(req.body);
  });

  it("an import from a link the owner wrote in the thread is built in directly", () => {
    appendMessage(db, {
      threadId,
      role: "user",
      channel: "web",
      content: "found a good skill, build it in: https://example.com/skills/report.md.",
    });
    const f = flow();
    f.propose(caller, { ...req, sourceUrl: "https://example.com/skills/report.md" });
    expect(readSkill(dir, "web-clients", "owner-report")?.source).toBe(
      "https://example.com/skills/report.md",
    );
    expect(lastMessage()?.content).toContain("from the link you sent");

    // A link the owner never wrote (e.g. found by the agent) goes to review.
    f.propose(caller, { ...req, name: "other", sourceUrl: "https://example.com/other.md" });
    expect(readSkill(dir, "web-clients", "other")).toBeUndefined();
    // A link the agent wrote itself does not count either.
    appendMessage(db, {
      threadId,
      role: "agent",
      author: "web-dev",
      channel: "system",
      content: "https://example.com/third.md",
    });
    f.propose(caller, { ...req, name: "third", sourceUrl: "https://example.com/third.md" });
    expect(readSkill(dir, "web-clients", "third")).toBeUndefined();
    // Owner's link, but it would replace an existing skill: review.
    f.propose(caller, { ...req, sourceUrl: "https://example.com/skills/report.md", body: "new" });
    expect(skillProposals(db).map((p) => p.name)).toEqual(["other", "third", "owner-report"]);
  });

  it("fetch returns the page with the closest existing skills", async () => {
    writeSkill(dir, {
      workspace: "web-clients",
      name: "owner-report",
      description: "Final report for the owner",
      enabled: true,
      body: "x",
    });
    const out = await flow("A better way to write the final report").fetch(
      "web-clients",
      "https://example.com/r.md",
    );
    expect(out).toMatchObject({ ok: true, untrusted: "example.com" });
    if (!out.ok) return;
    expect(out.text).toContain("- owner-report: Final report for the owner");
    expect(out.text).toContain('source_url "https://example.com/r.md"');
    expect(out.text).toContain("A better way to write the final report");
  });

  it("shows only the lines that differ", () => {
    expect(changedLines("a\nb\nc", "a\nB\nc")).toEqual({ before: ["b"], after: ["B"] });
    expect(changedLines("", "1\n2\n3", 2).after).toEqual(["1", "2", "… and 1 more lines"]);
  });

  it("seeds shipped skills once: never over a local edit, not again after a delete", () => {
    expect(seedSkills(SEED_SKILLS, dir, db)).toEqual([
      "shared/check-before-done",
      "shared/owner-report",
    ]);
    expect(listSkills(dir).every((s) => s.description && s.body && s.enabled)).toBe(true);
    writeFileSync(join(dir, "shared", "owner-report.md"), "local edit");
    deleteSkill(dir, "shared", "check-before-done");
    expect(seedSkills(SEED_SKILLS, dir, db)).toEqual([]);
    expect(readSkill(dir, "shared", "owner-report")?.body).toBe("local edit");
    expect(readSkill(dir, "shared", "check-before-done")).toBeUndefined();
  });
});

describe("skills in agent runs (ADR-0049)", () => {
  let home: string;
  let db: ReturnType<typeof openCoreDatabase>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-skillrun-"));
    for (const [id, tools] of [
      ["boss", "[]"],
      ["dev", "[Read]"],
      ["researcher", "[WebFetch]"],
    ]) {
      mkdirSync(join(home, "agents", id as string), { recursive: true });
      writeFileSync(
        join(home, "agents", id as string, "agent.yaml"),
        `id: ${id}\nname: ${id}\nrole: ${id}\nworkspace: web\nmodels:\n  default: cli-claude/sonnet\ntools: ${tools}\n`,
      );
    }
    db = openCoreDatabase(join(home, "core.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("every hub run gets the skill tools and the index; proposals come from the task's agent", async () => {
    writeSkill(join(home, "skills"), {
      workspace: "shared",
      name: "owner-report",
      description: "Report plainly",
      enabled: true,
      body: "secret-free body",
    });
    const seen: RunRequest[] = [];
    const provider: ModelProvider = {
      id: "cli-claude",
      async run(req) {
        seen.push(req);
        return {
          ok: true,
          stopReason: "completed",
          text: "done",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
          },
          windows: [],
          durationMs: 1,
        };
      },
    };
    const orch = createOrchestrator({
      db,
      home,
      providers: { "cli-claude": provider },
      hub: { url: "http://127.0.0.1:1", tokens: createRunTokens(), serverEntry: "/x.ts" },
    });
    orch.syncAgents();
    setSetting(db, skillModeKey("web"), "auto");
    const thread = createThread(db, {});
    const dev = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: "dev", title: "t", instructions: "x" },
    );
    const web = orch.delegate(
      { from: "boss", threadId: thread.id },
      { agent: "researcher", title: "t", instructions: "x" },
    );
    if (!dev.ok || !web.ok) throw new Error("delegate failed");
    await orch.workOnce();
    expect(seen[0]?.allowedTools).toEqual(
      expect.arrayContaining([
        "mcp__achords__skill_read",
        "mcp__achords__skill_fetch",
        "mcp__achords__skill_propose",
      ]),
    );
    expect(seen[0]?.appendSystemPrompt).toContain("- owner-report: Report plainly");
    expect(seen[0]?.appendSystemPrompt).not.toContain("secret-free body");

    const from = (taskId: string) => ({ from: "task" as const, taskId });
    expect(orch.skillRead(from(dev.taskId), "owner-report")).toMatchObject({ ok: true });
    const draft = {
      name: "deploy-check",
      description: "Check a deploy",
      body: "Open the site.",
      reason: "r",
    };
    // Auto mode in workspace web: saved at once for dev, review for the agent with the open web.
    expect(orch.skillPropose(from(dev.taskId), draft)).toMatchObject({
      ok: true,
      text: expect.stringMatching(/^Saved/),
    });
    orch.skillPropose(from(web.taskId), { ...draft, name: "web-tip" });
    const id = skillProposals(db)[0]?.id as string;
    expect(orch.runAction(`skill:approve:${id}`)).toEqual({
      ok: true,
      message: "Saved: skill web-tip.",
    });
    expect(readSkill(join(home, "skills"), "web", "web-tip")?.body).toBe("Open the site.");
    expect(getTask(db, dev.taskId)?.status).toBe("done");
  });
});
