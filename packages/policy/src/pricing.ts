import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// Phase 4: price list for CLIs that report tokens but no cost (codex, gemini). Owner-edited
// `~/.achords/pricing.yaml`, USD per million tokens; nothing is guessed: no price, no cost.
const price = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cached: z.number().nonnegative().optional(),
  })
  .strict();
const pricingSchema = z.object({ models: z.record(z.string(), price).default({}) }).strict();

export type Pricing = z.infer<typeof pricingSchema>["models"];

export function loadPricing(home: string): Pricing {
  const path = join(home, "pricing.yaml");
  if (!existsSync(path)) return {};
  return pricingSchema.parse(parseYaml(readFileSync(path, "utf8")) ?? {}).models;
}

/** Cost of one run from its tokens, or null when the model has no price. */
export function costOf(
  pricing: Pricing,
  model: string,
  tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number },
): number | null {
  const p = pricing[model];
  if (!p) return null;
  const cached = Math.min(tokens.cacheReadTokens, tokens.inputTokens);
  const fresh = tokens.inputTokens - cached;
  return (
    (fresh * p.input + cached * (p.cached ?? p.input) + tokens.outputTokens * p.output) / 1_000_000
  );
}
