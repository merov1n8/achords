# ADR-0068: Billing per agent, and the subscription as fallback when the API budget is used up

Status: Accepted (2026-11-24). Amends ADR-0044 and ADR-0046.

- Context: Billing is chosen per provider (ADR-0044): every Claude run uses either the subscription or the API key. The owner now has a monthly API allowance beside the subscription and wants to put some agents on it, not all. When the allowance runs out, the work should go on with the subscription instead of waiting (ADR-0046 makes API work wait at 100 % of its budget).

- Decision:
  - **Per agent.** `agent.yaml` takes an optional `billing: api | subscription`. It overrides the provider's setting (Settings → Model access) for that agent's runs, whichever provider its model belongs to. Without it, the provider's setting applies as before. The boss follows its own manifest the same way. The key, the vault and the environment handling of ADR-0044 are unchanged: API mode without a key still fails the run with where to set it.
  - **Fallback.** Per provider, a setting `budget.<provider>.fallback` (Model access, beside the budget): "when the budget is used up, use the subscription". When it is on and a day or month budget of that provider is used up, a run that would bill the API runs on the subscription instead. It is recorded as a subscription run. API runs resume by themselves in the next period or after the owner raises the budget.
  - The owner is told once per period and budget, as before, but the text says that the subscription took over instead of "work waits".
  - With the fallback off, ADR-0046 is unchanged: API work waits.
  - The billing decision moves out of `gateway.ts` into `apps/gateway/src/billing.ts` so that it can be tested without a gateway.

- Consequences:
  - The owner can put chosen agents on an API allowance and keep the rest on the subscription.
  - With the fallback on, a budget caps API money without stopping work. The subscription windows then carry the rest, as they did before API mode.
  - The fallback reads Achords' own budget, not the provider's balance. If the provider refuses earlier (balance used up outside Achords), the run fails as before. The owner should set the month budget to at most the allowance.
