# ADR-0045: Google Gemini through the gemini CLI (stage 1)

Status: Accepted (2026-11-21), stage 1, **not run live yet**

- Context: The owner wants Google Gemini in both subscription and API mode (ADR-0044). No Gemini subscription or key is available yet, so nothing could be measured live as for codex (ADR-0040). Google states that for unpaid and Google One users the Gemini CLI is being replaced by the Antigravity CLI, which may change how subscription mode works.

- Decision (stage 1, conservative until measured):
  - Provider `cli-gemini`: `gemini -m <model> -o json --sandbox --skip-trust -p …`, the full prompt (role first) on stdin, answer and token counts read defensively from the JSON (both known stats layouts), quota/429 as `unavailable`.
  - Writing runs use `--approval-mode auto_edit` (edits only; shell commands are never approved headless, so they do not run); read-only runs use `plan`. The macOS seatbelt profile is `restrictive-closed`, or `restrictive-open` with owner-granted open web.
  - Gemini runs get no achords MCP tools and no integrations; the prompt says so. Structured answers: the schema goes into the prompt and the first JSON object is parsed.
  - Billing per ADR-0044: `GEMINI_API_KEY` from the vault in API mode, removed otherwise.
  - The gateway uses the gemini binary next to its Node when present (the service PATH may lack it).

- Consequences: Gemini can be chosen per agent once an account exists; the first live run decides stage 2 (read scope, MCP, settings isolation, or a switch to the Antigravity CLI).
