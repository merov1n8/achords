# ADR-0025: Orchestrator lives in the gateway; boss decides via structured output

Status: Accepted (2026-11-19)

- Context: ARCHITECTURE placed the orchestrator in `packages/core`, but it needs `policy` and `providers`, which build on `core`; keeping it there would create a package cycle. The boss also needs a reliable machine-readable decision.
- Decision: `packages/core` stays the data layer (threads, queue, runs, agents). The orchestrator (boss decisions, worker, seeding) lives in `apps/gateway/src/orchestrator`, the always-on process that runs it. The boss returns `{action: answer|ask|delegate, message, task?}` through the CLI's `--json-schema` structured output, generated from the zod schema that validates it. Sub-agent runs are built strictly from the manifest (model policy, tools, Bash only via allow-listed prefixes, fs roots as cwd/`--add-dir`, budget).
- Consequences: One process owns the worker loop; on shutdown it cancels the in-flight run so its process group dies with it. Delegation to agents not in the manifest set is refused. Verified end to end with the real CLI (vague request → clarifying question → delegation → web-dev run → Done).
