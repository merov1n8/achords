import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliCodex, codexArgs, codexMcp } from "./cli-codex.ts";
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

  const host = {
    home: "/Users/o",
    codexPackages: "/Users/o/.codex/packages",
    path: ["/Users/o/.local/bin", "/usr/bin"],
  };
  const fsOf = (args: string[]) =>
    args.find((a) => a.startsWith("permissions.achords.filesystem="));

  it("denies the home folder except the run's own folders, PATH tools and codex (ADR-0040)", () => {
    const files = { last: "/t/last.txt" };
    const ro = codexArgs(
      req({
        cwd: "/Users/o/ws",
        allowedTools: ["Read(//Users/o/ws/**)", "Read(//Users/o/docs/**)"],
      }),
      files,
      host,
    );
    expect(ro).not.toContain("-s"); // -s would override the profile
    expect(fsOf(ro)).toBe(
      'permissions.achords.filesystem={ "/" = "read", "/Users/o" = "deny", "/Users/o/.local/bin" = "read", "/Users/o/.codex/packages" = "read", "/Users/o/ws" = "read", "/Users/o/docs" = "read" }',
    );
    expect(ro).toContain("permissions.achords.network.enabled=false");
    expect(ro).toContain('shell_environment_policy.exclude=["ACHORDS_*"]');
    const rw = codexArgs(
      req({
        cwd: "/Users/o/ws",
        tools: ["Read", "Edit"],
        allowedTools: ["Edit(//Users/o/ws/**)", "WebFetch"],
      }),
      files,
      host,
    );
    expect(fsOf(rw)).toContain('"/Users/o/ws" = "write"');
    expect(rw).toContain("permissions.achords.network.enabled=true");
    expect(rw.at(-1)).toBe("-");
  });

  it("passes MCP servers with secrets off the command line and only granted tools", () => {
    const cfg = join(dir, "mcp.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        mcpServers: {
          achords: {
            command: "node",
            args: ["hub.ts"],
            env: {
              ACHORDS_HUB_URL: "http://h",
              ACHORDS_RUN_TOKEN: "rt",
              ACHORDS_TOOLS: "ask_owner",
            },
          },
          blender: {
            command: "node",
            args: ["launch.ts"],
            env: { ACHORDS_HUB_URL: "http://h", ACHORDS_MCP_TICKET: "tk" },
          },
        },
      }),
    );
    const { args, env } = codexMcp(
      req({
        mcpConfigPath: cfg,
        allowedTools: ["mcp__achords__ask_owner", "mcp__blender__get_scene_info"],
      }),
    );
    expect(env).toEqual({ ACHORDS_RUN_TOKEN_ACHORDS: "rt", ACHORDS_MCP_TICKET_BLENDER: "tk" });
    expect(args.join(" ")).not.toMatch(/\brt\b|\btk\b/);
    expect(args[1]).toBe(
      'mcp_servers.achords={ "command" = "node", "args" = ["hub.ts"], "env" = { "ACHORDS_HUB_URL" = "http://h", "ACHORDS_RUN_TOKEN_VAR" = "ACHORDS_RUN_TOKEN_ACHORDS", "ACHORDS_TOOLS" = "ask_owner" }, "env_vars" = ["ACHORDS_RUN_TOKEN_ACHORDS"], "enabled_tools" = ["ask_owner"], "default_tools_approval_mode" = "approve" }',
    );
    expect(args[3]).toContain('"enabled_tools" = ["get_scene_info"]');
    // Every forwarded name is hidden from the agent's shell, not only ACHORDS_*.
    const all = codexArgs(req(), { last: "/t/l" }, host, { args, env: { PROBE_TOKEN_X: "v" } });
    expect(all).toContain('shell_environment_policy.exclude=["ACHORDS_*", "PROBE_TOKEN_X"]');
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

  it("API mode adds its own provider entry reading the key from the environment (Phase 4)", () => {
    const sub = codexArgs(req(), { last: "/t/l" }, host);
    expect(sub.join(" ")).not.toContain("model_provider");
    const api = codexArgs(req({ billing: "api" }), { last: "/t/l" }, host);
    expect(api).toContain('model_provider="achords-openai"');
    expect(api.find((a) => a.startsWith("model_providers."))).toBe(
      'model_providers.achords-openai={ "name" = "OpenAI API (achords)", "base_url" = "https://api.openai.com/v1", "env_key" = "ACHORDS_OPENAI_API_KEY", "wire_api" = "responses" }',
    );
  });
});
