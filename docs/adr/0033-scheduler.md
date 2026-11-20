# ADR-0033: Scheduler with cron rules in SQLite, run by the gateway tick

Status: Accepted (2026-11-20)

- Context: Recurring work (reports, checks, triage) must run without the owner asking each time, within the event-driven model (ADR-0005: no idle sessions) and with every run reporting a result.
- Decision:
  - Schedules live in SQLite: name, 5-field cron rule (minute hour day-of-month month day-of-week, `*`, lists, ranges, steps; classic day-of-month OR day-of-week), agent, task title and instructions, optional project, on/off. Times are the host's local time. The parser is ~100 lines in `packages/core` (no dependency).
  - The gateway tick turns due schedules into tasks through the normal delegation path (boss → agent), so policy, budget, sensitivity, projects and the kanban apply unchanged. Each schedule reports into its own chat thread ("Scheduled: <name>").
  - Missed runs (gateway down) are caught up once, not one by one; a schedule whose previous task is still queued or running skips that occurrence. A paused queue starts nothing.
  - Shipped schedules (`seed/schedules/*.yaml`) are inserted once by id, switched off, and never overwritten.
  - The web shows a list (toggle, delete), today's runs and a week view.
- Consequences: Zero idle cost; a schedule is just a task at a time. No seconds-level precision (tick granularity) and no time zones other than the host's.
