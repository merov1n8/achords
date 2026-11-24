import { describe, expect, it } from "vitest";
import {
  alwaysAskCommand,
  applyGrants,
  deletesOutside,
  inFolders,
  keyFolder,
  refusedCommand,
} from "./approvals.ts";
import { parseManifest } from "./manifest.ts";

const ctx = { achordsHome: "/Users/o/.achords", userHome: "/Users/o" };

describe("approvals (ADR-0067 step 4)", () => {
  it("applies folders, integrations and the highest level granted", () => {
    const m = parseManifest(
      "id: a\nname: a\nrole: a\nworkspace: shared\nmodels:\n  default: cli-claude/sonnet\nlevel: 1\nmcp: [ga4]\nfs:\n  write: [/w]\n",
      "agent.yaml",
    );
    const out = applyGrants(m, [
      { kind: "folder", folders: ["/srv/x", "/w"] },
      { kind: "integration", id: "meta" },
      { kind: "integration", id: "ga4" },
      { kind: "level", level: 3 },
      { kind: "level", level: 2 },
    ]);
    expect(out.manifest.fs.write).toEqual(["/w", "/srv/x"]);
    expect(out.manifest.mcp).toEqual(["ga4", "meta"]);
    expect(out.level).toBe(3);
    expect(applyGrants(m, []).level).toBeUndefined();
  });

  it("refuses force push and history rewrite, and push below a push run", () => {
    expect(refusedCommand("git push --force origin main")).toMatch(/force push/);
    expect(refusedCommand("git push --force origin main", { push: true })).toMatch(/force push/);
    expect(refusedCommand("git filter-repo --path x")).toMatch(/rewrites history/);
    expect(refusedCommand("git push origin main")).toMatch(/level 5 in work mode/);
    expect(refusedCommand("git push origin --delete old", { push: true })).toBeUndefined();
    expect(refusedCommand("git status")).toBeUndefined();
  });

  it("approved pushes change no field", () => {
    const m = parseManifest(
      "id: a\nname: a\nrole: a\nworkspace: shared\nmodels:\n  default: cli-claude/sonnet\nlevel: 5\n",
      "agent.yaml",
    );
    const out = applyGrants(m, [{ kind: "push", command: "git push origin :old" }]);
    expect(out).toEqual({ manifest: m });
  });

  it("knows the always-ask items among commands and folders", () => {
    const folders = ["/Users/o/work"];
    expect(deletesOutside("rm -rf /Users/o/work/build", folders, ctx.userHome)).toEqual([]);
    expect(deletesOutside("rm -rf /srv/old ~/tmp", folders, ctx.userHome)).toEqual([
      "/srv/old",
      "/Users/o/tmp",
    ]);
    expect(alwaysAskCommand("rm -rf /srv/old", { folders, ...ctx })).toMatch(/deleting/);
    expect(alwaysAskCommand("chmod 600 x", { folders, ...ctx })).toMatch(/permissions/);
    expect(alwaysAskCommand("cat ~/.ssh/id_ed25519", { folders, ...ctx })).toMatch(/keys/);
    expect(alwaysAskCommand("security find-generic-password", { folders, ...ctx })).toMatch(/keys/);
    expect(alwaysAskCommand("make test", { folders, ...ctx })).toBeUndefined();
    expect(alwaysAskCommand("git push origin --delete old", { folders, ...ctx })).toMatch(
      /deleting on the remote/,
    );
    expect(alwaysAskCommand("git push origin :old", { folders, ...ctx })).toMatch(/remote/);
    expect(keyFolder("/Users/o/.achords/vault", ctx)).toBe(true);
    // A folder that contains key folders counts as well.
    expect(keyFolder("/Users/o", ctx)).toBe(true);
    expect(keyFolder("/srv/assets", ctx)).toBe(false);
    expect(inFolders("~/work/a", folders, ctx.userHome)).toBe(true);
    expect(inFolders("/Users/o/workshop", folders, ctx.userHome)).toBe(false);
  });
});
