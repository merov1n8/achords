import { getSetting, openCoreDatabase, setSetting } from "@achords/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTO_KEY,
  checkForUpdate,
  githubRepo,
  LAST_KEY,
  PENDING_KEY,
  READY_KEY,
  reportAfterRestart,
  UPDATE_EXIT,
  type UpdaterDeps,
  updateTick,
} from "./updater.ts";

describe("auto-update from main", () => {
  let db: ReturnType<typeof openCoreDatabase>;
  let calls: string[];
  let told: string[];
  let exited: number | undefined;
  let git: Record<string, { code?: number; out?: string }>;
  let failStep: string | undefined;
  let checks: { status: string; conclusion: string | null }[];
  let idle: boolean;

  const deps = (): UpdaterDeps => ({
    db,
    repo: "/repo",
    pnpm: "/node/bin/pnpm",
    node: "/node/bin/node",
    exec: async (cmd, args) => {
      const line = `${cmd.split("/").at(-1)} ${args.filter((a) => a !== "-C" && a !== "/repo" && a !== "--dir").join(" ")}`;
      calls.push(line);
      if (failStep && line.includes(failStep)) return { code: 1, out: "boom" };
      const key = Object.keys(git).find((k) => line.startsWith(k));
      return { code: key ? (git[key]?.code ?? 0) : 0, out: key ? (git[key]?.out ?? "") : "" };
    },
    fetchJson: async () => ({ check_runs: checks }),
    isIdle: () => idle,
    notify: (t) => told.push(t),
    exit: (code) => {
      exited = code;
    },
    now: () => 1000,
  });

  beforeEach(() => {
    db = openCoreDatabase(":memory:");
    calls = [];
    told = [];
    exited = undefined;
    failStep = undefined;
    idle = true;
    checks = [{ status: "completed", conclusion: "success" }];
    git = {
      "git symbolic-ref": { out: "main" },
      "git status": { out: "" },
      "git rev-parse HEAD": { out: "aaa1111" },
      "git rev-parse origin/main": { out: "bbb2222" },
      "git remote get-url": { out: "git@github.com:merov1n8/achords.git" },
      "git log": { out: "feat: one\nfix: two" },
    };
  });
  afterEach(() => db.close());

  it("finds a green fast-forward and applies it when idle: pull, install, build, self-test, restart", async () => {
    expect(await checkForUpdate(deps())).toEqual({
      status: "available",
      sha: "bbb2222",
      summary: "feat: one\nfix: two",
    });
    await updateTick(deps());
    expect(calls).toEqual(
      expect.arrayContaining([
        "git merge --ff-only --quiet bbb2222",
        "pnpm install --frozen-lockfile",
        "pnpm build",
        expect.stringMatching(/^node .*main\.ts --self-test$/),
      ]),
    );
    expect(exited).toBe(UPDATE_EXIT);
    expect(JSON.parse(getSetting(db, PENDING_KEY) ?? "{}")).toMatchObject({
      prev: "aaa1111",
      next: "bbb2222",
    });
    // The new code reports what changed.
    reportAfterRestart(deps());
    expect(told[0]).toBe("✅ achords updated to bbb2222:\n- feat: one\n- fix: two");
    expect(getSetting(db, PENDING_KEY)).toBe("");
  });

  it("waits while work runs, and does nothing when switched off", async () => {
    idle = false;
    await updateTick(deps());
    expect(exited).toBeUndefined();
    expect(getSetting(db, READY_KEY)).toContain("bbb2222");
    setSetting(db, AUTO_KEY, "0");
    idle = true;
    await updateTick(deps());
    expect(exited).toBeUndefined();
  });

  it("stays put on local changes, another branch, a running or failed CI", async () => {
    git["git status"] = { out: " M apps/x.ts" };
    expect(await checkForUpdate(deps())).toMatchObject({
      status: "blocked",
      reason: /local changes/,
    });
    git["git status"] = { out: "" };
    git["git symbolic-ref"] = { out: "feature/x" };
    expect(await checkForUpdate(deps())).toMatchObject({ status: "blocked", reason: /feature\/x/ });
    git["git symbolic-ref"] = { out: "main" };
    checks = [{ status: "in_progress", conclusion: null }];
    expect(await checkForUpdate(deps())).toMatchObject({ status: "waiting" });
    checks = [{ status: "completed", conclusion: "failure" }];
    expect(await checkForUpdate(deps())).toMatchObject({ status: "blocked", reason: /CI failed/ });
    git["git merge-base"] = { code: 1 };
    checks = [{ status: "completed", conclusion: "success" }];
    expect(await checkForUpdate(deps())).toMatchObject({
      status: "blocked",
      reason: /fast-forward/,
    });
  });

  it("a failed build rolls back to the previous commit and tells the owner", async () => {
    failStep = "pnpm build";
    await updateTick(deps());
    expect(exited).toBeUndefined();
    expect(calls).toContain("git reset --hard --quiet aaa1111");
    expect(told[0]).toMatch(/update to bbb2222 failed at "pnpm build"; stayed on aaa1111/);
    expect(JSON.parse(getSetting(db, LAST_KEY) ?? "{}")).toMatchObject({ ok: false });
  });

  it("reads owner/repo from GitHub remotes", () => {
    expect(githubRepo("git@github.com:merov1n8/achords.git")).toBe("merov1n8/achords");
    expect(githubRepo("https://github.com/a/b")).toBe("a/b");
    expect(githubRepo("https://gitlab.com/a/b")).toBeUndefined();
  });

  it("restarts into a checkout that moved ahead of the running code (pulled by hand)", async () => {
    git["git rev-parse origin/main"] = { out: "aaa1111" }; // remote = HEAD
    git["git log"] = { out: "feat: pulled" };
    const d = { ...deps(), running: "0000000" };
    expect(await checkForUpdate(d)).toEqual({
      status: "available",
      sha: "aaa1111",
      summary: "feat: pulled",
    });
    expect(await checkForUpdate(deps())).toEqual({ status: "current", sha: "aaa1111" });
    await updateTick(d);
    expect(exited).toBe(UPDATE_EXIT);
  });
});
