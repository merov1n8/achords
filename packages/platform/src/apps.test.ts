import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { macApps } from "./apps.ts";

describe("apps on this Mac (ADR-0054)", () => {
  const recorder = (out: Record<string, string | Error> = {}) => {
    const calls: [string, string[]][] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      const r = out[cmd];
      if (r instanceof Error) throw r;
      return r ?? "";
    };
    return { calls, run };
  };

  it("finds a running app by its exact process name", async () => {
    const r = recorder({ "/usr/bin/pgrep": "4242\n4243\n" });
    expect(await macApps(r.run).pid("Blender")).toBe(4242);
    expect(r.calls).toEqual([["/usr/bin/pgrep", ["-x", "Blender"]]]);
    expect(await macApps(recorder({ "/usr/bin/pgrep": new Error("1") }).run).pid("X")).toBe(
      undefined,
    );
  });

  it("opens with the given arguments and quits by name as an argument, not as script", async () => {
    const r = recorder();
    const apps = macApps(r.run);
    await apps.open(["-g", "-a", "Blender"]);
    await apps.quit('Evil" to do shell script "x');
    expect(r.calls[0]).toEqual(["/usr/bin/open", ["-g", "-a", "Blender"]]);
    expect(r.calls[1]?.[0]).toBe("/usr/bin/osascript");
    expect(r.calls[1]?.[1].at(-1)).toBe('Evil" to do shell script "x');
    expect(r.calls[1]?.[1].slice(0, -1).join(" ")).not.toContain("Evil");
  });

  it("checks a local port", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    expect(await macApps().listening(port)).toBe(true);
    await new Promise((r) => server.close(r));
    expect(await macApps().listening(port)).toBe(false);
  });
});
