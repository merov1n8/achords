# ADR-0058: The next allowed model takes over at a usage limit

Status: Accepted (2026-11-23)

- Context: A subscription CLI that hits its usage limit (codex "usage limit", claude "hit your limit") ended the run as `unavailable`, and the task waited a minute and tried the same model again until the limit reset. Agents often allow several models (e.g. `cli-codex/gpt-6.2-astra` and `cli-codex/gpt-6.2-sol`), and the owner wants the work to go on with the next one. ADR-0007's "no fallback" is about sensitivity: local-only work never moves to a cloud model; that stays.

- Decision:
  - A cloud model that reports its usage limit is marked unusable for one hour (setting `model_out:<provider/model>`). Normal-sensitivity runs take the first model of `models.default`, then `models.allowed`, that is not marked and that the policy allows; with all of them marked, the default.
  - The task that hit the limit is queued again at once on the next usable model, and the chat gets a line saying which model reached its limit and which one continues. With no usable model left it waits as before (one minute, then retries).
  - The boss's run at a limit fails with a short message; the owner's next message starts on its next allowed model.
  - Local models are never marked: a local server that is down is waited for (ADR-0007), and local-only work never leaves the local model.
  - The claude provider now reports a usage-limit result as `unavailable` (codex and Gemini already did).

- Consequences: A limit costs one short failed run per hour per model instead of stalling the work. Results may differ between models; the chat says when the model changed. After an hour the default model is tried again, so a limit that lasts longer costs one more failed run each hour.
