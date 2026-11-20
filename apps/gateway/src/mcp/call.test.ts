import { describe, expect, it } from "vitest";
import { callTool } from "./call.ts";

// A minimal MCP server: answers initialize, then echoes the tool call (or fails it).
const SERVER = `require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }));
  if (m.method === 'tools/call') console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {
    content: [{ type: 'text', text: m.params.name + ' ' + JSON.stringify(m.params.arguments) }],
    isError: m.params.name === 'broken' } }));
});`;
const spec = { command: process.execPath, args: ["-e", SERVER], env: {} };

describe("callTool (ADR-0037)", () => {
  it("runs exactly one call with the given arguments", async () => {
    expect(await callTool(spec, "create_draft", { title: "Hi" })).toEqual({
      ok: true,
      text: 'create_draft {"title":"Hi"}',
    });
  });

  it("reports tool errors, a dead server and a timeout", async () => {
    expect((await callTool(spec, "broken", {})).ok).toBe(false);
    expect(
      await callTool(
        { command: process.execPath, args: ["-e", "process.exit(4)"], env: {} },
        "x",
        {},
      ),
    ).toEqual({ ok: false, text: "server exited (4)" });
    const silent = {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: {},
    };
    expect(await callTool(silent, "x", {}, 200)).toEqual({ ok: false, text: "timed out" });
  });
});
