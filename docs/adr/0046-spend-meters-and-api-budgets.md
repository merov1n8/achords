# ADR-0046: Spend meters and API budgets

Status: Accepted (2026-11-21)

- Context: With API mode (ADR-0044) work costs money per run. The owner needs to see what it costs and cap it, without confusing that with the cost estimates subscription CLIs report.

- Decision:
  - Every run records who paid (`billing`: subscription | api) and its tokens. Cost is what the CLI reports (claude), otherwise tokens × an owner-edited price list `~/.achords/pricing.yaml` (USD per million tokens, input / output / cached). No price is guessed: unpriced runs show tokens only.
  - Usage page: today and this month by provider, agent or project; API money and subscription estimates in separate rows.
  - Budgets per provider and period (day, month; 0 = none), API runs only: at 80% one note per period; at 100% new API work on that provider waits (the task is deferred with the reason, the boss answers with it) until the next period or a higher budget. Running work is not interrupted.

- Consequences: Spending is visible per client project and capped per provider. Subscription work is never blocked by budgets; its windows stay on the usage meters (ADR-0026 era).
