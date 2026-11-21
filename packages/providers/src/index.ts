// Model adapters and usage meters.
export const PACKAGE_NAME = "@achords/providers";

export { buildArgs, type CliClaudeOptions, cliClaude } from "./cli-claude.ts";
export {
  type CliCodexOptions,
  CODEX_API_KEY_ENV,
  cliCodex,
  codexArgs,
  codexMcp,
  codexProfile,
} from "./cli-codex.ts";
export { type LocalOpenAIOptions, localOpenAI } from "./local-openai.ts";
export * from "./types.ts";
export { stubApiMeter, subscriptionMeter, type UsageMeter, type UsageSnapshot } from "./usage.ts";
