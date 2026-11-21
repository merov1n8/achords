# ADR-0044: Subscription or API key per provider, through the official CLIs

Status: Accepted (2026-11-21)

- Context: ADR-0004 made subscription CLIs the default and promised an API-key mode. The owner uses Claude and OpenAI subscriptions today and wants to switch any provider (Claude, OpenAI, Google Gemini) to API billing later, or offer it to others.

- Decision:
  - API mode uses the **same official CLIs**, not own agent loops: the tool loop, permissions, MCP, publishing review and every other rule stay identical in both modes.
  - Per provider a setting (`billing.<provider>`: `subscription` | `api`, Settings → Model access). The key lives in the vault (`anthropic-api-key`, `openai-api-key`, `gemini-api-key`), is resolved per run (audited as `provider:<id>`) and given only to that run's CLI process.
  - Claude: `ANTHROPIC_API_KEY`; subscription runs have it removed from their environment so a stray key never bills. OpenAI (codex): an own provider entry (`model_providers.achords-openai`, `env_key = ACHORDS_OPENAI_API_KEY`, Responses API) selected per run, so the CLI's ChatGPT login is never touched; the variable is hidden from the agent's shell (`ACHORDS_*`). Gemini: `GEMINI_API_KEY` (see the cli-gemini ADR).
  - API mode without a key fails the run with a message pointing to Settings → Model access.

- Consequences: Switching billing is one click per provider and reversible without signing in again. API mode has not been run against real keys yet (none available); it is verified with fake CLIs and the providers' documented configuration.
