import { describe, expect, it } from "vitest";
import { gitPushArgs, pushDeletes } from "./check.ts";
import { gitCredentialTarget, gitPushEnv, gitTokenId, pushGuardHook, pushRefusal } from "./git.ts";
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
const req = { protocol: "https", host: "github.com", path: "acme/site.git" };

describe("git credential target (ADR-0067 level 5)", () => {
  it("answers a level 5 work-mode run for its project's https repository", () => {
    expect(gitCredentialTarget(work, lab, req)).toEqual({
      ok: true,
      vaultId: "git-token-lab",
      purpose: "git:lab:github.com/acme/site",
    });
    expect(
      gitCredentialTarget(work, lab, { ...req, host: "GitHub.com", path: "/acme/site/" }),
    ).toMatchObject({ ok: true });
  });

  it("refuses below level 5, in web mode, other hosts and paths, and ssh remotes", () => {
    const refused = (r: ReturnType<typeof gitCredentialTarget>) => expect(r.ok).toBe(false);
    refused(gitCredentialTarget({ level: 4, mode: "accounts" }, lab, req));
    refused(gitCredentialTarget({ level: 5, mode: "web" }, lab, req));
    refused(gitCredentialTarget({ level: 5 }, lab, req));
    refused(gitCredentialTarget(work, lab, { ...req, host: "gitlab.com" }));
    refused(gitCredentialTarget(work, lab, { ...req, path: "acme/other" }));
    refused(gitCredentialTarget(work, lab, { ...req, path: "acme/site/../other" }));
    refused(gitCredentialTarget(work, lab, { ...req, protocol: "http" }));
    refused(gitCredentialTarget(work, lab, { ...req, path: "acme/ssh-only" }));
    refused(gitCredentialTarget(work, lab, {}));
  });

  it("refuses a live repository of a secured (or unclassified) project, not a staging one", () => {
    const secured = { ...lab, class: undefined };
    expect(gitCredentialTarget(work, secured, req)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/secured/),
    });
    const staging = {
      ...secured,
      integrationEntries: repos({ value: "https://github.com/acme/site", env: "staging" }),
    };
    expect(gitCredentialTarget(work, staging, req)).toMatchObject({ ok: true });
  });

  it("names the vault id per project, `own` included, within the vault's 64 characters", () => {
    expect(gitTokenId("own")).toBe("git-token-own");
    expect(gitTokenId("a".repeat(64)).length).toBeLessThanOrEqual(64);
  });
});

describe("push guard (ADR-0067 level 5)", () => {
  it("finds pushes and remote deletions in a command line", () => {
    expect(gitPushArgs("git status && git -C /r push origin main")).toEqual([["origin", "main"]]);
    expect(gitPushArgs('git commit -m "push it"')).toEqual([]);
    for (const cmd of [
      "git push origin --delete old",
      "git push -d origin old",
      "git push origin :old",
      "git push --prune origin",
    ]) {
      expect(pushDeletes(cmd), cmd).toBe(true);
    }
    expect(pushDeletes("git push origin main:main")).toBe(false);
  });

  it("refuses force and mirror always, deletions unless approved exactly", () => {
    expect(pushRefusal("git push origin main", [])).toBeUndefined();
    expect(pushRefusal("git push --force origin main", ["git push --force origin main"])).toMatch(
      /force push/,
    );
    expect(pushRefusal("git push --mirror backup", [])).toMatch(/force push/);
    expect(pushRefusal("git push origin --delete old", [])).toMatch(/asks the owner/);
    expect(pushRefusal("git push origin :old", [])).toMatch(/asks the owner/);
    expect(pushRefusal("git push  origin --delete old", ["git push origin --delete old"])).toBe(
      undefined,
    );
    expect(pushRefusal("git push origin --delete other", ["git push origin --delete old"])).toMatch(
      /asks the owner/,
    );
  });

  it("runs as a Bash hook with the approved commands as its argument", () => {
    const hook = pushGuardHook({ node: "/n/node", entry: "/r/guard.ts", approved: ["a b"] });
    expect(hook.matcher).toBe("Bash");
    const command = hook.hooks[0]?.command ?? "";
    expect(command).toMatch(/^'\/n\/node' --disable-warning=ExperimentalWarning '\/r\/guard.ts' /);
    const arg = command.split(" ").at(-1) as string;
    expect(JSON.parse(Buffer.from(arg, "base64url").toString())).toEqual(["a b"]);
  });
});

describe("git configuration from the environment only", () => {
  it("empties the helper list, then sets the gateway's helper with the repository path", () => {
    const env = gitPushEnv({ node: "/n/node", helper: "/r/h.ts", hubUrl: "http://h", token: "t" });
    expect(env).toEqual({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "!'/n/node' --disable-warning=ExperimentalWarning '/r/h.ts' ",
      GIT_CONFIG_KEY_2: "credential.useHttpPath",
      GIT_CONFIG_VALUE_2: "true",
      GIT_TERMINAL_PROMPT: "0",
      ACHORDS_HUB_URL: "http://h",
      ACHORDS_GIT_TOKEN: "t",
    });
  });
});
