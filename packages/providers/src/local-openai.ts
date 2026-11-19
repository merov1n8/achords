import type { ModelProvider, RunRequest, RunResult, Usage } from "./types.ts";

export interface LocalOpenAIOptions {
  /** OpenAI-compatible endpoint. Ollama default; mlx-lm's server works the same way. */
  baseUrl?: string;
  /** How long the server keeps the model loaded after a request (Ollama), then frees RAM. */
  keepAlive?: string;
}

const zeroUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
});

/**
 * Local models over the OpenAI-compatible chat API (ADR-0006). Text only for now: a run that
 * needs tools is refused rather than run without them, so a manifest never silently loses rules.
 */
export function localOpenAI(opts: LocalOpenAIOptions = {}): ModelProvider {
  const base = opts.baseUrl ?? "http://127.0.0.1:11434/v1";
  const keepAlive = opts.keepAlive ?? "5m";
  return { id: "local", run: (req) => runOnce(base, keepAlive, req) };
}

async function runOnce(base: string, keepAlive: string, req: RunRequest): Promise<RunResult> {
  const started = Date.now();
  const fail = (stopReason: RunResult["stopReason"], error: string): RunResult => ({
    ok: false,
    stopReason,
    text: "",
    error,
    usage: zeroUsage(),
    windows: [],
    durationMs: Date.now() - started,
  });
  if (req.tools.length > 0) {
    return fail(
      "error",
      `local models do not support tools yet (requested: ${req.tools.join(", ")})`,
    );
  }

  const timeout = AbortSignal.timeout(req.timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  const messages = [
    ...(req.appendSystemPrompt ? [{ role: "system", content: req.appendSystemPrompt }] : []),
    { role: "user", content: req.prompt },
  ];

  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        messages,
        stream: false,
        keep_alive: keepAlive,
        ...(req.jsonSchema
          ? {
              response_format: {
                type: "json_schema",
                json_schema: { name: "result", schema: req.jsonSchema },
              },
            }
          : {}),
      }),
      signal,
    });
  } catch {
    if (req.signal?.aborted) return fail("cancelled", "cancelled");
    if (timeout.aborted) return fail("timeout", "timeout");
    return fail("error", `local model server not reachable at ${base} (is Ollama running?)`);
  }

  let body: {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string } | string;
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    if (req.signal?.aborted) return fail("cancelled", "cancelled");
    if (timeout.aborted) return fail("timeout", "timeout");
    return fail("error", `invalid response from local model server (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const msg = typeof body.error === "string" ? body.error : body.error?.message;
    return fail("error", `local model error (HTTP ${res.status}): ${msg ?? "unknown"}`);
  }

  const text = body.choices?.[0]?.message?.content ?? "";
  let structured: unknown;
  if (req.jsonSchema) {
    try {
      structured = JSON.parse(text);
    } catch {
      return fail("error", "local model did not return valid JSON for the requested schema");
    }
  }
  return {
    ok: true,
    stopReason: "completed",
    text,
    usage: {
      ...zeroUsage(),
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    },
    windows: [],
    ...(req.jsonSchema ? { structured } : {}),
    durationMs: Date.now() - started,
  };
}
