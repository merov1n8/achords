import { describe, expect, it } from "vitest";
import { isHungarian, speakable } from "./speech.ts";

describe("read-aloud text", () => {
  it("drops markdown marks, code blocks and link targets", () => {
    expect(
      speakable(
        "**Kész:** a `f832ab2` commit.\n\n- Push: [GitHub](https://github.com/x)\n```sh\ngit push\n```\n## Vége",
      ),
    ).toBe("Kész: a f832ab2 commit.\n\nPush: GitHub\n \nVége");
  });

  it("tells Hungarian from English", () => {
    expect(isHungarian("A commit elkészült, pusht nem csináltam.")).toBe(true);
    expect(isHungarian("Ez egy rövid válasz és nincs benne hosszú ékezet")).toBe(true);
    expect(isHungarian("Done: the commit is on the audit branch.")).toBe(false);
    expect(isHungarian("Café olé, señor")).toBe(false);
  });
});
