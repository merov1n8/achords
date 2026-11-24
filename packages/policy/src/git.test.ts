import { describe, expect, it } from "vitest";
import { gitPushArgs } from "./check.ts";
import { GIT_SHELL_ENV, gitTokenId, pushTarget, validBranch } from "./git.ts";
import type { AccountEntry } from "./projects.ts";

const repos = (...list: AccountEntry[]) => ({ repository: list });
const lab = {
  slug: "lab",
  class: "experimental" as const,
  integrationEntries: repos(
    { value: "https://github.com/acme/site", env: "live" },
    { value: "git@github.com:acme/ssh-only", env: "live" },
  ),
};
const work = { level: 5, mode: "accounts" as const };

describe("push_branch target (ADR-0067 level 5)", () => {
  it("pushes a level 5 work-mode run's branch to its project's https repository", () => {
    expect(pushTarget(work, lab, "fix/login")).toEqual({
      ok: true,
      url: "https://github.com/acme/site",
      vaultId: "git-token-lab",
      purpose: "git-push:lab:github.com/acme/site:fix/login",
    });
    expect(pushTarget(work, lab, "main", "https://GitHub.com/acme/site.git/")).toMatchObject({
      ok: true,
    });
  });

  it("refuses below level 5, in web mode, other repositories and ssh-only projects", () => {
    const refused = (r: ReturnType<typeof pushTarget>) => expect(r.ok).toBe(false);
    refused(pushTarget({ level: 4, mode: "accounts" }, lab, "main"));
    refused(pushTarget({ level: 5, mode: "web" }, lab, "main"));
    refused(pushTarget({ level: 5 }, lab, "main"));
    refused(pushTarget(work, lab, "main", "https://gitlab.com/acme/site"));
    refused(pushTarget(work, lab, "main", "https://github.com/acme/other"));
    refused(pushTarget(work, lab, "main", "git@github.com:acme/ssh-only"));
    refused(pushTarget(work, lab, "main", "https://x-access-token:t@github.com/acme/site"));
    refused(
      pushTarget(
        work,
        { ...lab, integrationEntries: repos(lab.integrationEntries.repository[1] as AccountEntry) },
        "main",
      ),
    );
  });

  it("with several repositories remote_url names one", () => {
    const two = {
      ...lab,
      integrationEntries: repos(
        { value: "https://github.com/acme/site", env: "staging" },
        { value: "https://github.com/acme/docs", env: "staging" },
      ),
    };
    expect(pushTarget(work, two, "main")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/remote_url/),
    });
    expect(pushTarget(work, two, "main", "https://github.com/acme/docs")).toMatchObject({
      ok: true,
      url: "https://github.com/acme/docs",
    });
  });

  it("refuses a live repository of a secured (or unclassified) project, not a staging one", () => {
    const secured = { ...lab, class: undefined };
    expect(pushTarget(work, secured, "main")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/secured/),
    });
    const staging = {
      ...secured,
      integrationEntries: repos({ value: "https://github.com/acme/site", env: "staging" }),
    };
    expect(pushTarget(work, staging, "main")).toMatchObject({ ok: true });
  });

  it("accepts only plain branch names", () => {
    for (const ok of ["main", "fix/login", "release-1.2", "a_b/c.d"])
      expect(validBranch(ok), ok).toBe(true);
    for (const bad of [
      "+main",
      "main:main",
      ":main",
      "-f",
      "--delete",
      "a..b",
      "a b",
      "a/.hidden",
      "a.lock",
      "a/",
      "/a",
      "a//b",
      "HEAD",
      "a@{1}",
      "refs/heads/../x",
      "",
      "x".repeat(201),
    ]) {
      expect(validBranch(bad), bad).toBe(false);
      expect(pushTarget(work, lab, bad).ok, bad).toBe(false);
    }
  });

  it("names the vault id per project, `own` included, within the vault's 64 characters", () => {
    expect(gitTokenId("own")).toBe("git-token-own");
    expect(gitTokenId("a".repeat(64)).length).toBeLessThanOrEqual(64);
  });
});

describe("git in every shell (ADR-0067)", () => {
  it("empties git's helper list and never prompts or reaches an ssh-agent", () => {
    expect(GIT_SHELL_ENV).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/usr/bin/false",
      SSH_ASKPASS: "/usr/bin/false",
      GCM_INTERACTIVE: "never",
      SSH_AUTH_SOCK: "/dev/null",
    });
  });

  it("finds a push in a command line, past git's own options", () => {
    expect(gitPushArgs("git status && git -C /r push origin main")).toEqual([["origin", "main"]]);
    expect(gitPushArgs('git commit -m "push it"')).toEqual([]);
  });
});
