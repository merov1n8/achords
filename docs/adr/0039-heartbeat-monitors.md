# ADR-0039: Heartbeat monitors

Status: Accepted (2026-11-20)

- Context: ARCHITECTURE §4.10 and Phase 3 step 5: cheap periodic checks that stay quiet while nothing matters and tell the owner once when something does, without idle agent sessions (ADR-0005) or quota.

- Decision:
  - **Monitor** = SQLite row (`monitors`): name, kind, JSON config, interval in minutes (≥ 5), on/off, last state (`unknown | ok | alert`), last detail, `notified`.
  - **Checks run in the gateway tick**, one pass at a time, with no model and no agent run. Kinds: `site` (HTTP GET, alert on an error status or no answer within 15 s) and `stuck` (kanban cards in todo/in_progress/review not updated for N hours, default 48).
  - **Notify on change only.** The first check sets the baseline (it alerts only if it already finds a problem); after that only ok → alert and alert → ok are told, through the owner's notify path (Telegram thread, else the latest chat).
  - **Quiet hours** (`22-7`, local time): nothing is sent; changes wait and are told when the quiet hours end. A problem that is gone again before it was told is not told at all.
  - Web: Monitors page (list with state, on/off, delete, new monitor, quiet hours) and `/api/monitors`.

- Consequences: Site-down and stale-card alerts cost nothing. Checks that need judgement (new reviews, ad spend against a budget) come next as an `integration` kind: a catalog read call plus a local-model triage step (ADR-0006), still notify-on-change.
